import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { LocalCustodyFailure } from '../../shared/library/types.js';
import { PHOTO_HAS_ABSENT_KEY_SQL } from './backup-key-availability.js';
import { queryAll, queryGet, run } from './sql.js';

export interface LocalCustodyItem {
  readonly id: string;
  readonly assetOwnerId: string | null;
  readonly contentHash: string;
  readonly bytes: number;
  readonly keyId: number;
  readonly fingerprint: string | null;
  readonly verifiedAt: string | null;
  readonly failure: LocalCustodyFailure | null;
}

/** Device-local evidence only: never serialized into a backup manifest. */
export function migrateLocalCustodyIntegrity(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE photos ADD COLUMN local_custody_failure TEXT
      CHECK (local_custody_failure IS NULL OR local_custody_failure IN ('local-missing', 'local-corrupt'));
    ALTER TABLE photos ADD COLUMN local_custody_fingerprint TEXT;
    ALTER TABLE photos ADD COLUMN local_custody_verified_at TEXT;
    DROP INDEX idx_photos_unavailable;
    CREATE INDEX idx_photos_unavailable ON photos (id)
      WHERE preview_failure IS NOT NULL OR preview_missing = 1 OR dimension_status = 'unavailable'
         OR original_failure IS NOT NULL OR local_custody_failure IS NOT NULL;
  `);
}

// A restored exclusion is deliberately a placeholder, not a lost local copy.
// The ordinary view and live key check also fence protected/moved/locked rows.
const ELIGIBLE = `l.coverage = 'excluded' AND p.restored_exclusion_at IS NULL
  AND NOT (${PHOTO_HAS_ABSENT_KEY_SQL})`;

export class LocalCustodyRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  items(page: { readonly afterId: string | null; readonly limit: number }): readonly LocalCustodyItem[] {
    return queryAll<LocalCustodyItem>(
      this.db,
      `SELECT p.id, p.asset_owner_id AS assetOwnerId, p.content_hash AS contentHash, p.bytes, p.key_id AS keyId,
              p.local_custody_fingerprint AS fingerprint, p.local_custody_verified_at AS verifiedAt,
              p.local_custody_failure AS failure
         FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id
        WHERE ${ELIGIBLE} AND (@afterId IS NULL OR p.id > @afterId)
        ORDER BY p.id LIMIT @limit`,
      page,
    );
  }

  available(item: LocalCustodyItem): boolean {
    return (
      queryGet<{ id: string }>(
        this.db,
        `SELECT p.id FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id
        WHERE ${ELIGIBLE} AND p.id = @id AND p.content_hash = @contentHash AND p.bytes = @bytes AND p.key_id = @keyId
          AND coalesce(p.asset_owner_id, p.id) = @ownerId`,
        { id: item.id, contentHash: item.contentHash, ownerId: item.assetOwnerId ?? item.id, bytes: item.bytes, keyId: item.keyId },
      ) !== undefined
    );
  }

  /** Commit only to still-eligible references with the same content/AAD owner.
   * Coverage, ledger status, dirty state and remote objects are untouched. */
  record(
    item: LocalCustodyItem,
    failure: LocalCustodyFailure | null,
    verified?: { readonly fingerprint: string; readonly at: string },
  ): readonly string[] {
    return this.db.transaction(() => {
      const previous = queryGet<{ failure: LocalCustodyFailure | null; originalFailure: string | null }>(
        this.db,
        `SELECT p.local_custody_failure AS failure, p.original_failure AS originalFailure
           FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id
          WHERE ${ELIGIBLE} AND p.id = @id AND p.content_hash = @contentHash AND p.bytes = @bytes AND p.key_id = @keyId
            AND coalesce(p.asset_owner_id, p.id) = @ownerId`,
        { id: item.id, contentHash: item.contentHash, ownerId: item.assetOwnerId ?? item.id, bytes: item.bytes, keyId: item.keyId },
      );
      if (previous === undefined) return [];
      run(this.db, 'UPDATE photos SET local_custody_failure = ? WHERE id = ?', failure, item.id);
      if (verified !== undefined) {
        run(
          this.db,
          `UPDATE photos SET local_custody_fingerprint = ?, local_custody_verified_at = ?, original_failure = NULL WHERE id = ?`,
          verified.fingerprint,
          verified.at,
          item.id,
        );
      }
      return previous.failure !== failure || (verified !== undefined && previous.originalFailure !== null) ? [item.id] : [];
    })();
  }
}
