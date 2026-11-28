import { EditRevisionRepository } from '../db/edit-revision-repository.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import { createExportRuntime, type DrainableExportFacade } from './export-runtime.js';
import type { ExportDisclosurePlanner } from './export-engine.js';
import { EphemeralOriginalError, type EphemeralOriginalService } from '../backup/ephemeral-originals.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';

// Export facade wiring, extracted from the composition root. Offloaded
// originals stream through the ephemeral custody service and are released
// back to it when the export finishes.

export interface ExportFacadeFactoryDeps {
  readonly db: ConstructorParameters<typeof PhotosRepository>[0];
  readonly blobStore: BlobStore;
  readonly resolveKey: KeyResolver;
  readonly ephemeral: () => EphemeralOriginalService;
  readonly pickDestination: () => Promise<string | null>;
  readonly progress: (done: number, total: number) => void;
  /** ADR-0032 §6 planner (#509). */
  readonly disclosure?: ExportDisclosurePlanner | undefined;
}

export function createExportFacade(deps: ExportFacadeFactoryDeps): DrainableExportFacade {
  const repo = new PhotosRepository(deps.db);
  const sidecars = new SidecarRepository(deps.db);
  const revisions = new EditRevisionRepository(deps.db);
  return createExportRuntime({
    repo: { get: (id) => repo.get(id), exportableIds: () => repo.exportableIds() },
    blobs: deps.blobStore,
    resolveKey: deps.resolveKey,
    // The head revision decides what Baked renders and Original + XMP carries (#497).
    editHead: (photoId) => revisions.head(photoId).head,
    // Companions export beside their originals (#484, ADR-0031 §6).
    sidecarsFor: (photoId) => sidecars.listForPhoto(photoId),
    sidecarStream: (photoId, contentHash, signal) => deps.blobStore.getSidecarStream(photoId, contentHash, deps.resolveKey, signal),
    openOriginal: async (photo, signal) => {
      const service = deps.ephemeral();
      const opened = await service.open(photo.id, 'export', signal);
      return { stream: opened.stream, release: opened.release };
    },
    custodyStatus: (photoId, error) =>
      error instanceof EphemeralOriginalError ? deps.ephemeral().custodyStatus(photoId) : Promise.resolve(undefined),
    pickDestination: deps.pickDestination,
    progress: deps.progress,
    ...(deps.disclosure === undefined ? {} : { disclosure: deps.disclosure }),
  });
}
