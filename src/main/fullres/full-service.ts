import { Readable } from 'node:stream';

import { resolveRawPreview } from '../import/raw-preview.js';
import { resolveHeicPreview } from '../import/heic-preview.js';
import { ByteLru } from '../cache/byte-lru.js';
import type { FileKind } from '../../shared/library/types.js';
import { resolveByteRange } from './byte-range.js';
import { sliceStream, videoHeaders } from './video-stream.js';

// Full-resolution decrypt-to-view delivery (#91): originals decrypt into a
// byte-capped in-memory LRU and are served over overlook-full:// — plaintext
// never touches disk (ADR-0004). RAW records resolve to a *viewable* payload
// per ADR-0006: a validated embedded preview or a bounded native decode,
// flagged `preview` so the UI can badge it. A RAW with no viewable payload
// is a placeholder (null), never a failure.

export interface LoadedOriginal {
  readonly bytes: Buffer;
  readonly contentHash: string;
  readonly fileKind: FileKind;
}

export interface FullPayload {
  readonly bytes: Buffer;
  readonly contentHash: string;
  readonly mime: string;
  /** True when this is a RAW's embedded preview, not a full render. */
  readonly preview: boolean;
}

/** A streamable, range-served video original (ADR-0026 §5) — never LRU-cached. */
export interface VideoOriginal {
  readonly stream: Readable;
  readonly totalBytes: number;
  readonly mime: string;
}

/** The 200/206/416 descriptor for a video request; `body` is a web stream so
 * Electron's protocol handler streams it without buffering the whole clip. */
export interface VideoResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface FullServiceOptions {
  /** Resolves and decrypts an original; null = missing/offloaded. */
  readonly loadOriginal: (photoId: string, purpose: 'view' | 'prefetch') => Promise<LoadedOriginal | null>;
  /** Opens a decrypting read stream for a `video` original (ADR-0026 §5);
   * null when the photo is missing or not a streamable video. */
  readonly openVideoStream?: ((photoId: string) => Promise<VideoOriginal | null>) | undefined;
  /** Rechecked before and after cache/decrypt work. False revokes plaintext. */
  readonly admit?: ((photoId: string) => boolean) | undefined;
  /** LRU cap over decrypted full-res bytes. Default 256 MiB. */
  readonly maxCacheBytes?: number | undefined;
  /** Concurrent decrypts. Default 2 — full-res reads are large. */
  readonly maxConcurrent?: number | undefined;
}

const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_CONCURRENT = 2;

