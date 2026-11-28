import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, run } from './sql.js';
import { markDirty } from '../backup/sync-ledger.js';

/** Device-local evidence, independent of previews and transient upload errors. */
export function migrateOriginalAvailability(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE photos ADD COLUMN original_failure TEXT
      CHECK (original_failure IS NULL OR original_failure = 'missing-original');
    DROP INDEX idx_photos_unavailable;
    CREATE INDEX idx_photos_unavailable ON photos (id)
      WHERE preview_failure IS NOT NULL OR preview_missing = 1 OR dimension_status = 'unavailable' OR original_failure IS NOT NULL;
  `);
}

export class OriginalAvailabilityRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** Verified loss or remote recovery pairs absence evidence with ledger repair. */
  repair(photoId: string, status: 'offloaded' | 'error'): void {
    this.db.transaction(() => {
      run(this.db, 'UPDATE photos SET original_failure = ? WHERE id = ?', status === 'error' ? 'missing-original' : null, photoId);
      run(this.db, 'UPDATE sync_ledger SET status = ? WHERE photo_id = ?', status, photoId);
    })();
  }

  /** Integrity has authenticated remote custody; a bound legacy row may already
   * be offloaded while still carrying earlier local absence evidence. */
  verifiedRemote(photoId: string): boolean {
    return this.db.transaction(() => {
      const row = queryGet<{ id: string }>(
        this.db,
        `SELECT p.id FROM photos p JOIN sync_ledger l ON l.photo_id = p.id
         WHERE p.id = ? AND l.status IN ('error', 'offloaded')
           AND (l.status = 'error' OR p.original_failure IS NOT NULL)`,
        photoId,
      );
      if (row === undefined) return false;
      this.repair(photoId, 'offloaded');
      return true;
    })();
  }

  /** Call only after authenticated, content-address-verified publication. A file
   * existing, or a preview decoding, is not evidence that the original returned. */
  verifiedRestored(contentHash: string): readonly string[] {
    return queryAll<{ id: string }>(
      this.db,
      `UPDATE photos SET original_failure = NULL, local_custody_failure = NULL, local_custody_fingerprint = NULL,
         local_custody_verified_at = NULL WHERE content_hash = @contentHash
         AND (original_failure IS NOT NULL OR local_custody_failure IS NOT NULL) RETURNING id`,
      { contentHash },
    ).map((row) => row.id);
  }

  /** A matching local file restores local custody, without claiming a remote
   * backup or re-including a deliberately excluded photo. */
  recoveredLocal(contentHash: string, keyId: number): readonly string[] {
    return this.db.transaction(() => {
      run(
        this.db,
        `INSERT OR IGNORE INTO retained_photo_keys (photo_id, key_id)
        SELECT id, key_id FROM photos WHERE content_hash = ? AND key_id != ?`,
        contentHash,
        keyId,
      );
      const ids = queryAll<{ id: string }>(
        this.db,
        `UPDATE photos SET original_failure = NULL, local_custody_failure = NULL, local_custody_fingerprint = NULL,
           local_custody_verified_at = NULL, key_id = @keyId WHERE content_hash = @contentHash RETURNING id`,
        { contentHash, keyId },
      ).map((row) => row.id);
      for (const id of ids) {
        // Trash remains restorable only while its prior remote-custody status
        // survives. Recovering a live sibling must not unpublish that record.
        run(
          this.db,
          `UPDATE sync_ledger SET status = 'local', custody_authority_id = NULL
          WHERE photo_id = ? AND EXISTS (SELECT 1 FROM photos WHERE id = ? AND deleted_at IS NULL)`,
          id,
          id,
        );
        markDirty(this.db, id);
      }
      return ids;
    })();
  }
}

/** Publish only after the evidence and ledger transaction has committed. */
export function createIntegrityAvailabilityNotifications(
  db: BetterSqlite3.Database,
  changed: (event: { photoIds: string[]; membership: 'library' }) => void,
  syncChanged: (photoId: string, status: 'error' | 'offloaded') => void,
  bindLegacyPhoto?: (photoId: string, authorityId: number) => boolean,
): {
  markUnrecoverable: (photoId: string) => void;
  markVerified: (photoId: string) => void;
  bindLegacyPhoto?: (photoId: string, authorityId: number) => boolean;
} {
  const availability = new OriginalAvailabilityRepository(db);
  const notify = (photoId: string, status: 'error' | 'offloaded'): void => {
    syncChanged(photoId, status);
    changed({ photoIds: [photoId], membership: 'library' });
  };
  return {
    ...(bindLegacyPhoto === undefined
      ? {}
      : {
          bindLegacyPhoto: (photoId: string, authorityId: number): boolean => {
            const bound = db.transaction(() => {
              if (!bindLegacyPhoto(photoId, authorityId)) return false;
              availability.verifiedRemote(photoId);
              return true;
            })();
            if (bound) notify(photoId, 'offloaded');
            return bound;
          },
        }),
    markUnrecoverable: (photoId) => {
      availability.repair(photoId, 'error');
      notify(photoId, 'error');
    },
    markVerified: (photoId) => {
      if (availability.verifiedRemote(photoId)) notify(photoId, 'offloaded');
    },
  };
}

/** Composition callback for successful authenticated original publication. */
export function createOriginalRecoveryNotification(
  db: BetterSqlite3.Database,
  changed: (event: { photoIds: string[]; membership: 'library' }) => void,
): (contentHash: string) => void {
  const availability = new OriginalAvailabilityRepository(db);
  return (hash) => {
    const photoIds = availability.verifiedRestored(hash);
    if (photoIds.length > 0) changed({ photoIds: [...photoIds], membership: 'library' });
  };
}
