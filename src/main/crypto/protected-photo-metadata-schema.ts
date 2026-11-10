import { z } from 'zod';

import { backupManifestEditRevisionV11Schema, checkEditRevisionLinks } from '../backup/backup-manifest-edit-revisions.js';
import { isoTimestampSchema, sha256Schema } from '../backup/backup-manifest-photo.js';
import { backupManifestPhotoV2Schema } from '../backup/backup-manifest.js';

const ordinaryPhotoSchema = backupManifestPhotoV2Schema.omit({ blobPath: true, keyId: true });

export const protectedSidecarMetadataSchema = z.strictObject({
  role: z.enum(['xmp', 'aae']),
  fileName: z.string().min(1).max(1024),
  contentHash: sha256Schema,
  bytes: z.number().int().nonnegative(),
  importedAt: isoTimestampSchema,
});

export type ProtectedSidecarMetadata = z.output<typeof protectedSidecarMetadataSchema>;

const legacyProtectedPhotoMetadataSchema = z.strictObject({
  version: z.literal(1),
  photo: ordinaryPhotoSchema,
  ordinaryMemberships: z
    .array(
      z.strictObject({
        albumId: z.string().min(1).max(256),
        position: z.number().int().nonnegative(),
      }),
    )
    .readonly(),
});

// Payload v2 preserves append-only edit documents and companion sidecars inside
// album-key custody. The envelope format and its AAD stay v1; old payloads remain readable.
export const protectedPhotoMetadataSchema = z.union([
  legacyProtectedPhotoMetadataSchema,
  legacyProtectedPhotoMetadataSchema
    .extend({
      version: z.literal(2),
      editRevisions: z.array(backupManifestEditRevisionV11Schema).readonly(),
      sidecars: z.array(protectedSidecarMetadataSchema).readonly().optional(),
    })
    .superRefine((metadata, context) => {
      checkEditRevisionLinks({ photos: [metadata.photo], editRevisions: metadata.editRevisions }, context);
    }),
]);

export type ProtectedPhotoMetadata = z.output<typeof protectedPhotoMetadataSchema>;
