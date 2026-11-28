import type { PreviewFailureReason } from '../../shared/library/preview.js';
import { parseMediaInfo, type MediaInfo } from '../../shared/library/media-info.js';
import type { DimensionStatus, LocalCustodyFailure, PhotoRecord } from '../../shared/library/types.js';
import { effectivePhotoTags, normalizePhotoTags } from '../../shared/library/photo-metadata.js';

// The photos row as SQLite returns it and its mapping to the shared record.
// Split from photos-repository.ts so the repository stays under the file
// cap; every reader of photos rows (the repository, variants, exports)
// maps through toRecord.

export interface PhotoRow {
  id: string;
  file_name: string;
  file_kind: string;
  width: number;
  height: number;
  bytes: number;
  content_hash: string;
  derivative_key: string;
  variant_source_id: string | null;
  asset_owner_id: string | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  focal_length: number | null;
  taken_at: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  place: string | null;
  imported_at: string;
  import_source: string;
  favorite: number;
  is_original: number;
  key_id: number;
  deleted_at: string | null;
  preview_failure: string | null;
  preview_missing?: number;
  original_failure?: 'missing-original' | null;
  local_custody_failure?: LocalCustodyFailure | null;
  dimension_status: string;
  media_info: string | null;
  sync_state: string | null;
  coverage: string | null;
  /** keys.material_present through the keyring join (#517); null = no row. */
  key_present: number | null;
  missing_key_id?: number | null;
  user_title: string | null;
  user_description: string | null;
  imported_keywords: string;
  user_tags: string;
  suppressed_keywords: string;
  metadata_version: number;
  sort_key: string | number;
}

function tagsFromJson(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return normalizePhotoTags(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
}

/** Serializes probed facts for the media_info JSON column. */
export function mediaInfoJson(mediaInfo: MediaInfo | null | undefined): string | null {
  return mediaInfo === null || mediaInfo === undefined ? null : JSON.stringify(mediaInfo);
}

export function toRecord(row: PhotoRow): PhotoRecord {
  const importedKeywords = tagsFromJson(row.imported_keywords);
  const userTags = tagsFromJson(row.user_tags);
  const suppressedKeywords = tagsFromJson(row.suppressed_keywords);
  return {
    id: row.id,
    fileName: row.file_name,
    fileKind: row.file_kind as PhotoRecord['fileKind'],
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    contentHash: row.content_hash,
    derivativeKey: row.derivative_key,
    variantSourceId: row.variant_source_id,
    assetOwnerId: row.asset_owner_id,
    camera: row.camera,
    lens: row.lens,
    iso: row.iso,
    aperture: row.aperture,
    shutter: row.shutter,
    focalLength: row.focal_length,
    takenAt: row.taken_at,
    gpsLat: row.gps_lat,
    gpsLon: row.gps_lon,
    place: row.place,
    title: row.user_title,
    description: row.user_description,
    tags: effectivePhotoTags(importedKeywords, userTags, suppressedKeywords),
    userTags,
    importedKeywords,
    suppressedKeywords,
    metadataVersion: row.metadata_version,
    importedAt: row.imported_at,
    importSource: row.import_source,
    favorite: row.favorite === 1,
    isOriginal: row.is_original === 1,
    keyId: row.key_id,
    deletedAt: row.deleted_at,
    previewFailure: (row.preview_failure ?? (row.preview_missing === 1 ? 'deferred-original' : null)) as PreviewFailureReason | null,
    originalFailure: row.original_failure ?? null,
    localCustodyFailure: row.local_custody_failure ?? null,
    dimensionStatus: row.dimension_status as DimensionStatus,
    mediaInfo: parseMediaInfo(row.media_info),
    // New rows always get a ledger row; LEFT JOIN keeps reads total anyway.
    syncState: (row.sync_state ?? 'local') as PhotoRecord['syncState'],
    coverage: (row.coverage ?? 'included') as PhotoRecord['coverage'],
    // ADR-0032 §2: locked is a fact about the key row, never about the photo.
    locked: row.key_present === 0,
    ...(row.missing_key_id == null ? {} : { missingKeyId: row.missing_key_id }),
  };
}
