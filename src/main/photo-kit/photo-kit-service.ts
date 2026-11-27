import { createWriteStream } from 'node:fs';
import { discloses, permissivePlan } from '../../shared/disclosure/policy.js';
import type { ExportDisclosureIntent } from '../export/export-engine.js';
import { embeddedFieldsOf, type DisclosurePlanner } from '../disclosure/disclosure-service.js';
import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import type { ImportSummary } from '../import/import-engine.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { PhotoKitAsset, PhotoKitAuthorization, PhotoKitUnavailableReason } from '../../shared/ipc/photo-kit-channels.js';
import type { PhotoKitBridge, PhotoKitExportAsset, PhotoKitMaterializedAsset } from './photo-kit-bridge.js';
import { cleanupPhotoKitStage, createPhotoKitStage } from './photo-kit-staging.js';

interface OpenedOriginal {
  readonly stream: Readable;
  readonly release?: (() => Promise<void>) | undefined;
}

export interface PhotoKitServiceDeps {
  /** ADR-0032 §6 planner (#509); absent = permissive (unit worlds). */
  readonly disclosure?: DisclosurePlanner | undefined;
  readonly bridge: PhotoKitBridge;
  readonly dataDir: string;
  readonly getPhoto: (photoId: string) => PhotoRecord | undefined;
  readonly openOriginal: (photo: PhotoRecord) => Promise<OpenedOriginal>;
  readonly importFiles: (
    assets: readonly PhotoKitMaterializedAsset[],
    cleanupPath: string,
    onJournaled: () => void,
  ) => Promise<ImportSummary>;
  readonly cancelImport: () => void;
  readonly admit: () => boolean;
  readonly progress: (payload: {
    readonly operation: 'import' | 'export';
    readonly phase: 'preparing' | 'transferring';
    readonly done: number;
    readonly total: number;
  }) => void;
}

export interface PhotoKitImportReview {
  readonly status: 'ready' | 'denied' | 'restricted' | 'unavailable' | 'cancelled';
  readonly authorization: PhotoKitAuthorization;
  readonly reviewId: string | null;
  readonly assets: readonly PhotoKitAsset[];
}

export interface PhotoKitExportResult {
  readonly exported: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly failures: readonly { readonly photoId: string; readonly fileName: string; readonly reason: string }[];
}

function allowed(authorization: PhotoKitAuthorization): boolean {
  return authorization === 'authorized' || authorization === 'limited';
}

function unavailableReview(reason: PhotoKitUnavailableReason | null): PhotoKitImportReview {
  return {
    status: reason === null ? 'cancelled' : 'unavailable',
    authorization: 'denied',
    reviewId: null,
    assets: [],
  };
}

function inside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.';
}

async function validateMaterialization(
  scratch: string,
  assetIds: readonly string[],
  materialized: readonly PhotoKitMaterializedAsset[],
): Promise<void> {
  const expected = new Set(assetIds);
  if (
    materialized.length !== assetIds.length ||
    materialized.some((asset) => !expected.delete(asset.id) || !inside(scratch, asset.path)) ||
    expected.size !== 0
  ) {
    throw new Error('PhotoKit returned an invalid materialization');
  }
  const scratchPath = await realpath(scratch);
  await Promise.all(
    materialized.map(async (asset) => {
      const [details, parentPath] = await Promise.all([lstat(asset.path), realpath(path.dirname(asset.path))]);
      const unsafeMode = process.platform !== 'win32' && (details.mode & 0o077) !== 0;
      if (!details.isFile() || details.isSymbolicLink() || parentPath !== scratchPath || unsafeMode) {
        throw new Error('PhotoKit returned an unsafe staging file');
      }
    }),
  );
}

