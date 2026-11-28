import type { ExtractedMetadata } from './exif.js';
import type { ThumbnailOutcome } from './thumbnail-service.js';
import type { PhotoRecord } from '../../shared/library/types.js';

export interface RawRepairSummary {
  readonly scanned: number;
  readonly repaired: number;
  readonly failed: number;
  readonly skipped: number;
}

interface RepairOutcome extends ThumbnailOutcome {
  /** Release durable publication debt only after all repaired row state is stored. */
  readonly settle?: (() => void) | undefined;
}

export interface RawRepairServiceOptions {
  readonly candidates: (contentHashes?: readonly string[], photoIds?: readonly string[]) => readonly PhotoRecord[];
  readonly isUnavailable: (photoId: string) => boolean;
  readonly requiresRebake?: ((photoId: string) => boolean) | undefined;
  readonly validThumbs: (photo: PhotoRecord) => Promise<boolean>;
  readonly loadOriginal: (photo: PhotoRecord) => Promise<Buffer | null>;
  readonly extractMetadata: (bytes: Buffer, fileKind: PhotoRecord['fileKind']) => Promise<ExtractedMetadata>;
  readonly regenerate: (photo: PhotoRecord, bytes: Buffer, signal: AbortSignal) => Promise<RepairOutcome>;
  readonly repairMetadata: (photoId: string, metadata: ExtractedMetadata) => boolean;
  readonly repairGeneratedDimensions: (photoId: string, width: number, height: number) => boolean;
  readonly setDimensionStatus: (photoId: string, status: PhotoRecord['dimensionStatus']) => boolean;
  readonly setPreviewFailure: (photoId: string, failure: PhotoRecord['previewFailure']) => boolean;
  readonly clearPreviewRepairDebt?: ((photoId: string) => boolean) | undefined;
  readonly setPreviewMissing?: ((photoId: string, missing: boolean) => boolean) | undefined;
  readonly changed: (photoIds: readonly string[], membership: 'none' | 'library') => void;
  readonly yieldTurn?: (() => Promise<void>) | undefined;
}

const yieldTurn = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Startup, rehydration, and explicit retries share one cancellable queue.
 * Sequential decode keeps peak plaintext bounded to one original plus the
 * thumbnail pool's two outputs. */
export class RawRepairService {
  private readonly controller = new AbortController();
  private running: Promise<RawRepairSummary> | undefined;
  // null means a full startup scan; targeted rehydrations coalesce by asset.
  private queued: Set<string> | null | undefined;
  private readonly queuedPhotos = new Set<string>();

  constructor(private readonly options: RawRepairServiceOptions) {}

  close(): void {
    this.controller.abort();
  }

  schedule(contentHashes: readonly string[]): void {
    void this.repair(contentHashes).catch((error: unknown) => {
      console.error('[overlook] rehydrated preview repair failed', error);
    });
  }

  repair(contentHashes?: readonly string[]): Promise<RawRepairSummary> {
    if (contentHashes === undefined) this.queued = null;
    else if (this.queued !== null) {
      this.queued ??= new Set();
      for (const hash of contentHashes) this.queued.add(hash);
    }
    return this.runQueued();
  }

  /** Explicit retries select rows, not shared assets. The drain may also contain
   * background work, so callers inspect their requested row instead of using
   * aggregate counts as evidence that this one photo was repaired. */
  async repairPhoto(photoId: string): Promise<void> {
    this.queuedPhotos.add(photoId);
    await this.runQueued();
  }

