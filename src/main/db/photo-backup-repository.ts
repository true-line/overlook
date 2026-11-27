import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { BackupManifestSnapshot, BackupManifestSnapshotV15, RestorableBackupManifest } from '../backup/backup-manifest.js';
import { isExcludedManifestPhoto, manifestBlobPath, type BackupManifestPhotoV14 } from '../backup/backup-manifest-coverage.js';
import type { BackupManifestKeyringEntryV15 } from '../backup/backup-manifest-keyring.js';
import type { WrappedKeyRecord } from '../crypto/keystore.js';
import { queryAll, queryGet, run, runNamed } from './sql.js';
import { select } from './photo-query.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { PhotoRow } from './photos-repository.js';

function mediaInfoJson(mediaInfo: unknown): string | null {
  return mediaInfo === null || mediaInfo === undefined ? null : JSON.stringify(mediaInfo);
}

export type ManifestSnapshotWithKeyring = BackupManifestSnapshot & Pick<BackupManifestSnapshotV15, 'keyring'>;

/** The keyring registry as the manifest carries it (#517): every key row,
 * whether or not this device holds its material. */
export function keyringSnapshot(db: BetterSqlite3.Database): readonly BackupManifestKeyringEntryV15[] {
  return queryAll<{
    id: number;
    key_ref: string;
    version: number;
    kind: BackupManifestKeyringEntryV15['kind'];
    origin: BackupManifestKeyringEntryV15['origin'];
    label: string | null;
    fingerprint: string | null;
  }>(db, `SELECT id, key_ref, version, kind, origin, label, fingerprint FROM keys ORDER BY id`).map((row) => ({
    keyId: row.id,
    keyRef: row.key_ref,
    version: row.version,
    kind: row.kind,
    origin: row.origin,
    label: row.label,
    fingerprint: row.fingerprint,
  }));
}

export function manifestSnapshot(db: BetterSqlite3.Database, toRecord: (row: PhotoRow) => PhotoRecord): ManifestSnapshotWithKeyring {
  return db.transaction(() => {
    const recoverable = `(p.deleted_at IS NULL OR (p.deleted_at IS NOT NULL AND l.status IN ('synced', 'offloaded')))`;
    const photos = queryAll<PhotoRow>(db, `${select('date')} WHERE ${recoverable} ORDER BY p.imported_at, p.id`).map(
      (row): BackupManifestPhotoV14 => {
        const {
          previewFailure: _previewFailure,
          originalFailure: _originalFailure,
          localCustodyFailure: _localCustodyFailure,
          dimensionStatus: _dimensionStatus,
          syncState: _syncState,
          coverage,
          locked: _locked,
          missingKeyId: _missingKeyId,
          tags: _tags,
          title,
          description,
          userTags,
          importedKeywords,
          suppressedKeywords,
          metadataVersion,
          ...photo
        } = toRecord(row);
        // Variant fields (#496) are omitted when default so a root variant's
        // record keeps its pre-13 byte shape and legacy equality checks hold.
        const { isOriginal, derivativeKey, variantSourceId, assetOwnerId, ...base } = photo;
        const hasMetadata =
          title !== null ||
          description !== null ||
          userTags.length > 0 ||
          importedKeywords.length > 0 ||
          suppressedKeywords.length > 0 ||
          metadataVersion !== 1;
        const record = {
          ...base,
          ...(isOriginal ? { isOriginal: true } : {}),
          ...(derivativeKey === photo.contentHash ? {} : { derivativeKey }),
          ...(variantSourceId === null ? {} : { variantSourceId }),
          ...(assetOwnerId === null ? {} : { assetOwnerId }),
          ...(hasMetadata ? { title, description, userTags, importedKeywords, suppressedKeywords, metadataVersion } : {}),
        };
        // ADR-0033 §4: a row that is excluding or excluded promises no blob.
        // `excluding` already reads as excluded here so the generation that
        // precedes the provider delete never claims the object (§2).
        return coverage === 'included' ? { ...record, blobPath: manifestBlobPath(photo.contentHash) } : { ...record, coverage: 'excluded' };
      },
    );
    const photoIds = new Set(photos.map((photo) => photo.id));
    const albumRows = queryAll<{ id: string; name: string; createdAt: string; position: number }>(
      db,
      `SELECT id, name, created_at AS createdAt, position FROM albums WHERE kind = 'album' ORDER BY position, id`,
    );
    const members = queryAll<{ albumId: string; photoId: string }>(
      db,
      `SELECT ap.album_id AS albumId, ap.photo_id AS photoId
         FROM album_photos ap
         JOIN albums a ON a.id = ap.album_id
         JOIN ordinary_visible_photos p ON p.id = ap.photo_id
         JOIN sync_ledger l ON l.photo_id = p.id
        WHERE ${recoverable}
        ORDER BY a.position, a.id, ap.position, ap.photo_id`,
    );
    const membersByAlbum = new Map<string, string[]>();
    for (const member of members) {
      if (!photoIds.has(member.photoId)) continue;
      const existing = membersByAlbum.get(member.albumId) ?? [];
      existing.push(member.photoId);
      membersByAlbum.set(member.albumId, existing);
    }
    const albums = albumRows.map((album) => ({ ...album, photoIds: membersByAlbum.get(album.id) ?? [] }));
    const databaseSchema = queryGet<{ version: number }>(db, 'SELECT max(version) AS version FROM schema_migrations')?.version ?? 1;
    const keyIds = [...new Set(photos.map((photo) => photo.keyId))].sort((a, b) => a - b);
    return {
      databaseSchema,
      keyIds,
      keyring: keyringSnapshot(db),
      photos,
      albums,
      totals: {
        photos: photos.length,
        bytes: photos.reduce((sum, photo) => sum + photo.bytes, 0),
        albums: albums.length,
      },
    };
  })();
}

