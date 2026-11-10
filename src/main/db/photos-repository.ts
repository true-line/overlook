import { PHOTO_HAS_ABSENT_KEY_SQL } from './backup-key-availability.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { markDirty } from '../backup/sync-ledger.js';
import type { BackupIntegrityItem } from '../backup/integrity-scrubber.js';
import type { RestorableBackupManifest } from '../backup/backup-manifest.js';
import type { WrappedKeyRecord } from '../crypto/keystore.js';
import type { ExtractedMetadata } from '../import/exif.js';
import type { PreviewFailureReason } from '../../shared/library/preview.js';
import type { DimensionStatus } from '../../shared/library/types.js';
import { effectivePhotoTags, normalizePhotoTags } from '../../shared/library/photo-metadata.js';
import { queryAll, queryGet, run, runNamed } from './sql.js';
import { mediaInfoJson, toRecord, type PhotoRow } from './photo-row.js';
import { readExportablePhotoIds } from './exportable-photo-ids.js';
import { setOriginalClassification, softDeleteOrdinary } from './photo-original-policy-repository.js';
import { toggleFavorite as toggleFavoritePhoto, toggleFavorites as toggleFavoritePhotos } from './photo-favorite-repository.js';
import { moveAlbum, readAlbumOrder, replaceAlbumOrder, type AlbumOrderResult } from './album-order-repository.js';
import { createCollection, readAlbumTree, readAlbumTags } from './album-tree-repository.js';
import { readAlbumListings, readHiddenAlbumIds, refreshInAllPhotos, writeAlbumVisibility } from './album-visibility-repository.js';
export { verifyInAllPhotosAsync } from './album-visibility-repository.js';
import {
  ALL_PHOTOS_MEMBERSHIP_WHERE,
  allPhotosWhere,
  buildQueryPlan,
  HIDDEN_BY_ALBUMS_WHERE,
  inclusionParams,
  ORDERINGS,
  select,
  selectRankedWithProjection,
  selectWithProjection,
  sourceWhere,
} from './photo-query.js';
import { readGalleryPolicy, writeGalleryPolicy } from './gallery-policy-repository.js';
import type { GalleryPolicy } from '../../shared/library/gallery-policy.js';
import { manifestSnapshot as readManifestSnapshot, restoreManifest as restoreManifestFromBackup } from './photo-backup-repository.js';
import { PhotoMetadataRepository } from './photo-metadata-repository.js';

import type {
  AlbumListing,
  LibraryQuery,
  LibraryStats,
  PageCursor,
  PageRequest,
  PageResult,
  PhotoInsert,
  PhotoRecord,
  SelectionRangeRequest,
  SourceCounts,
  SyncStatus,
} from '../../shared/library/types.js';

// Typed repository over the photos + sync_ledger tables (#69). No raw SQL
// leaves this module; the IPC service (#71) speaks records only.

export { toRecord, type PhotoRow } from './photo-row.js';

export const SELECT = select('date');
export class PhotosRepository {
  private readonly metadata: PhotoMetadataRepository;

  constructor(private readonly db: BetterSqlite3.Database) {
    this.metadata = new PhotoMetadataRepository(db);
  }

