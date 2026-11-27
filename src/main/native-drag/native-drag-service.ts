import { open as openFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { encodePhotoDrag, type PhotoDragPayload } from '../../shared/library/photo-drag.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';
import { BOUNDARY_FIELDS, type DisclosureField, type DisclosurePlan } from '../../shared/disclosure/policy.js';
import type { DisclosurePlanner } from '../disclosure/disclosure-service.js';
import type { ActivityFacade } from '../activity/activity-publication.js';
import { NativeDragDisclosureError, nativeDragActivity, nativeOriginalFields } from './native-drag-disclosure.js';
import type { NativeDragBridge, NativeDragUnavailableReason, NativePromiseItem } from './native-drag-bridge.js';

export type NativeDragStartReason = NativeDragUnavailableReason | 'content-unavailable' | 'disclosure-withheld';

interface OpenedOriginal {
  readonly stream: Readable;
  readonly release?: (() => Promise<void>) | undefined;
}

export interface NativeDragOutDeps {
  readonly disclosure: DisclosurePlanner;
  readonly activity?: (() => ActivityFacade | undefined) | undefined;
  readonly bridge: NativeDragBridge;
  readonly getPhoto: (photoId: string) => PhotoRecord | undefined;
  readonly openOriginal: (photo: PhotoRecord, signal: AbortSignal) => Promise<OpenedOriginal>;
  readonly isMigrating?: ((photoId: string) => boolean) | undefined;
  readonly admit: () => boolean;
  readonly writeFile?: ((destinationPath: string, stream: Readable, signal: AbortSignal) => Promise<void>) | undefined;
}

async function* checkedChunks(stream: Readable, check: () => void): AsyncGenerator<unknown> {
  const chunks: AsyncIterable<unknown> = stream;
  for await (const chunk of chunks) {
    check();
    yield chunk;
  }
}

interface PromiseRecord {
  readonly item: NativePromiseItem;
  readonly photo: PhotoRecord;
}

interface QueuedMaterialization {
  readonly signal: AbortSignal;
  readonly run: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

function withSuffix(fileName: string, counter: number): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? `${fileName} (${String(counter)})` : `${fileName.slice(0, dot)} (${String(counter)})${fileName.slice(dot)}`;
}

export function uniquePromiseNames(fileNames: readonly string[]): string[] {
  const used = new Set<string>();
  return fileNames.map((candidate) => {
    const normalized = candidate.normalize('NFC');
    const safe = path.basename(normalized);
    if (safe !== normalized) throw new Error('invalid drag filename');
    if (safe === '' || safe === '.' || safe === '..' || safe.includes('\0')) throw new Error('invalid drag filename');
    let output = safe;
    let counter = 2;
    while (used.has(output.toLocaleLowerCase('en-US'))) {
      output = withSuffix(safe, counter);
      counter += 1;
    }
    used.add(output.toLocaleLowerCase('en-US'));
    return output;
  });
}

async function writeReceiverFile(destinationPath: string, stream: Readable, signal: AbortSignal): Promise<void> {
  let created = false;
  try {
    const handle = await openFile(destinationPath, 'wx');
    created = true;
    await pipeline(stream, handle.createWriteStream(), { signal });
  } catch (error) {
    stream.destroy();
    if (created) await rm(destinationPath, { force: true });
    throw error;
  }
}

async function discardOpenedOriginal(opened: OpenedOriginal): Promise<void> {
  opened.stream.destroy();
  await opened.release?.();
}

async function awaitOpenedOriginal(opening: Promise<OpenedOriginal>, signal: AbortSignal): Promise<OpenedOriginal> {
  if (signal.aborted) {
    void opening.then(discardOpenedOriginal).catch(() => undefined);
    throw new Error('drag cancelled');
  }
  let aborted = false;
  let rejectAbort: ((error: Error) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    aborted = true;
    rejectAbort?.(new Error('drag cancelled'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([opening, abort]);
  } catch (error) {
    if (aborted) void opening.then(discardOpenedOriginal).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function fileType(photo: PhotoRecord): string {
  return photo.fileKind === 'jpeg'
    ? 'public.jpeg'
    : photo.fileKind === 'png'
      ? 'public.png'
      : photo.fileKind === 'gif'
        ? 'com.compuserve.gif'
        : photo.fileKind === 'heic'
          ? 'public.heic'
          : photo.fileKind === 'video'
            ? 'public.movie'
            : 'public.data';
}

export class NativeDragOutService {
  private controller: AbortController | null = null;
  private closed = false;
  private active = 0;
  private readonly queue: QueuedMaterialization[] = [];
  private readonly activeTasks = new Set<Promise<void>>();

  constructor(private readonly deps: NativeDragOutDeps) {}

  status(): { readonly available: boolean; readonly reason: NativeDragUnavailableReason | null } {
    return this.deps.bridge.status();
  }

  start(
    windowHandle: Buffer,
    input: Omit<PhotoDragPayload, 'version'>,
  ): { readonly started: boolean; readonly reason: NativeDragStartReason | null; readonly withheld?: readonly DisclosureField[] } {
    const status = this.status();
    if (!status.available) return { started: false, reason: status.reason };
    if (this.closed || !this.deps.admit()) return { started: false, reason: 'content-unavailable' };
    const ids = [...new Set(input.photoIds)];
    if (ids.length === 0 || ids.length > 100) return { started: false, reason: 'content-unavailable' };
    const photos = ids.map((id) => this.deps.getPhoto(id));
    if (photos.some((photo) => photo === undefined || photo.deletedAt !== null || this.deps.isMigrating?.(photo.id) === true)) {
      return { started: false, reason: 'content-unavailable' };
    }
    const available = photos.filter((photo): photo is PhotoRecord => photo !== undefined);
    const withheld = new Set<DisclosureField>();
    try {
      for (const photo of available) {
        try {
          this.current(photo);
        } catch (error) {
          if (!(error instanceof NativeDragDisclosureError)) throw error;
          for (const field of error.fields) withheld.add(field);
        }
      }
    } catch {
      return { started: false, reason: 'content-unavailable' };
    }
    if (withheld.size > 0)
      return { started: false, reason: 'disclosure-withheld', withheld: BOUNDARY_FIELDS.export.filter((field) => withheld.has(field)) };
    const names = uniquePromiseNames(available.map((photo) => photo.fileName));
    const records = new Map<string, PromiseRecord>();
    for (const [index, photo] of available.entries()) {
      const token = randomUUID();
      const item = { token, fileName: names[index]!, fileType: fileType(photo) };
      records.set(token, { item, photo });
    }
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const started = this.deps.bridge.start({
      windowHandle,
      items: [...records.values()].map(({ item }) => item),
      internalPayload: encodePhotoDrag({ version: 1, photoIds: ids, sourceAlbumId: input.sourceAlbumId }),
      materialize: ({ token, destinationPath }) =>
        this.schedule(() => this.materialize(records, token, destinationPath, controller.signal), controller.signal),
      // A file-promise receiver may ask for bytes after AppKit reports that
      // the pointer session ended. Keep the authority controller until the
      // next drag or library close so Locking can still revoke that work.
      ended: () => undefined,
    });
    if (!started) {
      controller.abort();
      this.controller = null;
    }
    return { started, reason: started ? null : 'native-unavailable' };
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.deps.bridge.cancelAll();
    this.pump();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.deps.bridge.close();
  }

  async drain(): Promise<void> {
    this.pump();
    while (this.activeTasks.size > 0) await Promise.allSettled([...this.activeTasks]);
  }

  private current(original: PhotoRecord, signal?: AbortSignal): { photo: PhotoRecord; plan: DisclosurePlan } {
    if (this.closed || signal?.aborted === true || !this.deps.admit()) throw new Error('drag content unavailable');
    const photo = this.deps.getPhoto(original.id);
    if (
      photo === undefined ||
      photo.deletedAt !== null ||
      photo.locked ||
      this.deps.isMigrating?.(photo.id) === true ||
      photo.contentHash !== original.contentHash ||
      photo.fileKind !== original.fileKind ||
      assetOwnerOf(photo) !== assetOwnerOf(original)
    )
      throw new Error('drag content unavailable');
    const plan = this.deps.disclosure.plan(photo.id, 'export', 'public');
    nativeOriginalFields(plan);
    return { photo, plan };
  }

  private async materialize(
    records: ReadonlyMap<string, PromiseRecord>,
    token: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const record = records.get(token);
    if (record === undefined || signal.aborted || !this.deps.admit()) throw new Error('drag content unavailable');
    if (!path.isAbsolute(destinationPath)) {
      throw new Error('invalid drag destination');
    }
    const current = this.current(record.photo, signal);
    const opened = await awaitOpenedOriginal(this.deps.openOriginal(current.photo, signal), signal);
    let checked: Readable | undefined;
    try {
      this.current(record.photo, signal);
      checked = Readable.from(
        checkedChunks(opened.stream, () => {
          this.current(record.photo, signal);
        }),
        { objectMode: false, signal },
      );
      // An aborted receiver can stop consuming before this stream emits its error.
      checked.on('error', () => undefined);
      await (this.deps.writeFile ?? writeReceiverFile)(destinationPath, checked, signal);
      let completed: ReturnType<NativeDragOutService['current']>;
      try {
        completed = this.current(record.photo, signal);
      } catch (error) {
        await rm(destinationPath, { force: true });
        throw error;
      }
      this.deps.activity?.()?.record(nativeDragActivity(completed.photo, completed.plan));
    } finally {
      checked?.destroy();
      await discardOpenedOriginal(opened);
    }
  }

  private schedule(run: () => Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queued: QueuedMaterialization = { signal, run, resolve, reject, settled: false };
      signal.addEventListener(
        'abort',
        () => {
          if (queued.settled) return;
          queued.settled = true;
          reject(new Error('drag cancelled'));
        },
        { once: true },
      );
      this.queue.push(queued);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < 2) {
      const queued = this.queue.shift();
      if (queued === undefined) return;
      if (queued.settled || queued.signal.aborted) continue;
      this.active += 1;
      const running = queued
        .run()
        .then(
          () => {
            if (!queued.settled) {
              queued.settled = true;
              queued.resolve();
            }
          },
          (error: unknown) => {
            if (!queued.settled) {
              queued.settled = true;
              queued.reject(error);
            }
          },
        )
        .finally(() => {
          this.active -= 1;
          this.activeTasks.delete(running);
          this.pump();
        });
      this.activeTasks.add(running);
    }
  }
}
