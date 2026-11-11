import { createPhotoRepairRouter } from '../library/photo-repair-router.js';
import { EditBakeDebtRepository } from '../db/edit-bake-debt-repository.js';
import { EditRevisionRepository } from '../db/edit-revision-repository.js';
import { PhotosRepository } from '../db/photos-repository.js';
import type { ImportRuntime } from './import-runtime.js';
import type { LibraryParts } from '../library/library-parts.js';
import { captureVideoPosterFrame } from './offscreen-frame-capturer.js';
import { createPosterCaptureRuntime } from './poster-capture-runtime.js';
import type { PosterCaptureService } from './poster-capture-service.js';
import { createRawRepairRuntime } from './raw-repair-runtime.js';
import type { RawRepairService } from './raw-repair-service.js';
import { createHistogramRuntime, type HistogramRuntime } from '../library/histogram-runtime.js';
import { createDuplicateIndexRuntime, type DuplicateIndexRuntime } from '../library/duplicate-index-runtime.js';
import type { FingerprintIndexStatus } from '../db/fingerprint-repository.js';
import { createPhotoEditRuntime } from '../library/photo-edit-runtime.js';
import type { PhotoEditService } from '../library/photo-edit-service.js';
import { createProvenanceRuntime } from '../library/provenance-runtime.js';
import type { ProvenanceService } from '../library/provenance-service.js';
import { createVariantRuntime } from '../library/variant-runtime.js';
import type { VariantService } from '../library/variant-service.js';
import { createOriginalRecoveryRuntime } from '../library/original-recovery-runtime.js';
import type { OriginalRecoveryService } from '../library/original-recovery-service.js';

// RAW/HEIC preview repair and video poster capture (ADR-0026 §6) are both
// post-import background passes over the same library parts, and persisted
// edits (#493) re-bake derivatives through the same thumbnail runtime; this
// keeps their wiring out of the app-bootstrap file. Renderer/library side effects are
// injected as callbacks so this module stays free of window/emitter details.
export interface MaintenanceContext {
  readonly parts: LibraryParts;
  readonly runtime: ImportRuntime;
  readonly appVersion: string;
  readonly invalidateThumb: (id: string) => void;
  readonly invalidateFull: (id: string) => void;
  readonly emitChanged: (photoIds: readonly string[], membership?: 'none' | 'library') => void;
  /** New rows (a Duplicate, #496): the grid refetches its page. */
  readonly emitCreated: (photoIds: readonly string[]) => void;
  /** Derivative-only refresh (a captured poster): refresh just those tiles'
   * images without a page refetch, so a background poster completing never
   * resets scroll or drops the lightbox/selection (#744 review). */
  readonly emitThumbsChanged: (photoIds: readonly string[]) => void;
  readonly emitPending: (count: number) => void;
  readonly scheduleAutoBackup: () => void;
  readonly embeddingEligible: (photoIds: readonly string[]) => void;
  /** Perceptual index progress (#650): the review dialog refreshes on it. */
  readonly emitDuplicatesChanged: (status: FingerprintIndexStatus) => void;
  /** Every library change (imports, trash, restore, edits) — the perceptual
   * review is derived, so any row movement makes its cached answer stale. */
  readonly onLibraryChanged: (listener: () => void) => () => void;
  readonly captureFrame?: typeof captureVideoPosterFrame | undefined;
  readonly createHistogram?: typeof createHistogramRuntime | undefined;
  readonly createDuplicates?: typeof createDuplicateIndexRuntime | undefined;
}

export interface MaintenanceServices {
  readonly originalRecovery: OriginalRecoveryService;
  readonly photoRepair: ReturnType<typeof createPhotoRepairRouter>;
  readonly rawRepair: RawRepairService;
  readonly posterCapture: PosterCaptureService;
  readonly photoEdits: PhotoEditService;
  readonly provenance: ProvenanceService;
  readonly variants: VariantService;
  /** Inspector histogram (#498). */
  readonly histogram: HistogramRuntime;
  /** Perceptual duplicate index and review (#650). */
  readonly duplicates: DuplicateIndexRuntime;
  /** Stops the background passes and the histogram worker with the library. */
  readonly close: () => Promise<void>;
}