export function restoreManifest(
  db: BetterSqlite3.Database,
  manifest: RestorableBackupManifest,
  keys: readonly WrappedKeyRecord[],
  missingPhotoIds: ReadonlySet<string> = new Set(),
): void {
  db.transaction(() => {
    const occupied = queryGet<{ count: number }>(
      db,
      `SELECT (SELECT count(*) FROM photos) + (SELECT count(*) FROM albums) + (SELECT count(*) FROM keys) + (SELECT count(*) FROM boards) AS count`,
    );
    if ((occupied?.count ?? 0) !== 0) throw new Error('restore requires an empty staged catalog');
    // Keyring rows (#517): registry facts from the manifest, presence from
    // the recovered custody. A registry entry the bootstrap lacks restores
    // as an absent key, so its objects read as locked rather than lost.
    const registry = new Map<number, BackupManifestKeyringEntryV15>(
      'keyring' in manifest ? manifest.keyring.map((entry) => [entry.keyId, entry]) : [],
    );
    const custody = new Map(keys.map((key) => [key.id, key]));
    for (const id of [...new Set([...registry.keys(), ...custody.keys()])].sort((left, right) => left - right)) {
      const entry = registry.get(id);
      const key = custody.get(id);
      runNamed(
        db,
        `INSERT INTO keys (id, wrapped_key, created_at, retired_at, kind, key_ref, version, fingerprint, label, origin, material_present)
         VALUES (@id, @wrappedKey, @createdAt, @retiredAt, @kind, @keyRef, @version, @fingerprint, @label, @origin, @present)`,
        {
          id,
          wrappedKey: key?.wrappedKey ?? 'keystore-managed',
          createdAt: key?.createdAt ?? manifest.generatedAt,
          retiredAt: key?.status === 'active' ? null : manifest.generatedAt,
          kind: entry?.kind ?? key?.kind ?? 'library',
          keyRef: entry?.keyRef ?? key?.keyRef ?? null,
          version: entry?.version ?? key?.version ?? 1,
          fingerprint: entry?.fingerprint ?? null,
          label: entry?.label ?? null,
          origin: entry?.origin ?? key?.origin ?? 'local',
          present: key === undefined ? 0 : 1,
        },
      );
    }
    for (const photo of manifest.photos) {
      const excluded = isExcludedManifestPhoto(photo);
      const absent = excluded || missingPhotoIds.has(photo.id);
      runNamed(
        db,
        `INSERT INTO photos (
           id, file_name, file_kind, width, height, bytes, content_hash,
           camera, lens, iso, aperture, shutter, focal_length, taken_at,
           gps_lat, gps_lon, place, imported_at, import_source, favorite,
           is_original, key_id, deleted_at, media_info, user_title, user_description,
           imported_keywords, user_tags, suppressed_keywords, metadata_tags_search, metadata_version,
           derivative_key, variant_source_id, asset_owner_id, original_failure, restored_exclusion_at
         ) VALUES (
           @id, @fileName, @fileKind, @width, @height, @bytes, @contentHash,
           @camera, @lens, @iso, @aperture, @shutter, @focalLength, @takenAt,
           @gpsLat, @gpsLon, @place, @importedAt, @importSource, @favorite,
           @isOriginal, @keyId, @deletedAt, @mediaInfoJson, @title, @description,
           @importedKeywordsJson, @userTagsJson, @suppressedKeywordsJson, @metadataTagsSearch, @metadataVersion,
           @derivativeKey, @variantSourceId, @assetOwnerId, @originalFailure, @restoredExclusionAt
         )`,
        {
          ...photo,
          originalFailure: absent ? 'missing-original' : null,
          restoredExclusionAt: excluded ? manifest.generatedAt : null,
          coverage: null,
          blobPath: null,
          derivativeKey: ('derivativeKey' in photo ? photo.derivativeKey : undefined) ?? photo.contentHash,
          variantSourceId: ('variantSourceId' in photo ? photo.variantSourceId : undefined) ?? null,
          assetOwnerId: ('assetOwnerId' in photo ? photo.assetOwnerId : undefined) ?? null,
          favorite: photo.favorite ? 1 : 0,
          isOriginal: photo.isOriginal === true ? 1 : 0,
          mediaInfo: null,
          mediaInfoJson: mediaInfoJson(photo.mediaInfo),
          title: photo.title ?? null,
          description: photo.description ?? null,
          importedKeywordsJson: JSON.stringify(photo.importedKeywords ?? []),
          userTagsJson: JSON.stringify(photo.userTags ?? []),
          suppressedKeywordsJson: JSON.stringify(photo.suppressedKeywords ?? []),
          metadataTagsSearch: [...(photo.importedKeywords ?? []), ...(photo.userTags ?? [])]
            .filter((tag) => !(photo.suppressedKeywords ?? []).some((suppressed) => suppressed.toLowerCase() === tag.toLowerCase()))
            .join(' '),
          metadataVersion: photo.metadataVersion ?? 1,
        },
      );
      // A NOT FOUND original from a partial restore (#915) keeps its row but
      // enters the ledger as 'error' — the scrubber's confirmed-remote-loss
      // vocabulary — with no backup claim to lie about. An excluded record
      // (ADR-0033 §4) restores the same way as a "not in this backup"
      // placeholder: the row and its metadata return, the original does not,
      // and the placeholder stays excluded so nothing pretends to upload it.
      run(
        db,
        `INSERT INTO sync_ledger (photo_id, status, last_backup_at, dirty, coverage, coverage_origin, coverage_since)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
        photo.id,
        absent ? 'error' : 'synced',
        absent ? null : manifest.generatedAt,
        excluded ? 'excluded' : 'included',
        excluded ? 'user' : null,
        excluded ? manifest.generatedAt : null,
      );
    }
    for (const album of manifest.albums) {
      runNamed(db, `INSERT INTO albums (id, name, created_at, position) VALUES (@id, @name, @createdAt, @position)`, album);
      for (const [position, photoId] of album.photoIds.entries()) {
        run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES (?, ?, ?)`, album.id, photoId, position);
      }
    }
  })();
}
