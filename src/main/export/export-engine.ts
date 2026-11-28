import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { KeyResolver } from '../crypto/envelope.js';
import type { EditRevisionView } from '../db/edit-revision-repository.js';
import { editsXmpAttributes, xmpPacket } from './edit-xmp.js';
import { resolveContainedExportPath, sanitizeExportFileName, sanitizeSidecarExtension } from './export-path-safety.js';
import type { TranscodeOptions, TranscodeResult } from './transcode.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { PhotoCustodyStatus } from '../../shared/backup/custody-status.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';
import { IDENTITY_TRANSFORM, isIdentityTransform, type EditTransform } from '../../shared/library/edit-revision.js';
import {
  discloses,
  EMPTY_DISCLOSURE_OPERATION,
  permissivePlan,
  type DisclosureDestination,
  type DisclosureField,
  type DisclosureOperation,
  type DisclosurePlan,
} from '../../shared/disclosure/policy.js';
import { embeddedFieldsOf } from '../disclosure/disclosure-service.js';
import { inspectSourceSidecar, readSourceSidecar, sourceSidecarFinding, sourceSidecarRefusal } from '../disclosure/source-sidecars.js';
import { inspectSourceXmp } from '../disclosure/source-xmp.js';
import { ExportCancelledError, ExportFileWork, exportAborted } from './export-cancellation.js';

// Export engine (#97): the decrypt counterpart to import — selected photos
// become real files in a chosen folder. Streaming decrypt straight to the
// destination (plaintext only ever exists where the user asked for it),
// original filenames with a recorded numbered suffix on collision, progress
// n/total per file, and cancellation that retires active IO and
// keeps completed photo entries. v1 decision (recorded on #97): no
// encrypted-export format — the dialog's decrypt-off switch disables Export.
//
// #497 (ADR-0031 §6): every export declares ONE payload mode before bytes
// leave custody — Baked (the head edit stack rendered into a JPEG at an
// explicit quality), Original + sidecars (byte-identical original, retained
// companions, and a generated XMP for the supported subset of the edits), or
// Original only (byte-identical original, nothing beside it). Metadata
// retention stays its own policy. The preflight names every edit that cannot
// travel in the chosen mode; nothing is silently omitted.

export type ExportFormat = 'original' | 'jpeg';
export type ExportMetadataMode = 'original' | 'overlook' | 'none';

/** ADR-0032 §6 operation scope for one export: the recipient class of the
 * destination and the fields this operation narrows or widens once. Main
 * recompiles the plan from this; it is intent, never a field list. */
export interface ExportDisclosureIntent {
  readonly destination: DisclosureDestination;
  readonly operation: DisclosureOperation;
  /** Main-only continuation guard; never crosses IPC. */
  readonly assertCurrent?: () => void;
}

export const DEFAULT_EXPORT_DISCLOSURE: ExportDisclosureIntent = { destination: 'shared', operation: EMPTY_DISCLOSURE_OPERATION };

/** Compiles the disclosure plan for one photo and this export. */
export type ExportDisclosurePlanner = (photoId: string, intent: ExportDisclosureIntent) => DisclosurePlan;

/** The photo as the plan lets it be projected: withheld authored fields read
 * as absent, so the XMP projection cannot carry them. */
export function projectForDisclosure(photo: PhotoRecord, plan: DisclosurePlan): PhotoRecord {
  return {
    ...photo,
    title: discloses(plan, 'title') ? photo.title : null,
    description: discloses(plan, 'description') ? photo.description : null,
    tags: discloses(plan, 'tags') ? photo.tags : [],
  };
}
export type ExportPayloadMode = 'baked' | 'original-sidecars' | 'original';

export interface ExportEditOptions {
  /** Absent: `format: 'jpeg'` is Baked, everything else Original + sidecars. */
  readonly mode?: ExportPayloadMode | undefined;
  /** Baked JPEG quality (1–100). */
  readonly quality?: number | undefined;
}

export interface ExportEditLoss {
  readonly photoId: string;
  readonly fileName: string;
  readonly reason: string;
}