export function buildMaintenanceServices(ctx: MaintenanceContext): MaintenanceServices {
  const { parts, runtime } = ctx;
  const repo = new PhotosRepository(parts.db);
  const shared = {
    blobs: parts.blobStore,
    blobsReady: parts.blobStoreReady,
    thumbnails: runtime.thumbnails,
    currentKey: () => parts.keyStore.currentKey(),
    resolveKey: parts.keyStore.resolver(),
  };
  // Every derivative regeneration below also drops the histogram cached for
  // that photo (#498): a repair or re-bake changes the pixels, not the head.
  const histogram = (ctx.createHistogram ?? createHistogramRuntime)({ parts });
  // …and its perceptual fingerprint (#650): the derivative key stays, the
  // pixels did not, so the row is dropped and the pass re-indexes it.
  const duplicates = (ctx.createDuplicates ?? createDuplicateIndexRuntime)({ parts, changed: ctx.emitDuplicatesChanged });
  const unfollowLibrary = ctx.onLibraryChanged(() => duplicates.service.notifyLibraryChanged());
  duplicates.service.schedule();
  const invalidateThumb = (id: string): void => {
    ctx.invalidateThumb(id);
    histogram.service.invalidate([id]);
    duplicates.service.notifyEligibilityChanged([id]);
  };
  const rawRepair = createRawRepairRuntime({
    ...shared,
    repo,
    revisions: new EditRevisionRepository(parts.db),
    bakeDebt: new EditBakeDebtRepository(parts.db),
    changed: (ids, membership) => {
      for (const id of ids) {
        invalidateThumb(id);
        ctx.invalidateFull(id);
      }
      ctx.emitChanged(ids, membership);
      ctx.emitPending(repo.stats().pending);
      ctx.scheduleAutoBackup();
      ctx.embeddingEligible(ids);
    },
  });
  const posterCapture = createPosterCaptureRuntime({
    ...shared,
    db: parts.db,
    captureFrame: ctx.captureFrame ?? captureVideoPosterFrame,
    changed: (ids, membership) => {
      for (const id of ids) invalidateThumb(id);
      // Background capture refreshes tiles only (#744); an explicit repair may
      // change Unavailable membership and therefore needs a page refresh.
      if (membership === 'library') {
        ctx.emitChanged(ids, membership);
        ctx.emitPending(repo.stats().pending);
        ctx.scheduleAutoBackup();
      } else ctx.emitThumbsChanged(ids);
      ctx.embeddingEligible(ids);
    },
  });
  const photoEdits = createPhotoEditRuntime({
    parts,
    runtime,
    appVersion: ctx.appVersion,
    invalidateThumb: invalidateThumb,
    emitThumbsChanged: ctx.emitThumbsChanged,
    emitChanged: ctx.emitChanged,
    emitPending: ctx.emitPending,
    scheduleAutoBackup: ctx.scheduleAutoBackup,
  });
  const provenance = createProvenanceRuntime({ parts, scheduleAutoBackup: ctx.scheduleAutoBackup });
  const variants = createVariantRuntime({
    parts,
    runtime,
    appVersion: ctx.appVersion,
    invalidateThumb: invalidateThumb,
    emitChanged: ctx.emitChanged,
    emitCreated: ctx.emitCreated,
    emitPending: ctx.emitPending,
    scheduleAutoBackup: ctx.scheduleAutoBackup,
  });
  const originalRecovery = createOriginalRecoveryRuntime(parts, (ids) => {
    for (const id of ids) ctx.invalidateFull(id);
    ctx.emitChanged(ids, 'library');
    ctx.emitPending(repo.pendingCount());
    ctx.scheduleAutoBackup();
  });
  return {
    originalRecovery,
    photoRepair: createPhotoRepairRouter({
      getPhoto: (id) => repo.get(id),
      repairImage: (id) => rawRepair.repairPhoto(id),
      captureVideo: (id) => posterCapture.capturePhoto(id),
    }),
    rawRepair,
    posterCapture,
    photoEdits,
    provenance,
    variants,
    histogram,
    duplicates,
    close: async () => {
      originalRecovery.close();
      rawRepair.close();
      posterCapture.close();
      unfollowLibrary();
      await Promise.all([histogram.close(), duplicates.close(), originalRecovery.drain()]);
    },
  };
}
