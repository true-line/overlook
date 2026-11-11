import { randomUUID } from 'node:crypto';
import { ActivityRepository } from '../activity/activity-repository.js';
import { restoreProtectedAlbum, type OrdinaryAlbumRestoration, type AlbumRestorationPorts } from './protected-album-restoration.js';
export type { OrdinaryAlbumRestoration } from './protected-album-restoration.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { EditRevisionRepository } from './edit-revision-repository.js';
import type { BackupManifestEditRevisionV11 } from '../backup/backup-manifest-edit-revisions.js';

import type { ProtectedPhotoMetadata } from '../crypto/protected-photo-metadata.js';
import type { PhotoInsert } from '../../shared/library/types.js';
import { refreshInAllPhotos } from './album-visibility-repository.js';
import { queryAll, queryGet, run, runNamed } from './sql.js';

export type ProtectedMigrationOperation = 'protect' | 'unprotect' | 'move';
export type ProtectedMigrationPhase = 'prepare' | 'copy' | 'verify' | 'commit' | 'purge';

export interface ProtectedMigrationItem {
  readonly photoId: string;
  readonly sourceBlobRef: string;
  readonly sourceAssetOwnerId?: string;
  readonly sourceDerivativeRef?: string;
  readonly targetBlobRef: string;
  readonly sealedTargetMetadata: Buffer;
  readonly hasThumb: boolean;
  readonly hasMid: boolean;
  readonly phase: ProtectedMigrationPhase;
}

export interface ProtectedMigrationJournal {
  readonly migrationId: string;
  readonly operation: ProtectedMigrationOperation;
  readonly sourceAlbumId: string | null;
  readonly targetAlbumId: string | null;
  readonly phase: ProtectedMigrationPhase;
  readonly items: readonly ProtectedMigrationItem[];
}

export interface ProtectedPhotoStoredRecord {
  readonly photoId: string;
  readonly albumId: string;
  readonly blobRef: string;
  readonly sealedMetadata: Buffer;
  readonly hasThumb: boolean;
  readonly hasMid: boolean;
}

interface JournalRow {
  readonly migrationId: string;
  readonly operation: ProtectedMigrationOperation;
  readonly sourceAlbumId: string | null;
  readonly targetAlbumId: string | null;
  readonly phase: ProtectedMigrationPhase;
}

interface ItemRow {
  readonly photoId: string;
  readonly sourceBlobRef: string;
  readonly sourceAssetOwnerId: string | null;
  readonly sourceDerivativeRef: string | null;
  readonly targetBlobRef: string;
  readonly sealedTargetMetadata: Buffer;
  readonly hasThumb: number;
  readonly hasMid: number;
  readonly phase: ProtectedMigrationPhase;
}

interface StoredRow {
  readonly photoId: string;
  readonly albumId: string;
  readonly blobRef: string;
  readonly sealedMetadata: Buffer;
  readonly hasThumb: number;
  readonly hasMid: number;
}

export class ProtectedPhotoMigrationRepositoryError extends Error {
  override readonly name = 'ProtectedPhotoMigrationRepositoryError';
}

function stored(row: StoredRow): ProtectedPhotoStoredRecord {
  return {
    photoId: row.photoId,
    albumId: row.albumId,
    blobRef: row.blobRef,
    sealedMetadata: Buffer.from(row.sealedMetadata),
    hasThumb: row.hasThumb === 1,
    hasMid: row.hasMid === 1,
  };
}

export class ProtectedPhotoMigrationRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    /** A supplied collaborator must use this connection so restoration shares the custody transaction. */
    private readonly revisions: Pick<EditRevisionRepository, 'snapshot' | 'restore'> = new EditRevisionRepository(db),
    private readonly albumRestoration: AlbumRestorationPorts = {
      createId: randomUUID,
      activity: new ActivityRepository(db),
    },
  ) {}

  ordinaryMemberships(photoId: string): ProtectedPhotoMetadata['ordinaryMemberships'] {
    return queryAll<{ albumId: string; position: number }>(
      this.db,
      `SELECT album_id AS albumId, position FROM album_photos WHERE photo_id = @photoId ORDER BY album_id`,
      { photoId },
    );
  }

  getProtected(photoId: string): ProtectedPhotoStoredRecord | undefined {
    const row = queryGet<StoredRow>(
      this.db,
      `SELECT photo_id AS photoId, album_id AS albumId, blob_ref AS blobRef,
              sealed_metadata AS sealedMetadata, has_thumb AS hasThumb, has_mid AS hasMid
         FROM protected_photo_records WHERE photo_id = ?`,
      photoId,
    );
    return row === undefined ? undefined : stored(row);
  }

  listProtected(albumId: string): readonly ProtectedPhotoStoredRecord[] {
    return queryAll<StoredRow>(
      this.db,
      `SELECT photo_id AS photoId, album_id AS albumId, blob_ref AS blobRef,
              sealed_metadata AS sealedMetadata, has_thumb AS hasThumb, has_mid AS hasMid
         FROM protected_photo_records record
        WHERE album_id = @albumId
          AND NOT EXISTS (
            SELECT 1 FROM protected_photo_migration_items item WHERE item.photo_id = record.photo_id
          ) ORDER BY photo_id`,
      { albumId },
    ).map(stored);
  }

  countProtectedBlobOwners(albumId: string, blobRef: string): number {
    return (
      queryGet<{ count: number }>(
        this.db,
        'SELECT count(*) AS count FROM protected_photo_records WHERE album_id = ? AND blob_ref = ?',
        albumId,
        blobRef,
      )?.count ?? 0
    );
  }

  replaceMetadata(input: {
    readonly albumId: string;
    readonly photoId: string;
    readonly expected: Buffer;
    readonly sealedMetadata: Buffer;
    readonly now?: string;
  }): boolean {
    return (
      queryGet<{ photoId: string }>(
        this.db,
        `UPDATE protected_photo_records
            SET sealed_metadata = @sealedMetadata, updated_at = @now, manifest_dirty = 1
          WHERE album_id = @albumId AND photo_id = @photoId AND sealed_metadata = @expected
            AND NOT EXISTS (
              SELECT 1 FROM protected_photo_migration_items item WHERE item.photo_id = protected_photo_records.photo_id
            )
          RETURNING photo_id AS photoId`,
        { ...input, now: input.now ?? new Date().toISOString() },
      ) !== undefined
    );
  }

  ordinaryEditRevisions(photoIds: readonly string[]): ReadonlyMap<string, readonly BackupManifestEditRevisionV11[]> {
    const histories = new Map<string, BackupManifestEditRevisionV11[]>();
    for (const revision of this.revisions.snapshot(new Set(photoIds))) {
      const history = histories.get(revision.photoId) ?? [];
      history.push(revision);
      histories.set(revision.photoId, history);
    }
    return histories;
  }

  countOrdinaryBlobOwners(contentHash: string): number {
    return queryGet<{ count: number }>(this.db, 'SELECT count(*) AS count FROM photos WHERE content_hash = ?', contentHash)?.count ?? 0;
  }

  prepare(input: {
    readonly migrationId: string;
    readonly operation: ProtectedMigrationOperation;
    readonly sourceAlbumId: string | null;
    readonly targetAlbumId: string | null;
    readonly items: readonly Omit<ProtectedMigrationItem, 'phase'>[];
    readonly now?: string;
  }): ProtectedMigrationJournal {
    if (input.items.length === 0) throw new ProtectedPhotoMigrationRepositoryError('migration requires at least one photo');
    const now = input.now ?? new Date().toISOString();
    this.db.transaction(() => {
      runNamed(
        this.db,
        `INSERT INTO protected_photo_migrations (
           migration_id, operation, source_album_id, target_album_id, phase, created_at, updated_at
         ) VALUES (@migrationId, @operation, @sourceAlbumId, @targetAlbumId, 'prepare', @now, @now)`,
        {
          migrationId: input.migrationId,
          operation: input.operation,
          sourceAlbumId: input.sourceAlbumId,
          targetAlbumId: input.targetAlbumId,
          now,
        },
      );
      for (const item of input.items) {
        this.validateSource(input.operation, input.sourceAlbumId, item.photoId, item.sourceBlobRef);
        runNamed(
          this.db,
          `INSERT INTO protected_photo_migration_items (
             migration_id, photo_id, source_blob_ref, source_asset_owner_id, source_derivative_ref, target_blob_ref, sealed_target_metadata,
             has_thumb, has_mid, item_phase
           ) VALUES (
             @migrationId, @photoId, @sourceBlobRef, @sourceAssetOwnerId, @sourceDerivativeRef, @targetBlobRef, @sealedTargetMetadata,
             @hasThumb, @hasMid, 'prepare'
           )`,
          {
            migrationId: input.migrationId,
            ...item,
            sourceAssetOwnerId: item.sourceAssetOwnerId ?? null,
            sourceDerivativeRef: item.sourceDerivativeRef ?? null,
            hasThumb: item.hasThumb ? 1 : 0,
            hasMid: item.hasMid ? 1 : 0,
          },
        );
        if (input.operation === 'protect') {
          run(this.db, 'DELETE FROM photo_embeddings WHERE photo_id = ?', item.photoId);
          run(this.db, 'DELETE FROM photo_fingerprints WHERE photo_id = ?', item.photoId);
        }
      }
    })();
    const journal = this.get(input.migrationId);
    if (journal === undefined) throw new ProtectedPhotoMigrationRepositoryError('migration journal did not persist');
    return journal;
  }

  get(migrationId: string): ProtectedMigrationJournal | undefined {
    const row = queryGet<JournalRow>(
      this.db,
      `SELECT migration_id AS migrationId, operation, source_album_id AS sourceAlbumId,
              target_album_id AS targetAlbumId, phase
         FROM protected_photo_migrations WHERE migration_id = ?`,
      migrationId,
    );
    if (row === undefined) return undefined;
    const items = queryAll<ItemRow>(
      this.db,
      `SELECT photo_id AS photoId, source_blob_ref AS sourceBlobRef,
              source_asset_owner_id AS sourceAssetOwnerId, source_derivative_ref AS sourceDerivativeRef, target_blob_ref AS targetBlobRef,
              sealed_target_metadata AS sealedTargetMetadata, has_thumb AS hasThumb,
              has_mid AS hasMid, item_phase AS phase
         FROM protected_photo_migration_items WHERE migration_id = @migrationId ORDER BY photo_id`,
      { migrationId },
    ).map(({ sourceAssetOwnerId, sourceDerivativeRef, ...item }): ProtectedMigrationItem => ({
      ...item,
      ...(sourceAssetOwnerId === null ? {} : { sourceAssetOwnerId }),
      ...(sourceDerivativeRef === null ? {} : { sourceDerivativeRef }),
      sealedTargetMetadata: Buffer.from(item.sealedTargetMetadata),
      hasThumb: item.hasThumb === 1,
      hasMid: item.hasMid === 1,
    }));
    return { ...row, items };
  }

  listJournals(): readonly ProtectedMigrationJournal[] {
    return queryAll<{ migrationId: string }>(
      this.db,
      'SELECT migration_id AS migrationId FROM protected_photo_migrations ORDER BY created_at, migration_id',
    ).map(({ migrationId }) => this.get(migrationId)!);
  }

  findAlbumJournal(albumId: string, operation: 'protect' | 'unprotect'): ProtectedMigrationJournal | undefined {
    const column = operation === 'protect' ? 'target_album_id' : 'source_album_id';
    const row = queryGet<{ migrationId: string }>(
      this.db,
      `SELECT migration_id AS migrationId FROM protected_photo_migrations
        WHERE operation = @operation AND ${column} = @albumId
        ORDER BY created_at LIMIT 1`,
      { albumId, operation },
    );
    return row === undefined ? undefined : this.get(row.migrationId);
  }

  transition(migrationId: string, from: ProtectedMigrationPhase, to: ProtectedMigrationPhase, now = new Date().toISOString()): void {
    const changed = queryGet<{ migrationId: string }>(
      this.db,
      `UPDATE protected_photo_migrations SET phase = @to, updated_at = @now
        WHERE migration_id = @migrationId AND phase = @from RETURNING migration_id AS migrationId`,
      { migrationId, from, to, now },
    );
    if (changed === undefined) throw new ProtectedPhotoMigrationRepositoryError(`migration is not in ${from}`);
    runNamed(this.db, 'UPDATE protected_photo_migration_items SET item_phase = @to WHERE migration_id = @migrationId', {
      migrationId,
      to,
    });
  }

  commitProtect(migrationId: string, now = new Date().toISOString()): void {
    this.db.transaction(() => {
      const journal = this.require(migrationId, 'protect', 'verify');
      for (const item of journal.items) {
        const source = queryGet<{ id: string }>(
          this.db,
          'SELECT id FROM photos WHERE id = ? AND content_hash = ?',
          item.photoId,
          item.sourceBlobRef,
        );
        if (source === undefined) throw new ProtectedPhotoMigrationRepositoryError('ordinary source changed during migration');
        runNamed(
          this.db,
          `INSERT INTO protected_photo_records (
             photo_id, album_id, record_version, blob_ref, sealed_metadata,
             has_thumb, has_mid, created_at, updated_at
           ) VALUES (
             @photoId, @albumId, 1, @blobRef, @sealedMetadata,
             @hasThumb, @hasMid, @now, @now
           )`,
          {
            photoId: item.photoId,
            albumId: journal.targetAlbumId,
            blobRef: item.targetBlobRef,
            sealedMetadata: item.sealedTargetMetadata,
            hasThumb: item.hasThumb ? 1 : 0,
            hasMid: item.hasMid ? 1 : 0,
            now,
          },
        );
        this.insertRemoteObjects(item.photoId, item.hasThumb, item.hasMid);
        run(this.db, 'DELETE FROM photos WHERE id = ?', item.photoId);
      }
      this.transition(migrationId, 'verify', 'commit', now);
    })();
  }

  commitUnprotect(
    migrationId: string,
    restorations: ReadonlyMap<
      string,
      {
        readonly photo: PhotoInsert;
        readonly memberships: ProtectedPhotoMetadata['ordinaryMemberships'];
        readonly editRevisions?: readonly BackupManifestEditRevisionV11[];
      }
    >,
    ordinaryAlbum?: OrdinaryAlbumRestoration,
    now = new Date().toISOString(),
  ): void {
    this.db.transaction(() => {
      const journal = this.require(migrationId, 'unprotect', 'verify');
      if (ordinaryAlbum !== undefined) {
        restoreProtectedAlbum(this.db, ordinaryAlbum, migrationId, now, this.albumRestoration);
      }
      for (const item of journal.items) {
        const restoration = restorations.get(item.photoId);
        if (restoration === undefined || restoration.photo.contentHash !== item.targetBlobRef) {
          throw new ProtectedPhotoMigrationRepositoryError('unprotect restoration does not match verified target');
        }
        this.insertOrdinary(restoration.photo);
        if (restoration.editRevisions !== undefined) this.revisions.restore(restoration.editRevisions);
        for (const membership of restoration.memberships) {
          runNamed(
            this.db,
            `INSERT OR IGNORE INTO album_photos (album_id, photo_id, position)
             SELECT @albumId, @photoId, @position WHERE EXISTS (SELECT 1 FROM albums WHERE id = @albumId)`,
            { ...membership, photoId: item.photoId },
          );
        }
        // #494 / ADR-0030 §6: the All Photos flag is written with the
        // memberships, never left for the startup verify to repair.
        refreshInAllPhotos(this.db, [item.photoId]);
        run(this.db, 'DELETE FROM protected_photo_records WHERE photo_id = ?', item.photoId);
      }
      this.transition(migrationId, 'verify', 'commit', now);
    })();
  }

  commitMove(migrationId: string, now = new Date().toISOString()): void {
    this.db.transaction(() => {
      const journal = this.require(migrationId, 'move', 'verify');
      for (const item of journal.items) {
        run(this.db, 'DELETE FROM protected_remote_objects WHERE photo_id = ?', item.photoId);
        const updated = queryGet<{ photoId: string }>(
          this.db,
          `UPDATE protected_photo_records
              SET album_id = @albumId, blob_ref = @blobRef, sealed_metadata = @sealedMetadata,
                  updated_at = @now, manifest_dirty = 1
            WHERE photo_id = @photoId AND album_id = @sourceAlbumId AND blob_ref = @sourceBlobRef
            RETURNING photo_id AS photoId`,
          {
            albumId: journal.targetAlbumId,
            sourceAlbumId: journal.sourceAlbumId,
            photoId: item.photoId,
            sourceBlobRef: item.sourceBlobRef,
            blobRef: item.targetBlobRef,
            sealedMetadata: item.sealedTargetMetadata,
            now,
          },
        );
        if (updated === undefined) throw new ProtectedPhotoMigrationRepositoryError('protected source changed during migration');
        this.insertRemoteObjects(item.photoId, item.hasThumb, item.hasMid);
      }
      this.transition(migrationId, 'verify', 'commit', now);
    })();
  }

  markPurging(migrationId: string): void {
    this.transition(migrationId, 'commit', 'purge');
  }

  finish(migrationId: string): void {
    const journal = this.get(migrationId);
    if (journal === undefined) return;
    if (journal.phase !== 'purge') throw new ProtectedPhotoMigrationRepositoryError('only a purged migration can finish');
    run(this.db, 'DELETE FROM protected_photo_migrations WHERE migration_id = ?', migrationId);
  }

  rollbackPrecommit(migrationId: string): void {
    const journal = this.get(migrationId);
    if (journal === undefined) return;
    if (!['prepare', 'copy', 'verify'].includes(journal.phase)) {
      throw new ProtectedPhotoMigrationRepositoryError('committed migration cannot roll back');
    }
    run(this.db, 'DELETE FROM protected_photo_migrations WHERE migration_id = ?', migrationId);
  }

  private require(migrationId: string, operation: ProtectedMigrationOperation, phase: ProtectedMigrationPhase): ProtectedMigrationJournal {
    const journal = this.get(migrationId);
    if (journal === undefined || journal.operation !== operation || journal.phase !== phase) {
      throw new ProtectedPhotoMigrationRepositoryError(`expected ${operation} migration in ${phase}`);
    }
    return journal;
  }

  private insertRemoteObjects(photoId: string, hasThumb: boolean, hasMid: boolean): void {
    for (const kind of ['original', ...(hasThumb ? (['thumb'] as const) : []), ...(hasMid ? (['mid'] as const) : [])] as const) {
      runNamed(this.db, 'INSERT INTO protected_remote_objects (photo_id, kind) VALUES (@photoId, @kind)', { photoId, kind });
    }
  }

  private validateSource(
    operation: ProtectedMigrationOperation,
    sourceAlbumId: string | null,
    photoId: string,
    sourceBlobRef: string,
  ): void {
    if (operation === 'protect') {
      const photo = queryGet<{ contentHash: string }>(this.db, 'SELECT content_hash AS contentHash FROM photos WHERE id = ?', photoId);
      if (photo?.contentHash !== sourceBlobRef) throw new ProtectedPhotoMigrationRepositoryError('ordinary migration source is missing');
      if (this.getProtected(photoId) !== undefined)
        throw new ProtectedPhotoMigrationRepositoryError('photo already belongs to a protected domain');
      return;
    }
    const photo = this.getProtected(photoId);
    if (photo === undefined || photo.albumId !== sourceAlbumId || photo.blobRef !== sourceBlobRef) {
      throw new ProtectedPhotoMigrationRepositoryError('protected migration source is missing');
    }
  }

  private insertOrdinary(photo: PhotoInsert): void {
    runNamed(
      this.db,
      `INSERT INTO photos (
         id, file_name, file_kind, width, height, bytes, content_hash,
         camera, lens, iso, aperture, shutter, focal_length, taken_at,
         gps_lat, gps_lon, place, imported_at, import_source, favorite, key_id, derivative_key
       ) VALUES (
         @id, @fileName, @fileKind, @width, @height, @bytes, @contentHash,
         @camera, @lens, @iso, @aperture, @shutter, @focalLength, @takenAt,
         @gpsLat, @gpsLon, @place, @importedAt, @importSource, @favorite, @keyId, @derivativeKey
       )`,
      // The derivative key is unique per row (#496): a restored photo owns its
      // hash's derivatives again unless the record names its own key.
      { ...photo, favorite: photo.favorite === true ? 1 : 0, derivativeKey: photo.derivativeKey ?? photo.contentHash },
    );
    run(this.db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES (?, 'local', 1)`, photo.id);
  }
}