/** What the chosen mode does to the selection's edits (§6 preflight). */
export interface ExportEditsPreflight {
  /** Photos whose head revision is not the identity. */
  readonly edited: number;
  /** Edits the mode cannot carry; the user continues with the loss or picks another mode. */
  readonly losses: readonly ExportEditLoss[];
}

export function resolvePayloadMode(format: ExportFormat, edits: ExportEditOptions): ExportPayloadMode {
  return edits.mode ?? (format === 'jpeg' ? 'baked' : 'original-sidecars');
}

/** Embedded fields (inside the original bytes) the plan withholds for this
 * photo. Non-empty means the originals cannot leave under this plan. */
export function blockedEmbeddedFields(photo: PhotoRecord, plan: DisclosurePlan): readonly DisclosureField[] {
  return embeddedFieldsOf(photo).filter((field) => !discloses(plan, field));
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

/** Creates a portable XMP projection of Overlook-authored metadata and, in
 * the Original + sidecars mode, the supported subset of the head edits
 * (#497). The original file and retained source sidecars are never modified. */
export function authoredMetadataXmp(photo: PhotoRecord | null, transform: EditTransform = IDENTITY_TRANSFORM): Buffer | null {
  const authored = photo !== null && (photo.title !== null || photo.description !== null || photo.tags.length > 0);
  if (!authored && isIdentityTransform(transform)) return null;
  const title =
    photo?.title == null ? '' : `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(photo.title)}</rdf:li></rdf:Alt></dc:title>`;
  const description =
    photo?.description == null
      ? ''
      : `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xml(photo.description)}</rdf:li></rdf:Alt></dc:description>`;
  const tags =
    photo === null || photo.tags.length === 0
      ? ''
      : `<dc:subject><rdf:Bag>${photo.tags.map((tag) => `<rdf:li>${xml(tag)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`;
  return xmpPacket(editsXmpAttributes(transform), `${title}${description}${tags}`);
}

export interface ExportedFile {
  readonly photoId: string;
  readonly fileName: string;
  /** True when a collision forced a numbered suffix. */
  readonly renamed: boolean;
  /** True when a RAW transcoded from its embedded preview (#98) —
   * resolution honestly capped at preview size. */
  readonly fromPreview: boolean;
  /** Companion sidecars written beside this original (#484). */
  readonly sidecarNames: readonly string[];
  /** True when a non-identity edit stack was rendered into the pixels (#497). */
  readonly editsBaked: boolean;
  /** True when the edits travelled in a generated XMP beside the original (#497). */
  readonly editsInSidecar: boolean;
}

export interface ExportSummary {
  readonly exported: number;
  readonly failed: number;
  readonly cancelled: number;
  /** How many exports were preview-capped RAW transcodes (#98). */
  readonly previewTranscodes: number;
  /** Companion sidecars written beside their originals (#484). */
  readonly sidecarsExported: number;
  /** Files whose edits were rendered into the pixels (#497). */
  readonly bakedEdits: number;
  /** Generated XMP sidecars carrying edits (#497). */
  readonly editSidecars: number;
  readonly files: readonly ExportedFile[];
  /** Every source item that could not produce a destination file. */
  readonly failures: readonly ExportFailure[];
}

export interface ExportFailure {
  readonly photoId: string;
  readonly fileName: string;
  readonly reason: string;
  readonly custody?: PhotoCustodyStatus | undefined;
}

export class ExportPreflightError extends Error {
  override readonly name = 'ExportPreflightError';
}

export interface ExportEngineDeps {
  /** ADR-0032 §6 planner; absent = every field the boundary carries crosses (unit worlds). */
  readonly disclosure?: ExportDisclosurePlanner | undefined;
  readonly repo: { readonly get: (id: string) => PhotoRecord | undefined };
  readonly blobs: { readonly getStream: (contentHash: string, resolveKey: KeyResolver, photoId: string, signal?: AbortSignal) => Readable };
  /** Encrypted companion custody (#484); absent = no sidecar support. Only
   * 'original' format exports companions — a transcode is a baked export
   * whose recipe no longer applies (ADR-0031 §6). */
  readonly sidecarsFor?:
    | ((photoId: string) => readonly {
        readonly fileName: string;
        readonly contentHash: string;
        readonly keyId: number;
        readonly bytes: number;
        readonly ownerId?: string | undefined;
      }[])
    | undefined;
  readonly sidecarStream?: ((photoId: string, contentHash: string, signal?: AbortSignal) => Readable) | undefined;
  readonly resolveKey: KeyResolver;
  /** The head edit revision (#493); absent = no edits anywhere (#497). */
  readonly editHead?: ((photoId: string) => EditRevisionView | null) | undefined;
  /** Policy-aware original custody. Production uses this so offloaded
   * originals export from verified temporary ciphertext without becoming
   * durable; legacy/unit seams fall back to blobs.getStream. */
  readonly openOriginal?:
    | ((
        photo: PhotoRecord,
        signal?: AbortSignal,
      ) => Promise<{ readonly stream: Readable; readonly release?: (() => Promise<void>) | undefined }>)
    | undefined;
  /** Creates without clobbering; settles after terminal IO/own-partial cleanup,
   * including on failure. A writer owns its failed-open/partial-file decisions
   * (writeFileCleanly), while the scope disposes abandoned successful writes. */
  readonly writeFile: (path: string, plaintext: Readable, signal?: AbortSignal) => Promise<void>;
  /** Removes only successful, uncommitted outputs owned by this entry. */
  readonly removeFile?: ((path: string) => Promise<void>) | undefined;
  readonly exists: (path: string, signal?: AbortSignal) => Promise<boolean>;
  /** Free bytes on the destination volume (statfs seam). */
  readonly freeBytes: (dir: string, signal?: AbortSignal) => Promise<number>;
  readonly joinPath: (dir: string, name: string) => string;
  /** sharp transcode seam (#98) — src/main/export/transcode.ts in prod. */
  readonly transcodeJpeg: (bytes: Buffer, fileKind: PhotoRecord['fileKind'], options?: TranscodeOptions) => Promise<TranscodeResult>;
  /** Buffers a decrypt stream (transcode needs whole files). */
  readonly bufferStream: (stream: Readable, signal?: AbortSignal) => Promise<Buffer>;
  readonly events: { progress(done: number, total: number): void };
  /** Protected domains supply a redacted sink; ordinary exports retain the
   * existing filename/error diagnostics. */
  readonly failure?: ((photoId: string, error: unknown) => void) | undefined;
  readonly custodyStatus?: ((photoId: string, error: unknown) => Promise<PhotoCustodyStatus | undefined>) | undefined;
}

async function failureCustody(
  resolver: ExportEngineDeps['custodyStatus'],
  photoId: string,
  error: unknown,
): Promise<PhotoCustodyStatus | undefined> {
  try {
    return await resolver?.(photoId, error);
  } catch {
    return undefined;
  }
}

/**
 * The default writeFile seam: streams to `path` (never clobbering), and on
 * ANY failure — ENOSPC past the preflight, device errors, an authentication
 * failure mid-decrypt — removes the partial file so the destination never
 * holds a truncated "original" (PR #194 review).
 */
export async function writeFileCleanly(
  path: string,
  plaintext: Readable,
  signal?: AbortSignal,
  createOutput = (target: string) => createWriteStream(target, { flags: 'wx' }),
): Promise<void> {
  if (signal?.aborted === true) plaintext.destroy();
  signal?.throwIfAborted();
  const output = createOutput(path);
  let owned = false;
  output.once('open', () => {
    owned = true;
  });
  const closed = new Promise<void>((resolve) => output.once('close', resolve));
  try {
    await pipeline(plaintext, output, { signal });
  } catch (error) {
    // An OS open/write already in flight may finish after abort. Wait for its
    // descriptor to close before unlinking, and never unlink an EEXIST winner.
    await closed;
    if (owned) await rm(path, { force: true });
    throw error;
  }
}

function exportSummary(files: readonly ExportedFile[], failures: readonly ExportFailure[], cancelled: number): ExportSummary {
  return {
    exported: files.length,
    failed: failures.length,
    cancelled,
    previewTranscodes: files.filter((file) => file.fromPreview).length,
    sidecarsExported: files.reduce((sum, file) => sum + file.sidecarNames.length, 0),
    bakedEdits: files.filter((file) => file.editsBaked).length,
    editSidecars: files.filter((file) => file.editsInSidecar).length,
    files,
    failures,
  };
}

/** IMG_4021.RAF + '.jpg' → IMG_4021.jpg */
function reExtension(fileName: string, extension: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? `${fileName}${extension}` : `${fileName.slice(0, dot)}${extension}`;
}

/** IMG_4021.RAF → IMG_4021 (2).RAF */
function withSuffix(fileName: string, counter: number): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? `${fileName} (${String(counter)})` : `${fileName.slice(0, dot)} (${String(counter)})${fileName.slice(dot)}`;
}

export class ExportEngine {
  private readonly retiring = new Set<Promise<void>>();

  constructor(private readonly deps: ExportEngineDeps) {}

  /** §6 preflight: what the mode does to the selection's edits. An operation
   * this build does not know can neither bake nor serialize; Original only
   * omits every edit by design and reports the count instead of a loss. */
  preflightEdits(photoIds: readonly string[], mode: ExportPayloadMode): ExportEditsPreflight {
    let edited = 0;
    const losses: ExportEditLoss[] = [];
    for (const id of photoIds) {
      const photo = this.deps.repo.get(id);
      const head = photo === undefined ? null : (this.deps.editHead?.(photo.id) ?? null);
      if (photo === undefined || head === null) continue;
      if (head.unsupported === null && isIdentityTransform(head.transform)) continue;
      edited += 1;
      if (mode !== 'original' && head.unsupported !== null) {
        losses.push({ photoId: photo.id, fileName: photo.fileName, reason: head.unsupported });
      }
    }
    return { edited, losses };
  }

  async exportPhotos(
    photoIds: readonly string[],
    destination: string,
    signal?: AbortSignal,
    format: ExportFormat = 'original',
    metadata: ExportMetadataMode = 'original',
    edits: ExportEditOptions = {},
    disclosure: ExportDisclosureIntent = DEFAULT_EXPORT_DISCLOSURE,
  ): Promise<ExportSummary> {
    disclosure.assertCurrent?.();
    const mode = resolvePayloadMode(format, edits);
    const photos = photoIds.map((id) => this.deps.repo.get(id));
    // Refuse the batch before any unlocked member can cross the boundary.
    // UI filtering is advisory; callers must not turn absent-key custody into
    // partial output or one decryption failure per locked file (#1133).
    if (photos.some((photo) => photo?.locked === true)) {
      throw new ExportPreflightError('Locked photos cannot be exported. Import their missing encryption keys on this device and retry.');
    }
    if (
      mode === 'original-sidecars' &&
      metadata === 'original' &&
      photos.some(
        (photo) =>
          photo !== undefined &&
          (this.deps.sidecarsFor?.(photo.id) ?? []).some((sidecar) => this.deps.resolveKey(sidecar.keyId) === undefined),
      )
    ) {
      throw new ExportPreflightError(
        'Locked companion files cannot be exported. Import their missing encryption keys on this device and retry.',
      );
    }
    // ADR-0032 §6: the plan is compiled here, per photo, from intent. The
    // authored projection carries only disclosed fields; originals carry
    // embedded fields as they are, so a withheld embedded field refuses the
    // run before any byte moves — widen it for this export or bake.
    const plans = new Map(
      photos.flatMap((photo) =>
        photo === undefined
          ? []
          : [[photo.id, this.deps.disclosure?.(photo.id, disclosure) ?? permissivePlan('export', disclosure.destination)] as const],
      ),
    );
    if (mode !== 'baked') {
      const blocked = new Map<DisclosureField, number>();
      for (const photo of photos) {
        if (photo === undefined) continue;
        for (const field of blockedEmbeddedFields(photo, plans.get(photo.id) ?? permissivePlan('export'))) {
          blocked.set(field, (blocked.get(field) ?? 0) + 1);
        }
      }
      if (blocked.size > 0) {
        throw new ExportPreflightError(
          `disclosure: ${[...blocked.entries()].map(([field, count]) => `${field} (${String(count)})`).join(', ')} would leave inside the original bytes — include them for this export or export Baked`,
        );
      }
    }
    const projected = (photo: PhotoRecord): PhotoRecord => projectForDisclosure(photo, plans.get(photo.id) ?? permissivePlan('export'));
    const preflight = new ExportFileWork(signal, (error) => this.reportFailure('preflight', error), this.deps.removeFile);
    let transforms = new Map<string, EditTransform>();
    try {
      if (mode === 'original-sidecars' && metadata === 'original') {
        for (const photo of photos) {
          if (photo === undefined) continue;
          for (const sidecar of this.deps.sidecarsFor?.(photo.id) ?? []) {
            const inspection = await preflight.wait(() =>
              inspectSourceSidecar(
                sidecar,
                () => {
                  if (this.deps.sidecarStream === undefined) throw new Error('Source sidecar reader unavailable');
                  return this.deps.sidecarStream(sidecar.ownerId ?? photo.id, sidecar.contentHash, signal);
                },
                signal,
              ),
            );
            const finding = sourceSidecarFinding(photo.id, sidecar, inspection, plans.get(photo.id) ?? permissivePlan('export'));
            if (finding.refused) throw new ExportPreflightError(sourceSidecarRefusal(finding));
          }
        }
        disclosure.assertCurrent?.();
      }
      transforms = new Map(
        photos.flatMap((photo) => {
          if (photo === undefined) return [];
          const head = this.deps.editHead?.(photo.id) ?? null;
          return [[photo.id, head === null || head.unsupported !== null ? IDENTITY_TRANSFORM : head.transform] as const];
        }),
      );
      // Free-space preflight: the sum of plaintext sizes must fit BEFORE any
      // bytes move — a mid-batch ENOSPC helps nobody. Sidecar bytes count too.
      const needed =
        photos.reduce((sum, photo) => sum + (photo?.bytes ?? 0), 0) +
        (mode === 'original-sidecars' && metadata === 'original'
          ? photos.reduce(
              (sum, photo) =>
                sum +
                (photo === undefined ? 0 : (this.deps.sidecarsFor?.(photo.id) ?? []).reduce((inner, sidecar) => inner + sidecar.bytes, 0)),
              0,
            )
          : 0) +
        (mode === 'original'
          ? 0
          : photos.reduce(
              (sum, photo) =>
                sum +
                (photo === undefined
                  ? 0
                  : (authoredMetadataXmp(
                      metadata === 'overlook' ? projected(photo) : null,
                      mode === 'baked' ? IDENTITY_TRANSFORM : (transforms.get(photo.id) ?? IDENTITY_TRANSFORM),
                    )?.length ?? 0)),
              0,
            ));
      const free = await preflight.wait(() => this.deps.freeBytes(destination, signal));
      if (needed > free) {
        throw new ExportPreflightError(`destination needs ${String(needed)} bytes free, has ${String(free)}`);
      }
    } catch (error) {
      if (error instanceof ExportCancelledError) return exportSummary([], [], photoIds.length);
      throw error;
    } finally {
      const retirement = this.retire(preflight, true);
      try {
        await preflight.wait(() => retirement);
      } catch (error) {
        if (!(error instanceof ExportCancelledError)) this.reportFailure('cleanup', error);
      }
    }

    const files: ExportedFile[] = [];
    const failures: ExportFailure[] = [];
    const total = photoIds.length;
    let done = 0;
    let cancelled = 0;
    for (const [index, id] of photoIds.entries()) {
      disclosure.assertCurrent?.();
      if (exportAborted(signal)) {
        // Finished photo entries stay committed; an active entry is retired
        // by its abort-aware scope before another batch may start.
        cancelled = total - index;
        break;
      }
      const photo = photos[index];
      let releaseOriginal: (() => Promise<void>) | undefined;
      let completed = false;
      const work = new ExportFileWork(signal, (error) => this.reportFailure(id, error), this.deps.removeFile);
      try {
        if (photo === undefined) {
          throw new Error(`photo ${id} is not in the library`);
        }
        const transform = transforms.get(photo.id) ?? IDENTITY_TRANSFORM;
        const unsupported = this.deps.editHead?.(photo.id)?.unsupported ?? null;
        if (mode === 'baked' && unsupported !== null) {
          throw new Error(
            `edit stack has an operation this build cannot render (${unsupported}) — export as Original + XMP or Original only`,
          );
        }
        const openOriginal = this.deps.openOriginal;
        const opened =
          openOriginal === undefined
            ? null
            : await work.wait(
                () => openOriginal(photo, signal),
                async (late) => {
                  late.stream.destroy();
                  await late.release?.();
                },
              );
        releaseOriginal = opened?.release;
        const stream = work.own(
          opened?.stream ?? this.deps.blobs.getStream(photo.contentHash, this.deps.resolveKey, assetOwnerOf(photo), signal),
        );
        let plaintext: Readable = stream;
        const safeSourceName = sanitizeExportFileName(photo.fileName, photo.id);
        const nominalTargetName = mode === 'baked' ? reExtension(photo.fileName, '.jpg') : photo.fileName;
        let targetName = safeSourceName;
        let fromPreview = false;
        if (mode === 'baked') {
          const bytes = await work.wait(() => this.deps.bufferStream(stream, signal));
          const { jpeg, fromPreview: capped } = await work.wait(() =>
            this.deps.transcodeJpeg(bytes, photo.fileKind, {
              transform,
              quality: edits.quality,
              signal,
            }),
          );
          plaintext = Readable.from([jpeg]);
          targetName = reExtension(safeSourceName, '.jpg');
          fromPreview = capped;
        }
        const fileName = await this.resolveCollision(destination, targetName, work);
        disclosure.assertCurrent?.();
        await work.write(this.containedPath(destination, fileName), plaintext, this.deps.writeFile);
        const editsTravel = mode === 'original-sidecars' && !isIdentityTransform(transform);
        // The generated packet owns the canonical stem (`IMG.xmp`): sidecar
        // consumers associate XMP by stem, so it is written first and, under
        // Metadata: Source (`metadata === 'original'`), a retained companion
        // that would take the same name is preserved under the collision suffix
        // rather than displacing the edits. Metadata: Edits (`'overlook'`) and
        // None omit unfiltered source companions (ADR-0032 §6, #1142, #1438).
        const sidecarNames =
          mode === 'original'
            ? []
            : [
                ...(await this.exportAuthoredMetadata(
                  metadata === 'overlook' ? projected(photo) : null,
                  editsTravel ? transform : IDENTITY_TRANSFORM,
                  destination,
                  fileName,
                  work,
                )),
                ...(mode === 'original-sidecars' && metadata === 'original'
                  ? await this.exportSidecars(photo, destination, fileName, disclosure, work)
                  : []),
              ];
        work.check();
        files.push({
          photoId: photo.id,
          fileName,
          renamed: fileName !== nominalTargetName,
          fromPreview,
          sidecarNames,
          editsBaked: mode === 'baked' && !isIdentityTransform(transform),
          editsInSidecar: editsTravel,
        });
        completed = true;
      } catch (error) {
        if (error instanceof ExportCancelledError) {
          cancelled = total - index;
          break;
        }
        const reason = error instanceof Error ? error.message : String(error);
        const failure: ExportFailure = { photoId: id, fileName: photo?.fileName ?? id, reason };
        failures.push(failure);
        try {
          const custody = photo === undefined ? undefined : await work.wait(() => failureCustody(this.deps.custodyStatus, photo.id, error));
          if (custody !== undefined) failures[failures.length - 1] = { ...failure, custody };
        } catch {
          /* Cancellation stops optional failure enrichment, not the recorded IO failure. */
        }
        this.reportFailure(id, error, photo?.fileName);
      } finally {
        const retirement = this.retire(work, completed, releaseOriginal);
        try {
          await work.wait(() => retirement);
        } catch (error) {
          if (!(error instanceof ExportCancelledError)) this.reportFailure('cleanup', error);
        }
      }
      done += 1;
      this.deps.events.progress(done, total);
    }
    return exportSummary(files, failures, cancelled);
  }

  /** Acknowledgement is separate from native/OS retirement. Queue and lock
   * drains must not claim an abandoned operation has physically stopped. */
  async drain(): Promise<void> {
    while (this.retiring.size > 0) await Promise.all([...this.retiring]);
  }

  private retire(work: ExportFileWork, completed: boolean, release?: () => Promise<void>): Promise<void> {
    const retirement = work.retire(completed, release).catch((error: unknown) => this.reportFailure('cleanup', error));
    this.retiring.add(retirement);
    void retirement.then(() => this.retiring.delete(retirement));
    return retirement;
  }

  private reportFailure(photoId: string, error: unknown, fileName = photoId): void {
    try {
      if (this.deps.failure !== undefined) this.deps.failure(photoId, error);
      else console.error(`[overlook] export failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // A closed diagnostic sink must not abandon cleanup or custody release.
    }
  }

  /** Writes each companion beside the exported original, named from the
   * original's RESOLVED stem so a suffixed export keeps its group together
   * (`IMG (2).RAF` → `IMG (2).xmp`), with per-file collision fallback. */
  private async exportSidecars(
    photo: PhotoRecord,
    destination: string,
    resolvedName: string,
    disclosure: ExportDisclosureIntent,
    work: ExportFileWork,
  ): Promise<readonly string[]> {
    const sidecars = this.deps.sidecarsFor?.(photo.id) ?? [];
    const sidecarStream = this.deps.sidecarStream;
    if (sidecars.length === 0 || sidecarStream === undefined) return [];
    const dot = resolvedName.lastIndexOf('.');
    const stem = dot <= 0 ? resolvedName : resolvedName.slice(0, dot);
    const written: string[] = [];
    for (const sidecar of sidecars) {
      const bytes = await work.wait(() =>
        readSourceSidecar(sidecar, () => sidecarStream(sidecar.ownerId ?? photo.id, sidecar.contentHash, work.signal), work.signal),
      );
      disclosure.assertCurrent?.();
      const plan = this.deps.disclosure?.(photo.id, disclosure) ?? permissivePlan('export', disclosure.destination);
      const finding = sourceSidecarFinding(photo.id, sidecar, inspectSourceXmp(sidecar.fileName, bytes), plan);
      if (finding.refused) throw new ExportPreflightError(sourceSidecarRefusal(finding));
      const extension = sanitizeSidecarExtension(sidecar.fileName);
      const target = await this.resolveCollision(destination, `${stem}${extension}`, work);
      disclosure.assertCurrent?.();
      await work.write(this.containedPath(destination, target), Readable.from([bytes]), this.deps.writeFile);
      written.push(target);
    }
    return written;
  }

  private async exportAuthoredMetadata(
    photo: PhotoRecord | null,
    transform: EditTransform,
    destination: string,
    resolvedName: string,
    work: ExportFileWork,
  ): Promise<readonly string[]> {
    const xmp = authoredMetadataXmp(photo, transform);
    if (xmp === null) return [];
    const dot = resolvedName.lastIndexOf('.');
    const stem = dot <= 0 ? resolvedName : resolvedName.slice(0, dot);
    const target = await this.resolveCollision(destination, `${stem}.xmp`, work);
    await work.write(this.containedPath(destination, target), Readable.from([xmp]), this.deps.writeFile);
    return [target];
  }

  private async resolveCollision(destination: string, fileName: string, work: ExportFileWork): Promise<string> {
    if (!(await work.wait(() => this.deps.exists(this.containedPath(destination, fileName), work.signal)))) {
      return fileName;
    }
    for (let counter = 1; ; counter += 1) {
      const candidate = withSuffix(fileName, counter);
      if (!(await work.wait(() => this.deps.exists(this.containedPath(destination, candidate), work.signal)))) {
        return candidate;
      }
    }
  }

  private containedPath(destination: string, fileName: string): string {
    return resolveContainedExportPath(this.deps.joinPath, destination, fileName);
  }
}
