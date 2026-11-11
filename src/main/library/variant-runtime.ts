import { EditRevisionRepository } from '../db/edit-revision-repository.js';
import { buffer } from 'node:stream/consumers';

import { ulid } from '../import/ulid.js';

import { BlobStoreError } from '../blobs/blob-store.js';
import { PhotosRepository } from '../db/photos-repository.js';
import type { ImportRuntime } from '../import/import-runtime.js';
import type { LibraryParts } from './library-parts.js';
import { VariantService } from './variant-service.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

// Wires the variant service (#496) the way the edit service is wired:
// originals stream out of the encrypted blob store, derivatives bake through
// the shared thumbnail runtime under the variant's own key, and the
// renderer/library side effects arrive as callbacks.
export interface VariantRuntimeContext {
  readonly parts: LibraryParts;
  readonly runtime: Pick<ImportRuntime, 'thumbnails'>;
  readonly appVersion: string;
  readonly invalidateThumb: (id: string) => void;
  /** Promote changed rows in place. */
  readonly emitChanged: (photoIds: readonly string[]) => void;
  /** New rows: the grid refetches its page. */
  readonly emitCreated: (photoIds: readonly string[]) => void;
  readonly emitPending: (count: number) => void;
  readonly scheduleAutoBackup: () => void;
}

export function createVariantRuntime(ctx: VariantRuntimeContext): VariantService {
  const repo = new PhotosRepository(ctx.parts.db);
  const revisions = new EditRevisionRepository(ctx.parts.db);
  return new VariantService({
    db: ctx.parts.db,
    repo,
    loadOriginal: async (photo) => {
      await ctx.parts.blobStoreReady;
      try {
        return await buffer(ctx.parts.blobStore.getStream(photo.contentHash, ctx.parts.keyStore.resolver(), assetOwnerOf(photo)));
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    regenerate: async (photo, bytes, transform, headId) =>
      ctx.runtime.thumbnails.regenerateFor({
        photoId: photo.id,
        bytes,
        contentHash: photo.contentHash,
        derivativeKey: photo.derivativeKey,
        key: ctx.parts.keyStore.currentKey(),
        fileKind: photo.fileKind,
        transform,
        isCurrent: () => (revisions.head(photo.id).head?.id ?? null) === headId,
      }),
    appVersion: ctx.appVersion,
    newId: () => ulid(),
    now: () => new Date().toISOString(),
    created: (photoIds) => {
      for (const id of photoIds) ctx.invalidateThumb(id);
      ctx.emitCreated(photoIds);
      ctx.emitPending(repo.pendingCount());
      ctx.scheduleAutoBackup();
    },
    changed: (photoIds) => {
      ctx.emitChanged(photoIds);
      ctx.scheduleAutoBackup();
    },
  });
}