  private runQueued(): Promise<RawRepairSummary> {
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drain(): Promise<RawRepairSummary> {
    const total = { scanned: 0, repaired: 0, failed: 0, skipped: 0 };
    while ((this.queued !== undefined || this.queuedPhotos.size > 0) && !this.controller.signal.aborted) {
      let pass: RawRepairSummary;
      if (this.queued !== undefined) {
        const hashes = this.queued;
        this.queued = undefined;
        pass = await this.repairPass(hashes === null ? undefined : [...hashes]);
      } else {
        const photoIds = [...this.queuedPhotos];
        this.queuedPhotos.clear();
        pass = await this.repairPass(undefined, photoIds);
      }
      total.scanned += pass.scanned;
      total.repaired += pass.repaired;
      total.failed += pass.failed;
      total.skipped += pass.skipped;
    }
    return total;
  }

  private async repairPass(contentHashes?: readonly string[], photoIds?: readonly string[]): Promise<RawRepairSummary> {
    let scanned = 0;
    let repaired = 0;
    let failed = 0;
    let skipped = 0;
    const changed = new Set<string>();
    let membershipChanged = false;
    for (const photo of this.options.candidates(contentHashes, photoIds)) {
      if (this.controller.signal.aborted) break;
      scanned += 1;
      const requested = photoIds !== undefined;
      if (photo.locked || photo.deletedAt !== null || (requested && photo.syncState === 'offloaded')) {
        skipped += 1;
        continue;
      }
      const wasUnavailable = this.options.isUnavailable(photo.id);
      let bytes: Buffer | null = null;
      try {
        const requiresRebake = this.options.requiresRebake?.(photo.id) ?? false;
        const thumbsReady = await this.options.validThumbs(photo);
        const needsDimensionRepair =
          photo.dimensionStatus === 'legacy' ||
          photo.width <= 0 ||
          photo.height <= 0 ||
          (requested && photo.dimensionStatus === 'unavailable');
        const needsPreviewRepair = !thumbsReady || (requested && photo.previewFailure !== null);
        if (this.controller.signal.aborted) break;
        if (this.options.setPreviewMissing?.(photo.id, !thumbsReady) === true) {
          changed.add(photo.id);
          if (wasUnavailable !== this.options.isUnavailable(photo.id)) membershipChanged = true;
        }
        if (!requiresRebake && !needsPreviewRepair && !needsDimensionRepair) {
          const failureChanged = this.options.setPreviewFailure(photo.id, null);
          const debtCleared = this.options.clearPreviewRepairDebt?.(photo.id) ?? false;
          if (failureChanged || debtCleared) {
            repaired += 1;
            changed.add(photo.id);
          } else {
            skipped += 1;
          }
          continue;
        }
        bytes = await this.options.loadOriginal(photo);
        if (bytes === null) {
          skipped += 1;
          continue;
        }
        const metadata = await this.options.extractMetadata(bytes, photo.fileKind);
        if (this.controller.signal.aborted) break;
        let outcome: RepairOutcome | null = null;
        if (needsPreviewRepair || needsDimensionRepair || requiresRebake) {
          outcome = await this.options.regenerate(photo, bytes, this.controller.signal);
        }
        if (this.controller.signal.aborted) break;
        if (outcome?.discarded === true) {
          skipped += 1;
          continue; // A superseded repair must not overwrite the newer head's availability.
        }
        if (requiresRebake && outcome?.generated !== true) {
          failed += 1;
          continue; // Keep the current availability and durable debt on failure/supersession.
        }
        const repairedMetadata = this.options.repairMetadata(photo.id, metadata);
        const repairedDimensions =
          requiresRebake && !needsDimensionRepair
            ? false
            : outcome?.width !== null && outcome?.width !== undefined && outcome.height !== null
              ? this.options.repairGeneratedDimensions(photo.id, outcome.width, outcome.height)
              : this.options.setDimensionStatus(photo.id, 'unavailable');
        const repairedThumbs = (needsPreviewRepair || needsDimensionRepair || requiresRebake) && outcome?.generated === true;
        const failure = needsPreviewRepair && outcome?.generated !== true ? (outcome?.failure ?? 'decode-failed') : null;
        const debtCleared = outcome?.generated === true ? (this.options.clearPreviewRepairDebt?.(photo.id) ?? false) : false;
        const failureChanged = this.options.setPreviewFailure(photo.id, failure);
        if (outcome?.generated === true) outcome.settle?.();
        if (repairedMetadata || repairedDimensions || repairedThumbs || debtCleared) {
          repaired += 1;
        }
        if (repairedMetadata || repairedDimensions || repairedThumbs || failureChanged || debtCleared) {
          changed.add(photo.id);
        }
        if ((needsPreviewRepair || (requested && needsDimensionRepair)) && outcome?.generated !== true) failed += 1;
      } catch (error) {
        failed += 1;
        console.error(`[overlook] preview repair failed for ${photo.id}`, error);
      } finally {
        bytes?.fill(0);
        if (wasUnavailable !== this.options.isUnavailable(photo.id)) {
          membershipChanged = true;
          changed.add(photo.id);
        }
      }
      await (this.options.yieldTurn ?? yieldTurn)();
    }
    if (changed.size > 0) this.options.changed([...changed], membershipChanged ? 'library' : 'none');
    return { scanned, repaired, failed, skipped };
  }
}