// GIF/WebP serve their ORIGINAL bytes (never a converted preview) so the
// renderer's <img> plays animation with source timing/loop (ADR-0026 §5).
const MIME_BY_KIND: Partial<Record<FileKind, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export class FullService {
  private readonly loadOriginal: FullServiceOptions['loadOriginal'];
  private readonly openVideoStream: FullServiceOptions['openVideoStream'];
  private readonly admit: NonNullable<FullServiceOptions['admit']>;
  private readonly lru: ByteLru<FullPayload>;

  constructor(options: FullServiceOptions) {
    this.loadOriginal = options.loadOriginal;
    this.openVideoStream = options.openVideoStream;
    this.admit = options.admit ?? (() => true);
    this.lru = new ByteLru({
      maxCacheBytes: options.maxCacheBytes ?? DEFAULT_CACHE_BYTES,
      maxConcurrent: options.maxConcurrent ?? DEFAULT_CONCURRENT,
    });
  }

  /**
   * The viewable full-res payload, or null when the photo/original is
   * missing, the RAW has no viewable preview, or `signal` aborts while the
   * request is still queued (rapid paging never spends decrypt work on
   * frames the user already left).
   */
  async getFull(photoId: string, signal?: AbortSignal): Promise<FullPayload | null> {
    if (!this.admit(photoId)) {
      this.invalidate(photoId);
      return null;
    }
    const payload = await this.lru.get(photoId, () => this.resolvePayload(photoId, 'view'), signal);
    if (!this.admit(photoId)) {
      this.invalidate(photoId);
      return null;
    }
    return payload;
  }

  /**
   * Range-served video delivery (ADR-0026 §5). Streams the decrypted original
   * for a `Range` (206) or the whole clip (200) without touching the image
   * LRU; returns null when the photo is not a streamable video (the caller
   * falls back to the still path), or a 416 when the range is unsatisfiable.
   * The admit gate is rechecked before the stream opens.
   */
  async videoResponse(photoId: string, rangeHeader: string | null): Promise<VideoResponse | null> {
    if (this.openVideoStream === undefined) return null;
    if (!this.admit(photoId)) {
      this.invalidate(photoId);
      return null;
    }
    const original = await this.openVideoStream(photoId);
    if (original === null) return null;
    if (!this.admit(photoId)) {
      original.stream.destroy();
      this.invalidate(photoId);
      return null;
    }
    const range = resolveByteRange(rangeHeader, original.totalBytes);
    if (range.kind === 'unsatisfiable') {
      original.stream.destroy();
      return {
        status: 416,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Range': `bytes */${String(original.totalBytes)}`,
        },
        body: null,
      };
    }
    const { status, headers } = videoHeaders(range, original.totalBytes, original.mime);
    const node = range.kind === 'partial' ? sliceStream(original.stream, range.start, range.end - range.start + 1) : original.stream;
    return { status, headers, body: Readable.toWeb(node) as unknown as ReadableStream<Uint8Array> };
  }

  /**
   * Fire-and-forget neighbor warm (←/→ nav must not stall): kicks a decrypt
   * for every id not already cached or loading. Prefetches share the same
   * concurrency cap, so they queue behind on-demand requests already running.
   */
  prefetch(photoIds: readonly string[]): void {
    for (const photoId of photoIds) {
      if (!this.admit(photoId)) {
        this.invalidate(photoId);
        continue;
      }
      if (!this.lru.isWarm(photoId)) {
        void this.lru.get(photoId, () => this.resolvePayload(photoId, 'prefetch')).catch(() => undefined);
      }
    }
  }

  /** {cachedBytes, peakConcurrent} — the memory-budget observability hook. */
  stats(): { readonly cachedBytes: number; readonly peakConcurrent: number } {
    return this.lru.stats();
  }

  invalidate(photoId: string): void {
    this.lru.delete(photoId);
  }

  close(): Promise<void> {
    return this.lru.close();
  }

  private async resolvePayload(photoId: string, purpose: 'view' | 'prefetch'): Promise<FullPayload | null> {
    const original = await this.loadOriginal(photoId, purpose);
    if (original === null) {
      return null;
    }
    if (original.fileKind === 'raw') {
      // Viewable-by-magic, not by extension: validated embedded JPEGs win;
      // preview-less supported containers use the bounded native decoder.
      try {
        const viewable = await resolveRawPreview(original.bytes);
        if (viewable === null) {
          return null;
        }
        // RAF extraction returns a subarray into the decrypted original.
        // Cache an owned copy so wiping the source below clears the entire
        // RAW allocation, not only the embedded-preview range.
        return { bytes: viewable.bytes, contentHash: original.contentHash, mime: 'image/jpeg', preview: true };
      } finally {
        original.bytes.fill(0);
      }
    }
    if (original.fileKind === 'heic') {
      try {
        const viewable = await resolveHeicPreview(original.bytes);
        if (viewable === null || !viewable.ok) return null;
        return { bytes: viewable.preview.bytes, contentHash: original.contentHash, mime: 'image/jpeg', preview: false };
      } finally {
        original.bytes.fill(0);
      }
    }
    const mime = MIME_BY_KIND[original.fileKind];
    if (mime === undefined) {
      return null;
    }
    return { bytes: original.bytes, contentHash: original.contentHash, mime, preview: false };
  }
}
