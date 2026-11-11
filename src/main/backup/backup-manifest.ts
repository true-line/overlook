import type { BackupManifestSidecarV16 } from './backup-manifest-sidecars.js';
import { backupManifestSidecarV6Schema, backupManifestSidecarV16Schema, checkSharedSidecars } from './backup-manifest-sidecars.js';
export { backupManifestSidecarV6Schema } from './backup-manifest-sidecars.js';
import { z } from 'zod';
import { isProtectedBlobKind } from '../blobs/protected-blob-store.js';

import {
  backupManifestEditRevisionV11Schema,
  checkEditRevisionLinks,
  type BackupManifestEditRevisionV11,
} from './backup-manifest-edit-revisions.js';
import { backupManifestProvenanceV12Schema, checkProvenanceLinks, type BackupManifestProvenanceV12 } from './backup-manifest-provenance.js';
import {
  backupManifestVariantFamilyV13Schema,
  checkVariantLinks,
  type BackupManifestVariantFamilyV13,
} from './backup-manifest-variants.js';
import {
  asCarriedRecords,
  backupManifestCoverageV14Schema,
  backupManifestPhotoV14Schema,
  checkCoverageTotals,
  coverageTotals,
  type BackupManifestPhotoV14,
} from './backup-manifest-coverage.js';
import { activityEventTypes } from '../../shared/activity/types.js';
import type { ActivityEvent } from '../../shared/activity/types.js';

import { boardSchema } from '../../shared/moodboard/board.js';
import { galleryPolicySchema } from '../../shared/library/gallery-policy.js';
import { albumTreeIssues } from '../../shared/library/album-tree.js';

import { backupManifestKeyringEntryV15Schema, checkKeyringLinks, type BackupManifestKeyringEntryV15 } from './backup-manifest-keyring.js';

export const BACKUP_MANIFEST_SCHEMA_VERSION = 16 as const;

import {
  backupManifestAlbumV2Schema,
  backupManifestPhotoV2Schema,
  backupManifestPhotoV13Schema,
  backupManifestV1Schema,
  isoTimestampSchema,
  keyIdSchema,
  sha256Schema,
  ulidSchema,
} from './backup-manifest-photo.js';
export {
  backupManifestAlbumV2Schema,
  backupManifestPhotoV2Schema,
  backupManifestPhotoV13Schema,
  backupManifestV1Schema,
} from './backup-manifest-photo.js';

export const backupManifestV2Schema = z
  .strictObject({
    schema: z.literal(2),
    libraryId: ulidSchema,
    databaseSchema: z.number().int().positive(),
    generatedAt: isoTimestampSchema,
    keyIds: z.array(keyIdSchema).readonly(),
    totals: z.strictObject({
      photos: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      albums: z.number().int().nonnegative(),
    }),
    photos: z.array(backupManifestPhotoV2Schema).readonly(),
    albums: z.array(backupManifestAlbumV2Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const keyIds = new Set(manifest.keyIds);
    if (keyIds.size !== manifest.keyIds.length) {
      context.addIssue({ code: 'custom', path: ['keyIds'], message: 'key IDs must be unique' });
    }

    const photoIds = new Set<string>();
    let bytes = 0;
    for (const [index, photo] of manifest.photos.entries()) {
      if (photoIds.has(photo.id)) {
        context.addIssue({ code: 'custom', path: ['photos', index, 'id'], message: 'photo IDs must be unique' });
      }
      photoIds.add(photo.id);
      bytes += photo.bytes;
      if (!keyIds.has(photo.keyId)) {
        context.addIssue({ code: 'custom', path: ['photos', index, 'keyId'], message: 'photo key is missing from keyIds' });
      }
      const expectedPath = `blobs/${photo.contentHash.slice(0, 2)}/${photo.contentHash}`;
      if (photo.blobPath !== expectedPath) {
        context.addIssue({ code: 'custom', path: ['photos', index, 'blobPath'], message: 'blob path does not match the content hash' });
      }
    }

    const albumIds = new Set<string>();
    const albumPositions = new Set<number>();
    for (const [albumIndex, album] of manifest.albums.entries()) {
      if (albumIds.has(album.id)) {
        context.addIssue({ code: 'custom', path: ['albums', albumIndex, 'id'], message: 'album IDs must be unique' });
      }
      albumIds.add(album.id);
      if (albumPositions.has(album.position)) {
        context.addIssue({ code: 'custom', path: ['albums', albumIndex, 'position'], message: 'album positions must be unique' });
      }
      albumPositions.add(album.position);
      const members = new Set<string>();
      for (const [memberIndex, photoId] of album.photoIds.entries()) {
        if (!photoIds.has(photoId)) {
          context.addIssue({
            code: 'custom',
            path: ['albums', albumIndex, 'photoIds', memberIndex],
            message: 'album member is missing from photos',
          });
        }
        if (members.has(photoId)) {
          context.addIssue({
            code: 'custom',
            path: ['albums', albumIndex, 'photoIds', memberIndex],
            message: 'album members must be unique',
          });
        }
        members.add(photoId);
      }
    }

    if (manifest.totals.photos !== manifest.photos.length) {
      context.addIssue({ code: 'custom', path: ['totals', 'photos'], message: 'photo total does not match photos' });
    }
    if (manifest.totals.bytes !== bytes) {
      context.addIssue({ code: 'custom', path: ['totals', 'bytes'], message: 'byte total does not match photos' });
    }
    if (manifest.totals.albums !== manifest.albums.length) {
      context.addIssue({ code: 'custom', path: ['totals', 'albums'], message: 'album total does not match albums' });
    }
  });

const sealedRecordSchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u, 'expected base64');

