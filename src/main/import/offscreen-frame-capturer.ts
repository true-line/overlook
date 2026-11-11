import path from 'node:path';

import electron from 'electron';

import { installWindowNavigationPolicy } from '../window-navigation-policy.js';
import type { CapturedPosterFrame } from './poster-capture-service.js';
import type { PhotoRecord } from '../../shared/library/types.js';

// The §6 offscreen frame capturer: one hidden offscreen renderer decodes a
// video's first frame at t=0 and reports its dimensions via the page title; the
// main process then captures the painted page. Bounded by a hard wall-clock cap
// and a pixel cap (§9): a capture that overruns is killed and yields null, so
// the item simply keeps its placeholder tile. Single capture at a time is
// guaranteed by the sequential PosterCaptureService. This path only ever runs
// in the packaged app (real Electron media decode); the service that drives it
// is unit-tested against a mock capturer.

const READY_PREFIX = 'overlook-poster:ready:';
const ERROR_SIGNAL = 'overlook-poster:error';
const CAPTURE_TIMEOUT_MS = 10_000;
const MAX_DIMENSION = 2048;
const PAINT_SETTLE_MS = 150;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Scales a frame down to the pixel cap, preserving aspect; invalid input → a
 * safe default so capturePage still returns something the sharp chain resizes. */
function capDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1280, height: 720 };
  }
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function captureUrl(photo: PhotoRecord): { dev: string | null; query: Record<string, string> } {
  const query = { photo: photo.id, ts: photo.mediaInfo?.container === 'MPEG-TS' ? '1' : '0' };
  const devBase = process.env['ELECTRON_RENDERER_URL'];
  if (devBase === undefined) return { dev: null, query };
  const url = new URL('capture.html', devBase.endsWith('/') ? devBase : `${devBase}/`);
  url.searchParams.set('photo', query.photo);
  url.searchParams.set('ts', query.ts);
  return { dev: url.toString(), query };
}

/**
 * Captures PNG bytes and uncapped decoder dimensions, or null when no
 * frame decodes within the wall-clock budget (the caller keeps the placeholder).
 * Never throws.
 */
export async function captureVideoPosterFrame(photo: PhotoRecord, signal: AbortSignal): Promise<CapturedPosterFrame | null> {
  if (signal.aborted) return null;
  const win = new electron.BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  installWindowNavigationPolicy(win.webContents);

  return await new Promise<CapturedPosterFrame | null>((resolve) => {
    let settled = false;
    const finish = (value: CapturedPosterFrame | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);
    const onAbort = (): void => finish(null);
    signal.addEventListener('abort', onAbort);

    win.webContents.on('page-title-updated', (_event, title) => {
      if (title === ERROR_SIGNAL) {
        finish(null);
        return;
      }
      if (!title.startsWith(READY_PREFIX)) return;
      const [w, h] = title
        .slice(READY_PREFIX.length)
        .split('x')
        .map((value) => Number(value));
      void (async () => {
        try {
          const { width, height } = capDimensions(w ?? 0, h ?? 0);
          win.setContentSize(width, height);
          await delay(PAINT_SETTLE_MS);
          if (settled || win.isDestroyed()) return;
          const image = await win.webContents.capturePage();
          finish(
            image.isEmpty()
              ? null
              : {
                  bytes: image.toPNG(),
                  sourceDimensions:
                    w !== undefined && h !== undefined && Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0
                      ? { width: w, height: h }
                      : null,
                },
          );
        } catch {
          finish(null);
        }
      })();
    });
    win.webContents.on('render-process-gone', () => finish(null));

    const { dev, query } = captureUrl(photo);
    const load = dev !== null ? win.loadURL(dev) : win.loadFile(path.join(import.meta.dirname, '../renderer/capture.html'), { query });
    load.catch(() => finish(null));
  });
}