function uniqueName(fileName: string, used: Set<string>): string {
  const safe = path.basename(fileName.normalize('NFC'));
  if (safe !== fileName.normalize('NFC') || safe === '' || safe === '.' || safe === '..' || safe.includes('\0')) {
    throw new Error('invalid Photos filename');
  }
  const dot = safe.lastIndexOf('.');
  const stem = dot <= 0 ? safe : safe.slice(0, dot);
  const extension = dot <= 0 ? '' : safe.slice(dot);
  let candidate = safe;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('en-US'))) {
    candidate = `${stem} (${String(suffix)})${extension}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

function exportedMediaType(photo: PhotoRecord): 'image' | 'video' | null {
  if (photo.fileKind === 'video') return 'video';
  if (photo.fileKind === 'audio' || photo.fileKind === 'other') return null;
  return 'image';
}

export class PhotoKitService {
  private readonly reviews = new Map<string, ReadonlyMap<string, PhotoKitAsset>>();
  private controller: AbortController | null = null;
  private active: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: PhotoKitServiceDeps) {}

  status(): {
    readonly available: boolean;
    readonly reason: PhotoKitUnavailableReason | null;
    readonly importAuthorization: PhotoKitAuthorization;
    readonly exportAuthorization: PhotoKitAuthorization;
  } {
    const status = this.deps.bridge.status();
    return {
      ...status,
      importAuthorization: status.available ? this.deps.bridge.authorization('read-write') : 'denied',
      exportAuthorization: status.available ? this.deps.bridge.authorization('add-only') : 'denied',
    };
  }

  async reviewImport(): Promise<PhotoKitImportReview> {
    const status = this.deps.bridge.status();
    if (!status.available) return unavailableReview(status.reason);
    if (this.closed || !this.deps.admit()) return unavailableReview(null);
    const authorization = await this.deps.bridge.requestAuthorization('read-write');
    if (authorization === 'restricted') return { status: 'restricted', authorization, reviewId: null, assets: [] };
    if (!allowed(authorization)) return { status: 'denied', authorization, reviewId: null, assets: [] };
    if (!this.deps.admit()) return unavailableReview(null);
    const assets = this.deps.bridge.assets();
    const reviewId = randomUUID();
    this.reviews.clear();
    this.reviews.set(reviewId, new Map(assets.map((asset) => [asset.id, asset])));
    return { status: 'ready', authorization, reviewId, assets };
  }

  runImport(reviewId: string, assetIds: readonly string[]): Promise<ImportSummary> {
    return this.start(async (signal) => {
      const review = this.reviews.get(reviewId);
      this.reviews.delete(reviewId);
      if (review === undefined || assetIds.some((id) => !review.has(id))) throw new Error('Photos review is stale or invalid');
      if (!allowed(this.deps.bridge.authorization('read-write')) || !this.deps.admit()) throw new Error('Photos access is unavailable');
      const scratch = await createPhotoKitStage(this.deps.dataDir);
      let journalOwnsStage = false;
      try {
        this.deps.progress({ operation: 'import', phase: 'preparing', done: 0, total: assetIds.length });
        const materialized = await this.deps.bridge.materialize(assetIds, scratch);
        if (signal.aborted || !this.deps.admit()) throw new Error('Photos import cancelled');
        await validateMaterialization(scratch, assetIds, materialized);
        this.deps.progress({ operation: 'import', phase: 'transferring', done: 0, total: materialized.length });
        return await this.deps.importFiles(materialized, scratch, () => {
          journalOwnsStage = true;
        });
      } finally {
        if (!journalOwnsStage) await cleanupPhotoKitStage(this.deps.dataDir, scratch);
      }
    });
  }

  runExport(photoIds: readonly string[], disclosure?: ExportDisclosureIntent): Promise<PhotoKitExportResult> {
    return this.start(async (signal) => {
      disclosure?.assertCurrent?.();
      const authorization = await this.deps.bridge.requestAuthorization('add-only');
      if (!allowed(authorization) || !this.deps.admit()) {
        return {
          exported: 0,
          failed: photoIds.length,
          cancelled: 0,
          failures: photoIds.map((photoId) => ({ photoId, fileName: photoId, reason: 'Apple Photos access is denied' })),
        };
      }
      const scratch = await createPhotoKitStage(this.deps.dataDir);
      const failures: { photoId: string; fileName: string; reason: string }[] = [];
      const staged: PhotoKitExportAsset[] = [];
      const used = new Set<string>();
      let cancelled = 0;
      try {
        for (const [index, photoId] of photoIds.entries()) {
          disclosure?.assertCurrent?.();
          if (signal.aborted || !this.deps.admit()) {
            cancelled = photoIds.length - index;
            break;
          }
          const photo = this.deps.getPhoto(photoId);
          const mediaType = photo === undefined ? null : exportedMediaType(photo);
          if (photo === undefined || photo.deletedAt !== null || mediaType === null) {
            failures.push({ photoId, fileName: photo?.fileName ?? photoId, reason: 'Photo is unavailable or unsupported' });
            continue;
          }
          // ADR-0032 §6: Apple Photos is a named recipient (the user's own
          // library). The staged original carries its embedded fields as they
          // are, so a withheld one fails this photo closed — the dialog's
          // preview names it and the widening is the user's explicit action.
          const plan =
            this.deps.disclosure?.plan(photoId, 'photo-kit', disclosure?.destination ?? 'shared', disclosure?.operation) ??
            permissivePlan('photo-kit');
          const blocked = embeddedFieldsOf(photo).filter((field) => !discloses(plan, field));
          if (blocked.length > 0) {
            failures.push({ photoId, fileName: photo.fileName, reason: `Withheld by disclosure policy: ${blocked.join(', ')}` });
            continue;
          }
          let opened: OpenedOriginal | undefined;
          try {
            const fileName = uniqueName(photo.fileName, used);
            const filePath = path.join(scratch, fileName);
            opened = await this.deps.openOriginal(photo);
            await pipeline(opened.stream, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), { signal });
            if (signal.aborted || !this.deps.admit()) throw new Error('Photos export cancelled');
            staged.push({
              photoId,
              path: filePath,
              fileName,
              mediaType,
              createdAt: discloses(plan, 'captureTime') ? photo.takenAt : null,
              latitude: discloses(plan, 'location') ? photo.gpsLat : null,
              longitude: discloses(plan, 'location') ? photo.gpsLon : null,
            });
          } catch (error) {
            failures.push({
              photoId,
              fileName: photo.fileName,
              reason: error instanceof Error ? error.message : String(error),
            });
          } finally {
            opened?.stream.destroy();
            await opened?.release?.();
          }
          this.deps.progress({ operation: 'export', phase: 'preparing', done: index + 1, total: photoIds.length });
        }
        if (staged.length > 0 && !signal.aborted && this.deps.admit()) {
          disclosure?.assertCurrent?.();
          this.deps.progress({ operation: 'export', phase: 'transferring', done: 0, total: staged.length });
          try {
            await this.deps.bridge.exportAssets(staged);
            this.deps.progress({ operation: 'export', phase: 'transferring', done: staged.length, total: staged.length });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            failures.push(...staged.map(({ photoId, fileName }) => ({ photoId, fileName, reason })));
            staged.length = 0;
          }
        }
        return { exported: staged.length, failed: failures.length, cancelled, failures };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }

  cancel(): void {
    this.controller?.abort();
    this.deps.bridge.cancelAll();
    this.deps.cancelImport();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.reviews.clear();
    this.deps.bridge.close();
  }

  drain(): Promise<void> {
    return this.active.then(
      () => undefined,
      () => undefined,
    );
  }

  private start<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || this.controller !== null) return Promise.reject(new Error('PhotoKit service is unavailable or busy'));
    const controller = new AbortController();
    this.controller = controller;
    const active = Promise.resolve().then(() => task(controller.signal));
    this.active = active;
    return active.finally(() => {
      if (this.controller === controller) this.controller = null;
    });
  }
}