export const protectedBackupAlbumV3Schema = z.strictObject({
  id: z.string().min(1),
  credentialGeneration: z.number().int().positive(),
  metadataGeneration: z.number().int().positive(),
  credentialRecord: sealedRecordSchema,
  sealedMetadata: sealedRecordSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const protectedBackupObjectV3Schema = z.strictObject({
  kind: z.string().refine(isProtectedBlobKind, 'invalid protected object kind'),
  path: z.string().min(1),
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative(),
  status: z.enum(['synced', 'offloaded']),
});

export const protectedBackupPhotoV3Schema = z.strictObject({
  id: z.string().min(1),
  albumId: z.string().min(1),
  blobRef: sha256Schema,
  sealedMetadata: sealedRecordSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  objects: z.array(protectedBackupObjectV3Schema).min(1).readonly(),
});

export const backupManifestV3Schema = z
  .strictObject({
    schema: z.literal(3),
    libraryId: ulidSchema,
    databaseSchema: z.number().int().positive(),
    generatedAt: isoTimestampSchema,
    keyIds: z.array(keyIdSchema).readonly(),
    totals: backupManifestV2Schema.shape.totals,
    photos: z.array(backupManifestPhotoV2Schema).readonly(),
    albums: z.array(backupManifestAlbumV2Schema).readonly(),
    protectedAlbums: z.array(protectedBackupAlbumV3Schema).readonly(),
    protectedPhotos: z.array(protectedBackupPhotoV3Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const ordinary = backupManifestV2Schema.safeParse({
      schema: 2,
      libraryId: manifest.libraryId,
      databaseSchema: manifest.databaseSchema,
      generatedAt: manifest.generatedAt,
      keyIds: manifest.keyIds,
      totals: manifest.totals,
      photos: manifest.photos,
      albums: manifest.albums,
    });
    if (!ordinary.success) {
      context.addIssue({ code: 'custom', message: `ordinary recovery records are inconsistent: ${z.prettifyError(ordinary.error)}` });
    }
    const albumIds = new Set<string>();
    for (const [index, album] of manifest.protectedAlbums.entries()) {
      if (albumIds.has(album.id))
        context.addIssue({ code: 'custom', path: ['protectedAlbums', index, 'id'], message: 'protected album IDs must be unique' });
      albumIds.add(album.id);
    }
    const photoIds = new Set<string>();
    const remotePaths = new Map<string, { readonly sha256: string; readonly bytes: number }>();
    for (const [photoIndex, photo] of manifest.protectedPhotos.entries()) {
      if (photoIds.has(photo.id)) {
        context.addIssue({ code: 'custom', path: ['protectedPhotos', photoIndex, 'id'], message: 'protected photo IDs must be unique' });
      }
      photoIds.add(photo.id);
      if (!albumIds.has(photo.albumId)) {
        context.addIssue({ code: 'custom', path: ['protectedPhotos', photoIndex, 'albumId'], message: 'protected album is missing' });
      }
      const kinds = new Set<string>();
      for (const [objectIndex, object] of photo.objects.entries()) {
        if (kinds.has(object.kind)) {
          context.addIssue({
            code: 'custom',
            path: ['protectedPhotos', photoIndex, 'objects', objectIndex, 'kind'],
            message: 'protected object kinds must be unique per photo',
          });
        }
        kinds.add(object.kind);
        const expectedPath = `protected/${photo.blobRef.slice(0, 2)}/${photo.blobRef}.${object.kind}`;
        if (object.path !== expectedPath) {
          context.addIssue({
            code: 'custom',
            path: ['protectedPhotos', photoIndex, 'objects', objectIndex, 'path'],
            message: 'protected object path does not match its opaque reference',
          });
        }
        const previous = remotePaths.get(object.path);
        if (previous !== undefined && (previous.sha256 !== object.sha256 || previous.bytes !== object.bytes)) {
          context.addIssue({
            code: 'custom',
            path: ['protectedPhotos', photoIndex, 'objects', objectIndex, 'path'],
            message: 'shared protected object claims must agree',
          });
        }
        remotePaths.set(object.path, object);
      }
      if (!kinds.has('original')) {
        context.addIssue({
          code: 'custom',
          path: ['protectedPhotos', photoIndex, 'objects'],
          message: 'protected photo requires an original',
        });
      }
    }
  });

const activityPayloadValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const backupActivityEventV4Schema = z.strictObject({
  sequence: z.number().int().positive(),
  eventId: z.string().min(1),
  operationId: z.string().min(1),
  eventType: z.enum(activityEventTypes),
  schemaVersion: z.literal(1),
  occurredAt: isoTimestampSchema,
  actorClass: z.enum(['local-user', 'system', 'interop-peer', 'recovery']),
  rootCorrelationId: z.string().min(1),
  causationEventId: z.string().nullable(),
  entityIds: z.array(z.string()).readonly(),
  outcome: z.enum(['succeeded', 'partial', 'failed']),
  payload: z.record(z.string(), activityPayloadValueSchema).readonly(),
  supersedesEventId: z.string().nullable(),
});

export const backupManifestV4Schema = z
  .strictObject({
    ...backupManifestV3Schema.shape,
    schema: z.literal(4),
    activity: z.array(backupActivityEventV4Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { activity: _activity, ...withoutActivity } = manifest;
    const previous = backupManifestV3Schema.safeParse({ ...withoutActivity, schema: 3 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-3 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    let priorSequence = 0;
    const eventIds = new Set<string>();
    for (const [index, event] of manifest.activity.entries()) {
      if (event.sequence <= priorSequence) {
        context.addIssue({ code: 'custom', path: ['activity', index, 'sequence'], message: 'activity sequence must increase' });
      }
      if (eventIds.has(event.eventId)) {
        context.addIssue({ code: 'custom', path: ['activity', index, 'eventId'], message: 'activity event IDs must be unique' });
      }
      priorSequence = event.sequence;
      eventIds.add(event.eventId);
    }
  });

// Moodboard boards (#701): album-class organizational metadata carried in the
// manifest with their ordering/identity, so a restore reproduces the exact
// board layouts (invariant I2 across backup/restore).
export const backupManifestBoardV5Schema = boardSchema.extend({
  position: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
});

export const backupManifestV5Schema = z
  .strictObject({
    ...backupManifestV4Schema.shape,
    schema: z.literal(5),
    boards: z.array(backupManifestBoardV5Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { boards, ...withoutBoards } = manifest;
    const previous = backupManifestV4Schema.safeParse({ ...withoutBoards, schema: 4 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-4 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    const ids = new Set<string>();
    const positions = new Set<number>();
    for (const [index, board] of boards.entries()) {
      if (ids.has(board.id)) context.addIssue({ code: 'custom', path: ['boards', index, 'id'], message: 'board IDs must be unique' });
      if (positions.has(board.position)) {
        context.addIssue({ code: 'custom', path: ['boards', index, 'position'], message: 'board positions must be unique' });
      }
      ids.add(board.id);
      positions.add(board.position);
    }
  });

// Encrypted sidecar custody (#484, ADR-0031 §7): manifests include every
// companion object so restore rebuilds byte-identical sidecars. Objects live
// at sidecars/<photoId>/<hash>; sha256/bytes describe the CIPHERTEXT (like
// protected objects — verify-after-upload has no plaintext catalog hash for
// the envelope itself; the plaintext hash IS `hash`).

export const backupManifestV6Schema = z
  .strictObject({
    ...backupManifestV5Schema.shape,
    schema: z.literal(6),
    sidecars: z.array(backupManifestSidecarV6Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { sidecars, ...withoutSidecars } = manifest;
    const previous = backupManifestV5Schema.safeParse({ ...withoutSidecars, schema: 5 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-5 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    const photoIds = new Set(manifest.photos.map((photo) => photo.id));
    const seen = new Set<string>();
    for (const [index, sidecar] of sidecars.entries()) {
      if (!photoIds.has(sidecar.photoId)) {
        context.addIssue({
          code: 'custom',
          path: ['sidecars', index, 'photoId'],
          message: 'sidecar references a photo not in the manifest',
        });
      }
      const key = `${sidecar.photoId}:${sidecar.hash}`;
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', path: ['sidecars', index], message: 'duplicate sidecar object' });
      }
      seen.add(key);
      if (sidecar.blobPath !== `sidecars/${sidecar.photoId}/${sidecar.hash}`) {
        context.addIssue({
          code: 'custom',
          path: ['sidecars', index, 'blobPath'],
          message: 'sidecar blobPath must derive from photoId and hash',
        });
      }
    }
  });

// All Photos inclusion rules (#512, ADR-0030 §5): library data, so a restored
// library shows exactly what the backed-up one showed.
export const backupManifestV7Schema = z
  .strictObject({
    ...backupManifestV6Schema.shape,
    schema: z.literal(7),
    galleryPolicy: galleryPolicySchema.strict(),
  })
  .superRefine((manifest, context) => {
    const { galleryPolicy: _galleryPolicy, ...withoutPolicy } = manifest;
    const previous = backupManifestV6Schema.safeParse({ ...withoutPolicy, schema: 6 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-6 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
  });

// Collection visibility (#494, ADR-0030 §5/§7): the albums hidden from All
// Photos travel as library data; the per-photo flag never does — restore
// rebuilds it from the rows.
export const backupManifestV8Schema = z
  .strictObject({
    ...backupManifestV7Schema.shape,
    schema: z.literal(8),
    hiddenAlbumIds: z.array(z.string().min(1)).readonly(),
  })
  .superRefine((manifest, context) => {
    const { hiddenAlbumIds, ...withoutVisibility } = manifest;
    const previous = backupManifestV7Schema.safeParse({ ...withoutVisibility, schema: 7 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-7 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    const albumIds = new Set(manifest.albums.map((album) => album.id));
    const seen = new Set<string>();
    for (const [index, albumId] of hiddenAlbumIds.entries()) {
      if (!albumIds.has(albumId)) {
        context.addIssue({ code: 'custom', path: ['hiddenAlbumIds', index], message: 'hidden album is not in albums' });
      }
      if (seen.has(albumId)) context.addIssue({ code: 'custom', path: ['hiddenAlbumIds', index], message: 'duplicate hidden album' });
      seen.add(albumId);
    }
  });

// Album folders and organizational tags (#505, ADR-0030 §1/§5/§7): the tree
// is library data. Restore validates it here — parents resolve to folders,
// no cycles, bounded depth, unique positions among siblings — before any
// row is written. Folders carry their own policy; albums carry whether they
// follow their folder's. Tags travel by name in their own vocabulary.
const collectionTagsSchema = z.array(z.string().min(1)).readonly();
export const backupManifestFolderV9Schema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: isoTimestampSchema,
  position: z.number().int().nonnegative(),
  parentId: z.string().min(1).nullable(),
  showInAllPhotos: z.boolean(),
  tags: collectionTagsSchema,
});
export const backupManifestAlbumPlacementV9Schema = z.strictObject({
  albumId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  inheritsVisibility: z.boolean(),
  tags: collectionTagsSchema,
});
export const backupManifestV9Schema = z
  .strictObject({
    ...backupManifestV8Schema.shape,
    schema: z.literal(9),
    folders: z.array(backupManifestFolderV9Schema).readonly(),
    albumTree: z.array(backupManifestAlbumPlacementV9Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { folders: _folders, albumTree: _albumTree, ...withoutTree } = manifest;
    const previous = backupManifestV8Schema.safeParse({ ...withoutTree, schema: 8 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-8 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    const albumIds = new Set(manifest.albums.map((album) => album.id));
    const placed = new Set<string>();
    for (const [index, placement] of manifest.albumTree.entries()) {
      if (!albumIds.has(placement.albumId))
        context.addIssue({ code: 'custom', path: ['albumTree', index], message: 'placement names no album' });
      if (placed.has(placement.albumId)) context.addIssue({ code: 'custom', path: ['albumTree', index], message: 'album placed twice' });
      if (placement.inheritsVisibility && placement.parentId === null) {
        context.addIssue({ code: 'custom', path: ['albumTree', index], message: 'a top-level album has no folder to inherit from' });
      }
      placed.add(placement.albumId);
    }
    if (placed.size !== albumIds.size) context.addIssue({ code: 'custom', path: ['albumTree'], message: 'every album needs a placement' });
    for (const [index, folder] of manifest.folders.entries()) {
      if (albumIds.has(folder.id))
        context.addIssue({ code: 'custom', path: ['folders', index], message: 'folder id collides with an album' });
    }
    const albumPositions = new Map(manifest.albums.map((album) => [album.id, album.position]));
    for (const issue of albumTreeIssues([
      ...manifest.folders.map((folder) => ({
        id: folder.id,
        kind: 'folder' as const,
        parentId: folder.parentId,
        position: folder.position,
      })),
      ...manifest.albumTree.map((placement) => ({
        id: placement.albumId,
        kind: 'album' as const,
        parentId: placement.parentId,
        position: albumPositions.get(placement.albumId) ?? -1,
      })),
    ])) {
      context.addIssue({ code: 'custom', path: ['folders'], message: issue });
    }
  });

// Smart Albums (#514, ADR-0030 §3/§5): saved predicates are library data.
// The manifest carries each document as written; restore validates that it
// is a versioned document and that its placement fits the tree, and a
// document this app cannot evaluate is preserved and marked unsupported
// rather than rejected — a backup is never refused for being newer.
export const backupManifestSmartAlbumV10Schema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: isoTimestampSchema,
  position: z.number().int().nonnegative(),
  parentId: z.string().min(1).nullable(),
  predicate: z
    .record(z.string(), z.unknown())
    .refine((document) => typeof document['version'] === 'number' && Number.isInteger(document['version']) && document['version'] >= 1, {
      message: 'predicate needs an integer version',
    }),
  tags: collectionTagsSchema,
});
export const backupManifestV10Schema = z
  .strictObject({
    ...backupManifestV9Schema.shape,
    schema: z.literal(10),
    smartAlbums: z.array(backupManifestSmartAlbumV10Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { smartAlbums: _smartAlbums, ...withoutSmart } = manifest;
    const previous = backupManifestV9Schema.safeParse({ ...withoutSmart, schema: 9 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-9 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    const taken = new Set([...manifest.albums.map((album) => album.id), ...manifest.folders.map((folder) => folder.id)]);
    for (const [index, smart] of manifest.smartAlbums.entries()) {
      if (taken.has(smart.id))
        context.addIssue({ code: 'custom', path: ['smartAlbums', index], message: 'smart album id collides with a collection' });
      taken.add(smart.id);
    }
    const albumPositions = new Map(manifest.albums.map((album) => [album.id, album.position]));
    for (const issue of albumTreeIssues([
      ...manifest.folders.map((folder) => ({
        id: folder.id,
        kind: 'folder' as const,
        parentId: folder.parentId,
        position: folder.position,
      })),
      ...manifest.albumTree.map((placement) => ({
        id: placement.albumId,
        kind: 'album' as const,
        parentId: placement.parentId,
        position: albumPositions.get(placement.albumId) ?? -1,
      })),
      ...manifest.smartAlbums.map((smart) => ({
        id: smart.id,
        kind: 'smart' as const,
        parentId: smart.parentId,
        position: smart.position,
      })),
    ])) {
      context.addIssue({ code: 'custom', path: ['smartAlbums'], message: issue });
    }
  });

// Schema 11 (#493): the schema-10 records plus every carried photo's edit
// revisions; the record shape and link checks live in backup-manifest-edit-revisions.ts.
export const backupManifestV11Schema = z
  .strictObject({
    ...backupManifestV10Schema.shape,
    schema: z.literal(11),
    editRevisions: z.array(backupManifestEditRevisionV11Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { editRevisions: _editRevisions, ...withoutEdits } = manifest;
    const previous = backupManifestV10Schema.safeParse({ ...withoutEdits, schema: 10 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-10 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    checkEditRevisionLinks(manifest, context);
  });

// Schema 12 (#495): the schema-11 records plus every carried photo's
// provenance evidence; the record shape and link checks live in backup-manifest-provenance.ts.
export const backupManifestV12Schema = z
  .strictObject({
    ...backupManifestV11Schema.shape,
    schema: z.literal(12),
    provenance: z.array(backupManifestProvenanceV12Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { provenance: _provenance, ...withoutProvenance } = manifest;
    const previous = backupManifestV11Schema.safeParse({ ...withoutProvenance, schema: 11 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-11 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    checkProvenanceLinks(manifest, context);
  });

// Schema 13 (#496): the schema-12 records with each photo's derivative key and
// lineage, plus the Promoted representative per original asset; the family
// record and link checks live in backup-manifest-variants.ts.
export const backupManifestV13Schema = z
  .strictObject({
    ...backupManifestV12Schema.shape,
    schema: z.literal(13),
    photos: z.array(backupManifestPhotoV13Schema).readonly(),
    variantFamilies: z.array(backupManifestVariantFamilyV13Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { variantFamilies: _families, ...withoutFamilies } = manifest;
    const previous = backupManifestV12Schema.safeParse({
      ...withoutFamilies,
      schema: 12,
      photos: manifest.photos.map(({ derivativeKey: _key, variantSourceId: _source, assetOwnerId: _owner, ...photo }) => photo),
    });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-12 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    checkVariantLinks(manifest, context);
  });

// Schema 14 (#506, ADR-0033 §4): the schema-13 records where a photo kept on
// this device only says so and names no blob, plus the library-level count
// and bytes of that population; the record shapes and totals check live in
// backup-manifest-coverage.ts.
export const backupManifestV14Schema = z
  .strictObject({
    ...backupManifestV13Schema.shape,
    schema: z.literal(14),
    photos: z.array(backupManifestPhotoV14Schema).readonly(),
    coverage: backupManifestCoverageV14Schema,
  })
  .superRefine((manifest, context) => {
    const { coverage: _coverage, ...withoutCoverage } = manifest;
    const previous = backupManifestV13Schema.safeParse({ ...withoutCoverage, schema: 13, photos: asCarriedRecords(manifest.photos) });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-13 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    checkCoverageTotals(manifest, context);
  });

// Schema 15 (#517, ADR-0032 §2): the keyring registry rides the manifest so
// a restored library keeps every key's (key_ref, version) identity.
export const backupManifestV15Schema = z
  .strictObject({
    ...backupManifestV14Schema.shape,
    schema: z.literal(15),
    keyring: z.array(backupManifestKeyringEntryV15Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { keyring: _keyring, ...withoutKeyring } = manifest;
    const previous = backupManifestV14Schema.safeParse({ ...withoutKeyring, schema: 14 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-14 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    checkKeyringLinks(manifest, context);
  });

// Schema 16 retains a companion's immutable ciphertext owner independently
// of the variant reference. Earlier schemas still enforce per-photo paths.
export const backupManifestV16Schema = z
  .strictObject({
    ...backupManifestV15Schema.shape,
    schema: z.literal(BACKUP_MANIFEST_SCHEMA_VERSION),
    sidecars: z.array(backupManifestSidecarV16Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const previous = backupManifestV15Schema.safeParse({
      ...manifest,
      schema: 15,
      sidecars: manifest.sidecars.map(({ ownerId: _owner, ...sidecar }) => ({
        ...sidecar,
        blobPath: `sidecars/${sidecar.photoId}/${sidecar.hash}`,
      })),
    });
    if (!previous.success)
      context.addIssue({ code: 'custom', message: `schema-15 records are inconsistent: ${z.prettifyError(previous.error)}` });
    checkSharedSidecars(manifest, context);
  });

export type BackupManifestV1 = z.infer<typeof backupManifestV1Schema>;
export type BackupManifestPhotoV2 = z.infer<typeof backupManifestPhotoV2Schema>;
export type BackupManifestAlbumV2 = z.infer<typeof backupManifestAlbumV2Schema>;
export type BackupManifestV2 = z.infer<typeof backupManifestV2Schema>;
export type ProtectedBackupAlbumV3 = z.infer<typeof protectedBackupAlbumV3Schema>;
export type ProtectedBackupObjectV3 = z.infer<typeof protectedBackupObjectV3Schema>;
export type ProtectedBackupPhotoV3 = z.infer<typeof protectedBackupPhotoV3Schema>;
export type BackupManifestV3 = z.infer<typeof backupManifestV3Schema>;
export type BackupManifestV4 = z.infer<typeof backupManifestV4Schema>;
export type BackupManifestBoardV5 = z.infer<typeof backupManifestBoardV5Schema>;
export type BackupManifestV5 = z.infer<typeof backupManifestV5Schema>;
export type BackupManifestSidecarV6 = z.infer<typeof backupManifestSidecarV6Schema>;
export type BackupManifestV6 = z.infer<typeof backupManifestV6Schema>;
export type BackupManifestV7 = z.infer<typeof backupManifestV7Schema>;
export type BackupManifestV8 = z.infer<typeof backupManifestV8Schema>;
export type BackupManifestFolderV9 = z.infer<typeof backupManifestFolderV9Schema>;
export type BackupManifestAlbumPlacementV9 = z.infer<typeof backupManifestAlbumPlacementV9Schema>;
export type BackupManifestV9 = z.infer<typeof backupManifestV9Schema>;
export type BackupManifestSmartAlbumV10 = z.infer<typeof backupManifestSmartAlbumV10Schema>;
export type BackupManifestV10 = z.infer<typeof backupManifestV10Schema>;
export type BackupManifestV11 = z.infer<typeof backupManifestV11Schema>;
export type BackupManifestV12 = z.infer<typeof backupManifestV12Schema>;
export type BackupManifestPhotoV13 = z.infer<typeof backupManifestPhotoV13Schema>;
export type BackupManifestV13 = z.infer<typeof backupManifestV13Schema>;
export type BackupManifestV14 = z.infer<typeof backupManifestV14Schema>;
export type BackupManifestV15 = z.infer<typeof backupManifestV15Schema>;
export type BackupManifestV16 = z.infer<typeof backupManifestV16Schema>;
export type RestorableBackupManifest =
  | BackupManifestV2
  | BackupManifestV3
  | BackupManifestV4
  | BackupManifestV5
  | BackupManifestV6
  | BackupManifestV7
  | BackupManifestV8
  | BackupManifestV9
  | BackupManifestV10
  | BackupManifestV11
  | BackupManifestV12
  | BackupManifestV13
  | BackupManifestV14
  | BackupManifestV15
  | BackupManifestV16;

export interface BackupManifestSnapshot {
  readonly databaseSchema: number;
  readonly keyIds: readonly number[];
  readonly totals: BackupManifestV2['totals'];
  /** Schema-14 records: an excluded row (ADR-0033) carries no blobPath. */
  readonly photos: readonly BackupManifestPhotoV14[];
  readonly albums: readonly BackupManifestAlbumV2[];
}

export interface BackupManifestSnapshotV3 extends BackupManifestSnapshot {
  readonly protectedAlbums: readonly ProtectedBackupAlbumV3[];
  readonly protectedPhotos: readonly ProtectedBackupPhotoV3[];
}

export interface BackupManifestSnapshotV4 extends BackupManifestSnapshotV3 {
  readonly activity: readonly ActivityEvent[];
}

export interface BackupManifestSnapshotV5 extends BackupManifestSnapshotV4 {
  readonly boards: readonly BackupManifestBoardV5[];
}

export interface BackupManifestSnapshotV6 extends BackupManifestSnapshotV5 {
  readonly sidecars: readonly BackupManifestSidecarV6[];
}

export interface BackupManifestSnapshotV7 extends BackupManifestSnapshotV6 {
  readonly galleryPolicy: BackupManifestV7['galleryPolicy'];
}

export interface BackupManifestSnapshotV8 extends BackupManifestSnapshotV7 {
  readonly hiddenAlbumIds: readonly string[];
}

export interface BackupManifestSnapshotV9 extends BackupManifestSnapshotV8 {
  readonly folders: readonly BackupManifestFolderV9[];
  readonly albumTree: readonly BackupManifestAlbumPlacementV9[];
}

export interface BackupManifestSnapshotV10 extends BackupManifestSnapshotV9 {
  readonly smartAlbums: readonly BackupManifestSmartAlbumV10[];
}

export interface BackupManifestSnapshotV11 extends BackupManifestSnapshotV10 {
  readonly editRevisions: readonly BackupManifestEditRevisionV11[];
}

export interface BackupManifestSnapshotV12 extends BackupManifestSnapshotV11 {
  readonly provenance: readonly BackupManifestProvenanceV12[];
}

export interface BackupManifestSnapshotV13 extends BackupManifestSnapshotV12 {
  readonly photos: readonly BackupManifestPhotoV13[];
  readonly variantFamilies: readonly BackupManifestVariantFamilyV13[];
}

/** The coverage totals are derived from the records by the builder. */
export interface BackupManifestSnapshotV14 extends Omit<BackupManifestSnapshotV13, 'photos'> {
  readonly photos: readonly BackupManifestPhotoV14[];
}

/** The keyring registry rows (#517), read beside the photos. */
export interface BackupManifestSnapshotV15 extends BackupManifestSnapshotV14 {
  readonly keyring: readonly BackupManifestKeyringEntryV15[];
}

export type ParsedBackupManifest =
  | { readonly restorable: false; readonly manifest: BackupManifestV1 }
  | { readonly restorable: true; readonly manifest: RestorableBackupManifest };

export class BackupManifestError extends Error {
  override readonly name = 'BackupManifestError';
}

/** Older builders accept a current snapshot too (tests, projections); the
 * keyring is schema-15 data and must not leak into a strict older shape. */
function withoutKeyring<T extends object>(snapshot: T): Omit<T, 'keyring'> {
  const { keyring: _keyring, ...rest } = snapshot as T & { keyring?: unknown };
  return rest;
}

/** What every builder takes: the library identity, the clock, and one snapshot. */
interface BuildInput<TSnapshot> {
  readonly libraryId: string;
  readonly generatedAt: string;
  readonly snapshot: TSnapshot;
}

/** Older builders keep working for tests and projections: the version is
 * the schema literal and the snapshot is spread minus the schema-15 keyring. */
function legacyBuilder<TSnapshot extends object, TManifest>(schema: z.ZodType<TManifest>, version: number) {
  return (input: BuildInput<TSnapshot>): TManifest =>
    schema.parse({ schema: version, libraryId: input.libraryId, generatedAt: input.generatedAt, ...withoutKeyring(input.snapshot) });
}

export const buildBackupManifestV2 = legacyBuilder<BackupManifestSnapshot, BackupManifestV2>(backupManifestV2Schema, 2);
export const buildBackupManifestV4 = legacyBuilder<BackupManifestSnapshotV4, BackupManifestV4>(backupManifestV4Schema, 4);
export const buildBackupManifestV5 = legacyBuilder<BackupManifestSnapshotV5, BackupManifestV5>(backupManifestV5Schema, 5);
export const buildBackupManifestV6 = legacyBuilder<BackupManifestSnapshotV6, BackupManifestV6>(backupManifestV6Schema, 6);
export const buildBackupManifestV7 = legacyBuilder<BackupManifestSnapshotV7, BackupManifestV7>(backupManifestV7Schema, 7);
export const buildBackupManifestV8 = legacyBuilder<BackupManifestSnapshotV8, BackupManifestV8>(backupManifestV8Schema, 8);
export const buildBackupManifestV9 = legacyBuilder<BackupManifestSnapshotV9, BackupManifestV9>(backupManifestV9Schema, 9);
export const buildBackupManifestV10 = legacyBuilder<BackupManifestSnapshotV10, BackupManifestV10>(backupManifestV10Schema, 10);
export const buildBackupManifestV11 = legacyBuilder<BackupManifestSnapshotV11, BackupManifestV11>(backupManifestV11Schema, 11);
export const buildBackupManifestV12 = legacyBuilder<BackupManifestSnapshotV12, BackupManifestV12>(backupManifestV12Schema, 12);
export const buildBackupManifestV13 = legacyBuilder<BackupManifestSnapshotV13, BackupManifestV13>(backupManifestV13Schema, 13);

export function buildBackupManifestV14(input: BuildInput<BackupManifestSnapshotV14>): BackupManifestV14 {
  return backupManifestV14Schema.parse({
    schema: 14,
    libraryId: input.libraryId,
    generatedAt: input.generatedAt,
    ...withoutKeyring(input.snapshot),
    coverage: coverageTotals(input.snapshot.photos),
  });
}

export function buildBackupManifestV15(input: BuildInput<BackupManifestSnapshotV15>): BackupManifestV15 {
  return backupManifestV15Schema.parse({
    schema: 15,
    libraryId: input.libraryId,
    generatedAt: input.generatedAt,
    ...input.snapshot,
    coverage: coverageTotals(input.snapshot.photos),
  });
}

export function buildBackupManifestV16(
  input: BuildInput<Omit<BackupManifestSnapshotV15, 'sidecars'> & { readonly sidecars: readonly BackupManifestSidecarV16[] }>,
): BackupManifestV16 {
  return backupManifestV16Schema.parse({
    ...input.snapshot,
    schema: BACKUP_MANIFEST_SCHEMA_VERSION,
    libraryId: input.libraryId,
    generatedAt: input.generatedAt,
    coverage: coverageTotals(input.snapshot.photos),
  });
}

/** The single migration step for legacy manifests: every restorable manifest
 * (schemas 2..6) is upgraded to the current field contract here, before any
 * consumer sees it. Only fields whose absence does NOT round-trip through a
 * rebuilt catalog are normalized — today that is `mediaInfo` (absent means
 * "not probed", and `manifestSnapshot` always emits the key, so absence must
 * become null). `isOriginal` and the #482 metadata block stay absent:
 * `manifestSnapshot` re-omits them by conditional emission, so their absence
 * round-trips. Sealed protected records (`credentialRecord`,
 * `sealedMetadata`) are opaque here and their plaintext is verified by exact
 * re-stringification elsewhere — normalization must never touch them, and
 * the zod schemas stay default-free for the same reason (see the mediaInfo
 * comment on backupManifestPhotoV2Schema). */
function upgradeLegacyManifest(manifest: RestorableBackupManifest): RestorableBackupManifest {
  if ('coverage' in manifest || manifest.photos.every((photo) => photo.mediaInfo !== undefined)) return manifest;
  return {
    ...manifest,
    photos: manifest.photos.map((photo) => (photo.mediaInfo === undefined ? { ...photo, mediaInfo: null } : photo)),
  };
}

/** Every restorable schema by version; anything else is unsupported. */
const RESTORABLE_SCHEMAS: ReadonlyMap<number, z.ZodType<RestorableBackupManifest>> = new Map<number, z.ZodType<RestorableBackupManifest>>([
  [2, backupManifestV2Schema],
  [3, backupManifestV3Schema],
  [4, backupManifestV4Schema],
  [5, backupManifestV5Schema],
  [6, backupManifestV6Schema],
  [7, backupManifestV7Schema],
  [8, backupManifestV8Schema],
  [9, backupManifestV9Schema],
  [10, backupManifestV10Schema],
  [11, backupManifestV11Schema],
  [12, backupManifestV12Schema],
  [13, backupManifestV13Schema],
  [14, backupManifestV14Schema],
  [15, backupManifestV15Schema],
  [BACKUP_MANIFEST_SCHEMA_VERSION, backupManifestV16Schema],
]);

export function parseBackupManifest(input: unknown): ParsedBackupManifest {
  const version = z.object({ schema: z.number().int() }).safeParse(input);
  if (!version.success) {
    throw new BackupManifestError('manifest is missing a numeric schema version');
  }
  const schema = version.data.schema;
  if (schema === 1) {
    const parsed = backupManifestV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new BackupManifestError(`invalid schema-1 manifest: ${z.prettifyError(parsed.error)}`);
    }
    return { restorable: false, manifest: parsed.data };
  }
  const restorable = RESTORABLE_SCHEMAS.get(schema);
  if (restorable === undefined) {
    throw new BackupManifestError(`unsupported manifest schema ${String(schema)}`);
  }
  const parsed = restorable.safeParse(input);
  if (!parsed.success) {
    throw new BackupManifestError(`invalid schema-${String(schema)} manifest: ${z.prettifyError(parsed.error)}`);
  }
  return { restorable: true, manifest: upgradeLegacyManifest(parsed.data) };
}