  /** Inserts the photo and its sync_ledger row (status local, dirty) atomically. */
  insert(photo: PhotoInsert): void {
    this.db.transaction(() => {
      runNamed(
        this.db,
        `INSERT INTO photos (
           id, file_name, file_kind, width, height, bytes, content_hash,
           camera, lens, iso, aperture, shutter, focal_length, taken_at,
           gps_lat, gps_lon, place, imported_at, import_source, favorite, key_id,
           media_info, user_title, user_description, imported_keywords, user_tags,
           suppressed_keywords, metadata_tags_search, metadata_version, derivative_key, variant_source_id, asset_owner_id
         ) VALUES (
           @id, @fileName, @fileKind, @width, @height, @bytes, @contentHash,
           @camera, @lens, @iso, @aperture, @shutter, @focalLength, @takenAt,
           @gpsLat, @gpsLon, @place, @importedAt, @importSource, @favorite, @keyId,
           @mediaInfoJson, @title, @description, @importedKeywordsJson, @userTagsJson,
           @suppressedKeywordsJson, @metadataTagsSearch, @metadataVersion, @derivativeKey, @variantSourceId, @assetOwnerId
         )`,
        {
          ...photo,
          derivativeKey: photo.derivativeKey ?? photo.contentHash,
          variantSourceId: photo.variantSourceId ?? null,
          assetOwnerId: photo.assetOwnerId ?? null,
          favorite: photo.favorite === true ? 1 : 0,
          mediaInfo: null,
          mediaInfoJson: mediaInfoJson(photo.mediaInfo),
          title: photo.title ?? null,
          description: photo.description ?? null,
          importedKeywordsJson: JSON.stringify(normalizePhotoTags(photo.importedKeywords ?? [])),
          userTagsJson: JSON.stringify(normalizePhotoTags(photo.userTags ?? [])),
          suppressedKeywordsJson: JSON.stringify(normalizePhotoTags(photo.suppressedKeywords ?? [])),
          metadataTagsSearch: effectivePhotoTags(photo.importedKeywords ?? [], photo.userTags ?? [], photo.suppressedKeywords ?? []).join(
            ' ',
          ),
          metadataVersion: photo.metadataVersion ?? 1,
        },
      );
      run(this.db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES (?, 'local', 1)`, photo.id);
    })();
  }

  /** Keyset-paged query per ADR-0005 — never OFFSET. Chips AND-combine; `query`
   * runs against the trigger-synced FTS5 index (name/place/camera, prefix
   * tokenized) and ranks by bm25, overriding `order` while searching (#390).
   * A query that tokenizes to nothing (pure punctuation/whitespace) falls
   * back to the legacy case-insensitive substring match. */
  page(request: PageRequest): PageResult {
    const plan = buildQueryPlan(request, this.galleryPolicy());
    // The ranked branch's ORDER BY must stay the literal `rank` token (see
    // fromRanked) — it can't reuse ORDERINGS' generic `sort_key`/tuple-
    // cursor shape without losing the index-order optimization, so the tie
    // break for its cursor lives in an OR'd WHERE predicate instead. The tie
    // break itself must be `ph.rowid`, not `p.id`: FTS5 only guarantees rank
    // order, and among tied ranks it emits rows in its own internal (rowid)
    // order — breaking ties by `p.id` instead produced measured duplicates
    // once a tied group spanned a page boundary. `p.id` is TEXT (a ulid), so
    // the cursor still carries it for API consistency; the tiebreak resolves
    // it back to a rowid via an indexed point lookup.
    let fromClause: string, orderByClause: string, cursorClause: string;
    if (plan.ftsQuery !== null) {
      fromClause = plan.fromClause;
      orderByClause = 'ORDER BY rank';
      cursorClause =
        request.cursor === undefined
          ? ''
          : 'AND (rank > @cursorKey OR (rank = @cursorKey AND ph.rowid > (SELECT rowid FROM photos WHERE id = @cursorId)))';
    } else {
      const ordering = ORDERINGS[request.order ?? 'date'];
      fromClause = plan.fromClause;
      orderByClause = plan.orderByClause;
      // SQLite scans expression indexes for the tuple alone. The implied
      // scalar bound enables a seek; the tuple still orders equal-key IDs.
      cursorClause =
        request.cursor === undefined
          ? ''
          : `AND ${ordering.expr} ${ordering.cmp}= @cursorKey
             AND (${ordering.expr}, p.id) ${ordering.cmp} (@cursorKey, @cursorId)`;
    }
    const rows = queryAll<PhotoRow>(
      this.db,
      `${fromClause}
       WHERE ${plan.whereClause} ${cursorClause}
       ${orderByClause}
       LIMIT @limit`,
      {
        ...plan.params,
        limit: request.limit,
        cursorKey: request.cursor?.sortKey ?? null,
        cursorId: request.cursor?.id ?? null,
      },
    );
    const last = rows[rows.length - 1];
    const nextCursor: PageCursor | null =
      rows.length === request.limit && last !== undefined ? { sortKey: last.sort_key, id: last.id } : null;
    return {
      photos: rows.map(toRecord),
      nextCursor,
      search: {
        requestedMode: request.searchMode ?? 'auto',
        appliedMode: 'keyword',
        fallbackReason: null,
        indexed: 0,
        total: 0,
      },
    };
  }

  /** Top keyword candidates used by ADR-0018 reciprocal-rank fusion. */
  searchIds(request: LibraryQuery, limit: number): readonly string[] {
    const plan = buildQueryPlan(request, this.galleryPolicy());
    const order = request.order ?? 'date';
    return queryAll<{ id: string }>(
      this.db,
      `${plan.ftsQuery !== null ? selectRankedWithProjection('p.id') : selectWithProjection(order, 'p.id')}
       WHERE ${plan.whereClause}
       ${plan.orderByClause}
       LIMIT @limit`,
      { ...plan.params, limit },
    ).map(({ id }) => id);
  }

  /** Hydrates a pre-ranked projection without allowing SQL ordering input. */
  records(photoIds: readonly string[]): readonly PhotoRecord[] {
    if (photoIds.length === 0) return [];
    const rows = queryAll<PhotoRow>(
      this.db,
      `${select('date')}
       WHERE p.id IN (SELECT value FROM json_each(@photoIds))`,
      { photoIds: JSON.stringify(photoIds) },
    );
    const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
    return photoIds.flatMap((id) => {
      const photo = byId.get(id);
      return photo === undefined ? [] : [photo];
    });
  }

  /** Returns every ID in the logical collection, independent of paging. */
  selectAllIds(request: LibraryQuery): readonly string[] {
    const plan = buildQueryPlan(request, this.galleryPolicy());
    const order = request.order ?? 'date';
    const rows = queryAll<{ id: string }>(
      this.db,
      `${plan.ftsQuery !== null ? selectRankedWithProjection('p.id') : selectWithProjection(order, 'p.id')}
       WHERE ${plan.whereClause}
       ${plan.orderByClause}`,
      plan.params,
    );
    return [...new Set(rows.map(({ id }) => id))];
  }

  /** Resolves one inclusive range against the complete active projection. */
  selectionRange(request: SelectionRangeRequest): readonly string[] {
    const plan = buildQueryPlan(request, this.galleryPolicy());
    const order = request.order ?? 'date';
    const ids = queryAll<{ id: string }>(
      this.db,
      `${plan.ftsQuery !== null ? selectRankedWithProjection('p.id') : selectWithProjection(order, 'p.id')}
       WHERE ${plan.whereClause}
       ${plan.orderByClause}`,
      plan.params,
    ).map(({ id }) => id);
    const anchorIndex = ids.indexOf(request.anchorId);
    const targetIndex = ids.indexOf(request.targetId);
    if (anchorIndex === -1 || targetIndex === -1) return [];
    return ids.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
  }

  /** Toggles favorite and marks the ledger dirty (feeds pendingCount). */
  toggleFavorite(photoId: string): boolean {
    return toggleFavoritePhoto(this.db, photoId, (id) => markDirty(this.db, id));
  }

  /** Toggles a complete selection atomically, including unloaded rows. */
  toggleFavorites(photoIds: readonly string[]): ReturnType<typeof toggleFavoritePhotos> {
    return toggleFavoritePhotos(this.db, photoIds, (id) => markDirty(this.db, id));
  }

  get(photoId: string): PhotoRecord | undefined {
    const row = queryAll<PhotoRow>(this.db, `${SELECT} WHERE p.id = @id LIMIT 1`, { id: photoId })[0];
    return row === undefined ? undefined : toRecord(row);
  }

  addImportedKeywords(photoId: string, keywords: readonly string[]): boolean {
    return this.metadata.addImportedKeywords(photoId, keywords);
  }

  exportableIds(): readonly string[] {
    return readExportablePhotoIds(this.db);
  }

  /** Startup maintenance (#390): FTS5's 'integrity-check' command, with the
   * `rank = 1` content-check flag, verifies photos_fts against the photos
   * content table itself rather than just the index's internal structure —
   * the plain form doesn't catch a drifted index. Drift should never happen
   * (the table is trigger-synced) but corruption or a skipped migration step
   * would otherwise silently degrade search rather than error. A failed
   * check triggers 'rebuild', FTS5's full re-index command. */
  verifySearchIndex(): { rebuilt: boolean } {
    try {
      this.db.exec(`INSERT INTO photos_fts(photos_fts, rank) VALUES ('integrity-check', 1)`);
      return { rebuilt: false };
    } catch {
      this.db.exec(`INSERT INTO photos_fts(photos_fts) VALUES ('rebuild')`);
      return { rebuilt: true };
    }
  }

  /** Repairs legacy unknown dimensions without overwriting trusted metadata. */
  repairDimensions(photoId: string, width: number, height: number): boolean {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError('photo dimensions must be positive safe integers');
    }
    return this.db.transaction(() => {
      const repaired = queryGet<{ id: string }>(
        this.db,
        `UPDATE photos SET width = @width, height = @height
         WHERE id = @id AND (width <= 0 OR height <= 0)
         RETURNING id`,
        { id: photoId, width, height },
      );
      if (repaired === undefined) return false;
      markDirty(this.db, photoId);
      return true;
    })();
  }

  /** A successful pixel decode is authoritative across every decodable format.
   * A disagreement is retained as local integrity state for the Inspector. */
  repairGeneratedDimensions(photoId: string, width: number, height: number): boolean {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError('photo dimensions must be positive safe integers');
    }
    return this.db.transaction(() => {
      const current = this.get(photoId);
      if (current === undefined) return false;
      const hasMetadataDimensions = current.width > 0 && current.height > 0;
      const status: DimensionStatus =
        current.dimensionStatus === 'metadata-mismatch' || (hasMetadataDimensions && (current.width !== width || current.height !== height))
          ? 'metadata-mismatch'
          : 'verified';
      const dimensionsChanged = current.width !== width || current.height !== height;
      if (!dimensionsChanged && current.dimensionStatus === status) return false;
      run(this.db, 'UPDATE photos SET width = ?, height = ?, dimension_status = ? WHERE id = ?', width, height, status, photoId);
      if (dimensionsChanged) markDirty(this.db, photoId);
      return true;
    })();
  }

  /** Marks a file whose pixels could not be decoded; local-only diagnostic state. */
  setDimensionStatus(photoId: string, status: DimensionStatus): boolean {
    const changed = queryGet<{ id: string }>(
      this.db,
      `UPDATE photos SET dimension_status = @status
       WHERE id = @id AND dimension_status IS NOT @status
       RETURNING id`,
      { id: photoId, status },
    );
    return changed !== undefined;
  }

  /** Background candidates retain their format/debt eligibility. Explicit IDs
   * select only live image rows for the service to recheck custody before decoding. */
  previewRepairCandidates(contentHashes?: readonly string[], photoIds?: readonly string[]): readonly PhotoRecord[] {
    return queryAll<PhotoRow>(
      this.db,
      `${SELECT}
       WHERE p.deleted_at IS NULL
         AND ((@photoIds IS NOT NULL AND p.file_kind IN ('jpeg', 'png', 'raw', 'heic', 'gif', 'webp')
           AND p.id IN (SELECT value FROM json_each(@photoIds))) OR
           (@photoIds IS NULL AND (EXISTS (SELECT 1 FROM photo_edit_bake_debt d WHERE d.photo_id = p.id) OR p.preview_repair_pending = 1 OR
           ((p.dimension_status = 'legacy' AND p.file_kind IN ('jpeg', 'png', 'raw', 'heic') OR p.file_kind IN ('raw', 'heic'))
             AND COALESCE(l.status, 'local') <> 'offloaded'))))
         AND (@hashes IS NULL OR p.content_hash IN (SELECT value FROM json_each(@hashes)))
       ORDER BY p.imported_at, p.id`,
      {
        hashes: contentHashes === undefined ? null : JSON.stringify(contentHashes),
        photoIds: photoIds === undefined ? null : JSON.stringify(photoIds),
      },
    ).map(toRecord);
  }

  /** Cleared only after authenticated existing previews or a successful bake. */
  clearPreviewRepairDebt(photoId: string): boolean {
    return (
      queryGet<{ id: string }>(
        this.db,
        `UPDATE photos SET preview_repair_pending = 0, preview_missing = 0
         WHERE id = ? AND (preview_repair_pending = 1 OR preview_missing = 1) RETURNING id`,
        photoId,
      ) !== undefined
    );
  }

  /** Authentication, not the upgrade scan queue, establishes availability. */
  setPreviewMissing(photoId: string, missing: boolean): boolean {
    return (
      queryGet<{ id: string }>(
        this.db,
        `UPDATE photos SET preview_missing = @missing
       WHERE id = @id AND preview_missing <> @missing RETURNING id`,
        { id: photoId, missing: missing ? 1 : 0 },
      ) !== undefined
    );
  }

  /** Fills only unknown previewable metadata. Trusted existing values are immutable;
   * a real change dirties the manifest so cloud metadata converges. */
  repairPreviewMetadata(photoId: string, metadata: ExtractedMetadata): boolean {
    const current = this.get(photoId);
    if (current === undefined || (current.fileKind !== 'raw' && current.fileKind !== 'heic')) return false;
    const next = {
      width: current.width,
      height: current.height,
      camera: current.camera ?? metadata.camera,
      lens: current.lens ?? metadata.lens,
      iso: current.iso ?? metadata.iso,
      aperture: current.aperture ?? metadata.aperture,
      shutter: current.shutter ?? metadata.shutter,
      focalLength: current.focalLength ?? metadata.focalLength,
      takenAt: current.takenAt ?? metadata.takenAt,
      gpsLat: current.gpsLat ?? metadata.gpsLat,
      gpsLon: current.gpsLon ?? metadata.gpsLon,
    };
    if (
      next.width === current.width &&
      next.height === current.height &&
      next.camera === current.camera &&
      next.lens === current.lens &&
      next.iso === current.iso &&
      next.aperture === current.aperture &&
      next.shutter === current.shutter &&
      next.focalLength === current.focalLength &&
      next.takenAt === current.takenAt &&
      next.gpsLat === current.gpsLat &&
      next.gpsLon === current.gpsLon
    ) {
      return false;
    }
    runNamed(
      this.db,
      `UPDATE photos SET
         width = @width, height = @height, camera = @camera, lens = @lens,
         iso = @iso, aperture = @aperture, shutter = @shutter,
         focal_length = @focalLength, taken_at = @takenAt,
         gps_lat = @gpsLat, gps_lon = @gpsLon
       WHERE id = @id AND file_kind IN ('raw', 'heic')`,
      { id: photoId, ...next },
    );
    markDirty(this.db, photoId);
    return true;
  }

  /** Records only local derivative/display state; backup metadata stays clean. */
  setPreviewFailure(photoId: string, failure: PreviewFailureReason | null): boolean {
    if (failure === 'deferred-original') throw new Error('deferred preview state is owned by preview repair debt');
    const changed = queryGet<{ id: string }>(
      this.db,
      `UPDATE photos SET preview_failure = @failure
       WHERE id = @id AND preview_failure IS NOT @failure
       RETURNING id`,
      { id: photoId, failure },
    );
    return changed !== undefined;
  }

  /** Soft delete (#120): rows move to Trash, restorable — no
   * blob, ledger, or membership changes (purge is #121's ceremony).
   * Deleted rows leave pendingCount via the JOIN there. */
  softDelete(photoIds: readonly string[]): { readonly deleted: string[]; readonly protected: string[]; readonly missing: string[] } {
    return softDeleteOrdinary(this.db, photoIds);
  }

  /** Bulk Original mutation and duplicate-index invalidation boundary. */
  setOriginal(
    photoIds: readonly string[],
    isOriginal: boolean,
  ): { readonly changed: string[]; readonly unchanged: string[]; readonly missing: string[] } {
    return setOriginalClassification(this.db, photoIds, isOriginal, (photoId) => markDirty(this.db, photoId));
  }

  /** Restore from Trash: favorite/EXIF/ledger status come back
   * untouched; the row re-dirties so the next manifest includes it again. */
  restore(photoIds: readonly string[]): string[] {
    return this.db.transaction(() => {
      const restored: string[] = [];
      for (const photoId of photoIds) {
        const row = queryGet<{ id: string }>(
          this.db,
          `UPDATE photos SET deleted_at = NULL
            WHERE id = @photoId AND deleted_at IS NOT NULL
              AND id IN (SELECT id FROM ordinary_visible_photos)
            RETURNING id`,
          { photoId },
        );
        if (row !== undefined) {
          markDirty(this.db, photoId);
          restored.push(photoId);
        }
      }
      return restored;
    })();
  }

  /** StatusBar totals: live (non-deleted) photo count + bytes. */
  stats(): LibraryStats {
    // Variants share one original (#496): asset byte totals count each content_hash once,
    // and offloaded/excluded bytes count only when every live row on that asset is offloaded/excluded (#1439).
    const sql = `WITH by_asset AS (
      SELECT max(p.bytes) AS bytes, count(*) AS rows,
             sum(CASE WHEN l.status = 'offloaded' THEN 1 ELSE 0 END) AS offloaded_rows,
             sum(CASE WHEN l.coverage = 'excluded' THEN 1 ELSE 0 END) AS excluded_rows,
             sum(CASE WHEN l.coverage = 'excluding' THEN 1 ELSE 0 END) AS excluding_rows
        FROM ordinary_visible_photos p LEFT JOIN sync_ledger l ON l.photo_id = p.id
       WHERE p.deleted_at IS NULL GROUP BY p.content_hash
    ) SELECT sum(rows) AS photos, sum(bytes) AS bytes,
             sum(CASE WHEN offloaded_rows = rows THEN bytes ELSE 0 END) AS offloadedBytes,
             sum(excluded_rows) AS excludedCount,
             sum(CASE WHEN excluded_rows = rows THEN bytes ELSE 0 END) AS excludedBytes,
             sum(excluding_rows) AS pendingRemovals FROM by_asset`;
    const row = queryAll<{
      photos: number | null;
      bytes: number | null;
      offloadedBytes: number | null;
      excludedCount: number | null;
      excludedBytes: number | null;
      pendingRemovals: number | null;
    }>(this.db, sql)[0];
    const lastBackupAt =
      queryAll<{ at: string | null }>(
        this.db,
        `SELECT max(l.last_backup_at) AS at FROM sync_ledger l JOIN ordinary_visible_photos p ON p.id = l.photo_id`,
      )[0]?.at ?? null;
    return {
      photos: row?.photos ?? 0,
      bytes: row?.bytes ?? 0,
      pending: this.pendingCount(),
      lastBackupAt,
      offloadedBytes: row?.offloadedBytes ?? 0,
      excludedCount: row?.excludedCount ?? 0,
      excludedBytes: row?.excludedBytes ?? 0,
      pendingRemovals: row?.pendingRemovals ?? 0,
    };
  }

  /** Dedupe primitive (#84): does this content already live in the library?
   *  Deleted-but-unpurged photos still own their blobs, so no deleted_at
   *  filter — re-importing them is still "not new". */
  hasContentHash(contentHash: string): boolean {
    return (
      queryGet<{ one: number }>(this.db, 'SELECT 1 AS one FROM ordinary_visible_photos WHERE content_hash = ? LIMIT 1', contentHash) !==
      undefined
    );
  }

  /** Sidebar albums list (#80): names + live membership counts. */
  albums(): AlbumListing[] {
    return readAlbumListings(this.db);
  }

  albumOrder(): string[] {
    return readAlbumOrder(this.db);
  }

  /** Replaces the complete ordinary-album order atomically. The exact-set
   * check prevents a stale renderer from dropping a concurrently-added row. */
  setAlbumOrder(order: readonly string[]): AlbumOrderResult {
    return replaceAlbumOrder(this.db, order);
  }

  reorderAlbum(albumId: string, position: number): ReturnType<typeof moveAlbum> {
    return moveAlbum(this.db, albumId, position);
  }

  /** Album members — the rows an album edit dirties (manifest-relevant
   * per ADR-0007). */
  albumMembers(albumId: string): string[] {
    return queryAll<{ photo_id: string }>(
      this.db,
      `SELECT ap.photo_id FROM album_photos ap
        JOIN ordinary_visible_photos p ON p.id = ap.photo_id
       WHERE ap.album_id = @albumId ORDER BY ap.position`,
      { albumId },
    ).map((row) => row.photo_id);
  }

  albumForProtection(albumId: string):
    | {
        readonly id: string;
        readonly name: string;
        readonly createdAt: string;
        readonly position: number;
        readonly showInAllPhotos: boolean;
        readonly photoIds: readonly string[];
        readonly organization: {
          readonly parentId: string | null;
          readonly inheritsVisibility: boolean;
          readonly siblingPosition: number;
          readonly tags: readonly string[];
        };
      }
    | undefined {
    const album = queryGet<{ id: string; name: string; createdAt: string; position: number; showInAllPhotos: number }>(
      this.db,
      `SELECT id, name, created_at AS createdAt, position, show_in_all_photos AS showInAllPhotos FROM albums WHERE id = ? AND kind = 'album'`,
      albumId,
    );
    if (album === undefined) return undefined;
    const tree = readAlbumTree(this.db);
    const node = tree.find((row) => row.id === albumId)!;
    return {
      ...album,
      showInAllPhotos: album.showInAllPhotos === 1,
      photoIds: this.albumMembers(albumId),
      organization: {
        parentId: node.parentId,
        inheritsVisibility: node.inheritsVisibility,
        siblingPosition: tree.filter((row) => row.parentId === node.parentId).findIndex((row) => row.id === albumId),
        tags: readAlbumTags(this.db).get(albumId) ?? [],
      },
    };
  }

  /** Albums CRUD (#117). Deleting an album NEVER deletes photos — the
   * CASCADE clears membership only (Clear-vs-Delete language rules). */
  createAlbum(
    id: string,
    name: string,
    placement?: { readonly kind?: 'album' | 'folder'; readonly parentId?: string | null },
  ): AlbumListing {
    createCollection(this.db, { id, name, kind: placement?.kind ?? 'album', parentId: placement?.parentId ?? null });
    const album = this.albums().find((listing) => listing.id === id);
    if (album === undefined) throw new Error(`album ${id} was not created`);
    return album;
  }

  /** Renames; returns the members to re-manifest. */
  renameAlbum(albumId: string, name: string): string[] {
    return this.db.transaction(() => {
      const updated = queryGet<{ id: string }>(this.db, 'UPDATE albums SET name = ? WHERE id = ? RETURNING id', name, albumId);
      if (updated === undefined) {
        throw new Error(`album ${albumId} does not exist`);
      }
      const members = this.albumMembers(albumId);
      for (const photoId of members) {
        markDirty(this.db, photoId);
      }
      return members;
    })();
  }

  /** Deletes the album row; membership cascades, photos stay. Returns the
   * (former) members to re-manifest. */
  deleteAlbum(albumId: string): string[] {
    return this.db.transaction(() => {
      const members = this.albumMembers(albumId);
      const deleted = queryGet<{ id: string }>(this.db, 'DELETE FROM albums WHERE id = ? RETURNING id', albumId);
      if (deleted === undefined) {
        throw new Error(`album ${albumId} does not exist`);
      }
      for (const photoId of members) {
        markDirty(this.db, photoId);
      }
      refreshInAllPhotos(this.db, members);
      return members;
    })();
  }

  /** Adds photos (idempotent — re-adds are ignored); returns the ids that
   * actually joined, each dirtied for the next manifest. */
  addToAlbum(albumId: string, photoIds: readonly string[]): string[] {
    return this.db.transaction(() => {
      if (queryGet<{ one: number }>(this.db, `SELECT 1 AS one FROM albums WHERE id = ? AND kind = 'album'`, albumId) === undefined) {
        throw new Error(`album ${albumId} does not exist`);
      }
      const added: string[] = [];
      for (const photoId of photoIds) {
        const inserted = queryGet<{ photo_id: string }>(
          this.db,
          `INSERT OR IGNORE INTO album_photos (album_id, photo_id, position)
           SELECT @albumId, @photoId, (SELECT COALESCE(max(position) + 1, 0) FROM album_photos WHERE album_id = @albumId)
            WHERE EXISTS (SELECT 1 FROM ordinary_visible_photos WHERE id = @photoId)
           RETURNING photo_id`,
          { albumId, photoId },
        );
        if (inserted !== undefined) {
          markDirty(this.db, photoId);
          added.push(photoId);
        }
      }
      refreshInAllPhotos(this.db, added);
      return added;
    })();
  }

  /** Removes photos from an album (photos stay in the library). */
  removeFromAlbum(albumId: string, photoIds: readonly string[]): string[] {
    return this.db.transaction(() => {
      const removed: string[] = [];
      for (const photoId of photoIds) {
        const gone = queryGet<{ photo_id: string }>(
          this.db,
          `DELETE FROM album_photos
            WHERE album_id = @albumId AND photo_id = @photoId
              AND photo_id IN (SELECT id FROM ordinary_visible_photos)
            RETURNING photo_id`,
          { albumId, photoId },
        );
        if (gone !== undefined) {
          markDirty(this.db, photoId);
          removed.push(photoId);
        }
      }
      refreshInAllPhotos(this.db, removed);
      return removed;
    })();
  }

  /** Moves memberships atomically: the target row is present before the
   * source row is removed, and each moved photo is dirtied exactly once. */
  moveBetweenAlbums(
    sourceAlbumId: string,
    targetAlbumId: string,
    photoIds: readonly string[],
  ): { moved: string[]; alreadyInTarget: number } {
    return this.db.transaction(() => {
      if (sourceAlbumId === targetAlbumId) throw new Error('source and target albums must differ');
      for (const albumId of [sourceAlbumId, targetAlbumId]) {
        if (queryGet<{ one: number }>(this.db, `SELECT 1 AS one FROM albums WHERE id = ? AND kind = 'album'`, albumId) === undefined) {
          throw new Error(`album ${albumId} does not exist`);
        }
      }
      const moved: string[] = [];
      let alreadyInTarget = 0;
      for (const photoId of photoIds) {
        const sourceMember = queryGet<{ one: number }>(
          this.db,
          `SELECT 1 AS one FROM album_photos ap
             JOIN ordinary_visible_photos p ON p.id = ap.photo_id
            WHERE ap.album_id = @sourceAlbumId AND ap.photo_id = @photoId`,
          { sourceAlbumId, photoId },
        );
        if (sourceMember === undefined) continue;
        const inserted = queryGet<{ photo_id: string }>(
          this.db,
          `INSERT OR IGNORE INTO album_photos (album_id, photo_id, position)
           VALUES (@targetAlbumId, @photoId, (SELECT COALESCE(max(position) + 1, 0) FROM album_photos WHERE album_id = @targetAlbumId))
           RETURNING photo_id`,
          { targetAlbumId, photoId },
        );
        if (inserted === undefined) alreadyInTarget += 1;
        runNamed(this.db, 'DELETE FROM album_photos WHERE album_id = @sourceAlbumId AND photo_id = @photoId', { sourceAlbumId, photoId });
        markDirty(this.db, photoId);
        moved.push(photoId);
      }
      refreshInAllPhotos(this.db, moved);
      return { moved, alreadyInTarget };
    })();
  }

  /** Purge candidates only (#121): the row, iff it is soft-deleted. */
  getDeleted(photoId: string): PhotoRecord | undefined {
    const row = this.get(photoId);
    return row !== undefined && row.deletedAt !== null ? row : undefined;
  }

  /** Soft-deleted at or beyond the retention window (#121's auto-purge). */
  expiredDeleted(cutoffIso: string): string[] {
    return queryAll<{ id: string }>(
      this.db,
      'SELECT id FROM ordinary_visible_photos WHERE deleted_at IS NOT NULL AND deleted_at <= @cutoff AND is_original = 0',
      { cutoff: cutoffIso },
    ).map((row) => row.id);
  }

  /** Removes the DB row (ledger + membership CASCADE). Deleted rows only —
   * a live row can never be purged, only soft-deleted first. */
  purgeRow(photoId: string): void {
    const gone = queryGet<{ id: string }>(
      this.db,
      `DELETE FROM photos
        WHERE id = ? AND deleted_at IS NOT NULL AND is_original = 0
          AND id IN (SELECT id FROM ordinary_visible_photos)
        RETURNING id`,
      photoId,
    );
    if (gone === undefined) {
      throw new Error(`photo ${photoId} is not in Trash`);
    }
  }

  /** Main-authorized Shift+Delete boundary (#482). The caller must complete
   * the protected-Original ceremony before reaching this method. */
  purgeRowAuthorized(photoId: string): void {
    const gone = queryGet<{ id: string }>(
      this.db,
      `DELETE FROM photos
        WHERE id = ? AND id IN (SELECT id FROM ordinary_visible_photos)
        RETURNING id`,
      photoId,
    );
    if (gone === undefined) throw new Error(`photo ${photoId} is unavailable`);
  }

  /** Blob-ownership count for PURGE (#121): every remaining row on this
   * hash, deleted or not — soft-deleted twins still own their blobs. */
  countAnyByContentHash(contentHash: string): number {
    return (
      queryAll<{ n: number }>(this.db, 'SELECT count(*) AS n FROM photos WHERE content_hash = @hash', { hash: contentHash })[0]?.n ?? 0
    );
  }

  /** Ordinary consistency rows only. Hidden migration custody is supplied
   * separately as ownership-only hashes so it can never enter reports. */
  allRows(): readonly { id: string; contentHash: string; syncState: string; derivativeKey: string }[] {
    return queryAll<{ id: string; content_hash: string; derivative_key: string; status: string | null }>(
      this.db,
      `SELECT p.id, p.content_hash, p.derivative_key, l.status
         FROM ordinary_visible_photos p LEFT JOIN sync_ledger l ON l.photo_id = p.id`,
    ).map((row) => ({ id: row.id, contentHash: row.content_hash, derivativeKey: row.derivative_key, syncState: row.status ?? 'local' }));
  }

  /** Ordinary blob references held by an in-flight protected migration.
   * Values protect live custody from orphan cleanup but are never surfaced as
   * rows, diagnostics, events, or audit identifiers. */
  migrationOwnedContentHashes(): readonly string[] {
    return queryAll<{ contentHash: string }>(
      this.db,
      `SELECT DISTINCT CASE journal.operation
         WHEN 'protect' THEN item.source_blob_ref
         ELSE item.target_blob_ref
       END AS contentHash
       FROM protected_photo_migration_items item
       JOIN protected_photo_migrations journal ON journal.migration_id = item.migration_id
       WHERE journal.operation IN ('protect', 'unprotect')`,
    ).map((row) => row.contentHash);
  }

  /** A migration journal temporarily owns both the ordinary and protected
   * representations. Egress must stay closed until the journal is purged. */
  isInProtectedMigration(photoId: string): boolean {
    return (
      queryGet<{ present: number }>(
        this.db,
        'SELECT 1 AS present FROM protected_photo_migration_items WHERE photo_id = ? LIMIT 1',
        photoId,
      ) !== undefined
    );
  }

  /** Shared-hash guard for offload (#107): live photos on this hash. */
  countByContentHash(contentHash: string): number {
    return (
      queryAll<{ n: number }>(this.db, 'SELECT count(*) AS n FROM photos WHERE content_hash = @hash AND deleted_at IS NULL', {
        hash: contentHash,
      })[0]?.n ?? 0
    );
  }

  /** Live originals managed from Settings; deleted rows retain their
   * existing recovery policy and are not silently resurrected. */
  offloadedPhotoIds(): string[] {
    return queryAll<{ id: string }>(
      this.db,
      `SELECT p.id
         FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id
        WHERE p.deleted_at IS NULL AND l.status = 'offloaded'
        ORDER BY p.imported_at, p.id`,
    ).map(({ id }) => id);
  }

  manifestSnapshot(): ReturnType<typeof readManifestSnapshot> {
    return readManifestSnapshot(this.db, toRecord);
  }

  /** Rebuilds a fresh catalog from a verified manifest (#288). The staged
   * DB must be empty: merge semantics could retain local-only rows and turn
   * disaster recovery into silent data loss. All restored originals are
   * already verified remote copies, so their ledgers start clean + synced —
   * except NOT FOUND originals from a partial restore (#915), whose rows
   * survive with ledger status 'error' so the loss stays visible. */
  restoreManifest(manifest: RestorableBackupManifest, keys: readonly WrappedKeyRecord[], missingPhotoIds?: ReadonlySet<string>): void {
    restoreManifestFromBackup(this.db, manifest, keys, missingPhotoIds);
  }

  /** The backup queue's input (#105): dirty, not-deleted, included photos.
   * Excluded and locked rows never enter the queue, dirty or not. */
  dirtyPhotos(): readonly { id: string; contentHash: string; bytes: number; fileName: string; keyId: number; status: SyncStatus }[] {
    // status rides along so the engine never re-queries the ledger per item
    // (two status lookups × 94K dirty rows stalled the 113K-import sweep).
    return queryAll<{ id: string; contentHash: string; bytes: number; fileName: string; keyId: number; status: SyncStatus }>(
      this.db,
      `SELECT p.id, p.content_hash AS contentHash, p.bytes, p.file_name AS fileName, p.key_id AS keyId, l.status AS status
         FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id
        WHERE l.dirty = 1 AND l.coverage = 'included' AND p.deleted_at IS NULL
          AND NOT (${PHOTO_HAS_ABSENT_KEY_SQL})
        ORDER BY p.imported_at, p.id`,
    );
  }

  /** Stable keyset page over rows whose remote-copy claim must remain true.
   * Deleted-but-retained photos are included because recovery still promises
   * their original until permanent purge. */
  integrityItems(
    page: { readonly afterId: string | null; readonly limit: number },
    scope?: { readonly syncState: 'synced' } | { readonly custodyAuthorityId: number } | { readonly legacyUnbound: true },
  ): readonly BackupIntegrityItem[] {
    return queryAll<BackupIntegrityItem>(
      this.db,
      `SELECT p.id, p.asset_owner_id AS assetOwnerId, p.content_hash AS contentHash, l.status AS syncState
         FROM ordinary_visible_photos p
         JOIN sync_ledger l ON l.photo_id = p.id
        WHERE (
            (@legacyUnbound = 0 AND l.status IN ('synced', 'offloaded'))
            OR (@custodyAuthorityId IS NOT NULL AND l.status = 'error' AND l.dirty = 0)
            OR (@legacyUnbound = 1 AND (l.status = 'offloaded' OR (l.status = 'error' AND l.dirty = 0)))
          )
          AND (@syncState IS NULL OR l.status = @syncState)
          AND (@custodyAuthorityId IS NULL OR l.custody_authority_id = @custodyAuthorityId)
          AND (@legacyUnbound = 0 OR l.custody_authority_id IS NULL)
          AND l.coverage = 'included'
          AND NOT (${PHOTO_HAS_ABSENT_KEY_SQL})
          AND (@afterId IS NULL OR p.id > @afterId)
        ORDER BY p.id
        LIMIT @limit`,
      {
        afterId: page.afterId,
        limit: page.limit,
        syncState: scope !== undefined && 'syncState' in scope ? scope.syncState : null,
        custodyAuthorityId: scope !== undefined && 'custodyAuthorityId' in scope ? scope.custodyAuthorityId : null,
        legacyUnbound: scope !== undefined && 'legacyUnbound' in scope ? 1 : 0,
      },
    );
  }

  /** pendingCount source: dirty ledger rows (design §backup dirtiness). */
  pendingCount(): number {
    // Deleted rows leave the pending count (#120): they neither upload
    // (dirtyPhotos filters them) nor belong in provider upload progress.
    return (
      queryAll<{ n: number }>(
        this.db,
        `SELECT count(*) AS n FROM sync_ledger l JOIN ordinary_visible_photos p ON p.id = l.photo_id
          WHERE l.dirty = 1 AND l.coverage = 'included' AND p.deleted_at IS NULL
            AND NOT (${PHOTO_HAS_ABSENT_KEY_SQL})`,
      )[0]?.n ?? 0
    );
  }

  /** Sidebar counts share page()'s sourceWhere — ONE query truth per
   * source, so counts and grid results cannot drift (#119; the mock's
   * fall-through gap, fixed by construction). Single pass over the join
   * with FILTER clauses (#124): five separate counts cost ~690ms at 200K;
   * one scan serves them all. */
  counts(recentSince: string): SourceCounts {
    const policy = this.galleryPolicy();
    const sources = ['favorites', 'recent', 'raw', 'offloaded', 'unavailable', 'deleted'] as const;
    // All Photos counts through allPhotosWhere — the same clause page() uses
    // when inclusion rules are active (#512, ADR-0030 §6) — and `unfiltered`
    // exists only to disclose how many rows those rules hide.
    const filters = [
      `count(*) FILTER (WHERE ${allPhotosWhere(policy)}) AS "all"`,
      `count(*) FILTER (WHERE ${ALL_PHOTOS_MEMBERSHIP_WHERE}) AS "unfiltered"`,
      `count(*) FILTER (WHERE ${sourceWhere('all')} AND ${HIDDEN_BY_ALBUMS_WHERE}) AS "hiddenByAlbums"`,
      ...sources.map((source) => `count(*) FILTER (WHERE ${sourceWhere(source)}) AS "${source}"`),
    ].join(', ');
    const row = queryAll<Record<(typeof sources)[number] | 'all' | 'unfiltered' | 'hiddenByAlbums', number>>(
      this.db,
      `SELECT ${filters} FROM ordinary_visible_photos p LEFT JOIN sync_ledger l ON l.photo_id = p.id`,
      { recentSince, ...inclusionParams(policy) },
    )[0];
    const all = row?.all ?? 0;
    return {
      all,
      favorites: row?.favorites ?? 0,
      recent: row?.recent ?? 0,
      raw: row?.raw ?? 0,
      offloaded: row?.offloaded ?? 0,
      unavailable: row?.unavailable ?? 0,
      deleted: row?.deleted ?? 0,
      excluded: Math.max(0, (row?.unfiltered ?? 0) - all),
      hiddenByAlbums: row?.hiddenByAlbums ?? 0,
    };
  }

  /** Collection visibility (#494): the policy write and the members' flag
   * refresh share one transaction; returns the photos that changed sides. */
  setAlbumVisibility(albumId: string, showInAllPhotos: boolean): string[] {
    return writeAlbumVisibility(this.db, albumId, showInAllPhotos);
  }

  hiddenAlbumIds(): string[] {
    return readHiddenAlbumIds(this.db);
  }

  /** All Photos inclusion rules (#512) — library data read per query so a
   * Settings change applies to the very next page and count. */
  galleryPolicy(): GalleryPolicy {
    return readGalleryPolicy(this.db);
  }

  setGalleryPolicy(policy: GalleryPolicy): GalleryPolicy {
    return writeGalleryPolicy(this.db, policy);
  }
}

/** Defers verifySearchIndex() to a microtask so a synchronous throw (e.g.
 * the rebuild command itself failing) becomes a rejection instead of
 * escaping the caller uncaught — StartupMaintenance only catches promise
 * rejections, not synchronous throws from the option callback (#390). */
export function verifySearchIndexAsync(db: BetterSqlite3.Database): Promise<{ rebuilt: boolean }> {
  return Promise.resolve().then(() => new PhotosRepository(db).verifySearchIndex());
}
