import { addAbortSignal } from 'node:stream';
import { access, statfs } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';

import type { ProtectedLibraryService } from '../library/protected-library-service.js';
import { ExportEngine, writeFileCleanly, type ExportFormat } from './export-engine.js';
import { transcodeToJpeg } from './transcode.js';

export interface ProtectedExportFacade {
  run(
    albumId: string,
    photoIds: readonly string[],
    destination: string,
    format?: ExportFormat,
  ): Promise<{ exported: number; failed: number; cancelled: number; previewTranscodes: number }>;
  cancel(): void;
  pickDestination(): Promise<string | null>;
}

export type DrainableProtectedExportFacade = ProtectedExportFacade & { close(): void; drain(): Promise<void> };

export interface ProtectedExportRuntimeOptions {
  readonly library: ProtectedLibraryService;
  readonly progress: (done: number, total: number) => void;
  readonly pickDestination: () => Promise<string | null>;
  readonly failure?: (() => void) | undefined;
}

export function createProtectedExportRuntime(options: ProtectedExportRuntimeOptions): DrainableProtectedExportFacade {
  let controller: AbortController | null = null;
  let turn: Promise<unknown> = Promise.resolve();
  let closed = false;
  return {
    run: (albumId, photoIds, destination, format) => {
      let engine: ExportEngine | undefined;
      const task = async () => {
        if (closed) throw new Error('protected export service is closed');
        controller = new AbortController();
        engine = new ExportEngine({
          repo: {
            get: (photoId) => {
              try {
                return options.library.exportPhoto(albumId, photoId);
              } catch {
                return undefined;
              }
            },
          },
          blobs: {
            getStream: () => {
              throw new Error('protected export requires album authority');
            },
          },
          resolveKey: () => undefined,
          openOriginal: (photo) => {
            const opened = options.library.openOriginal(albumId, photo.id);
            return Promise.resolve({ stream: opened.stream, release: opened.release });
          },
          writeFile: writeFileCleanly,
          exists: async (filePath) =>
            access(filePath).then(
              () => true,
              () => false,
            ),
          freeBytes: async (dir) => {
            const stats = await statfs(dir);
            return stats.bavail * stats.bsize;
          },
          joinPath: (dir, name) => path.join(dir, name),
          transcodeJpeg: transcodeToJpeg,
          bufferStream: async (stream, signal) => buffer(signal === undefined ? stream : addAbortSignal(signal, stream)),
          events: { progress: options.progress },
          failure: () => options.failure?.(),
        });
        try {
          const summary = await engine.exportPhotos(photoIds, destination, controller.signal, format);
          return {
            exported: summary.exported,
            failed: summary.failed,
            cancelled: summary.cancelled,
            previewTranscodes: summary.previewTranscodes,
          };
        } finally {
          controller = null;
        }
      };
      const next = turn.then(task, task);
      turn = next.then(
        () => engine?.drain(),
        () => engine?.drain(),
      );
      return next;
    },
    cancel: () => controller?.abort(),
    close: () => {
      closed = true;
      controller?.abort();
    },
    drain: () =>
      turn.then(
        () => undefined,
        () => undefined,
      ),
    pickDestination: options.pickDestination,
  };
}
