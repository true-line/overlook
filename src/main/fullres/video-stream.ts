import { Transform, type Readable } from 'node:stream';

import type { ByteRange } from './byte-range.js';

// Streaming video delivery for overlook-full:// (ADR-0026 §5). Video originals
// are STREAMED from the decrypting blob-store read — never whole-file
// decrypt-to-LRU (a 4 GB clip must not transit the 256 MiB image cache).
// A Range request slices the decrypted stream to [start, end]; plaintext stays
// memory-only and the response stays `Cache-Control: no-store`.

/** A Transform that drops the first `skip` bytes then passes at most `take`,
 * ending the stream once the window is full. Bounded: it never buffers more
 * than one upstream chunk. */
export function sliceStream(source: Readable, skip: number, take: number): Readable {
  let toSkip = skip;
  let remaining = take;
  const slicer = new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (remaining <= 0) {
        done();
        return;
      }
      let piece = chunk;
      if (toSkip > 0) {
        if (toSkip >= piece.length) {
          toSkip -= piece.length;
          done();
          return;
        }
        piece = piece.subarray(toSkip);
        toSkip = 0;
      }
      if (piece.length > remaining) piece = piece.subarray(0, remaining);
      remaining -= piece.length;
      this.push(piece);
      if (remaining <= 0) this.push(null); // window filled — stop early
      done();
    },
  });
  source.on('error', (error) => slicer.destroy(error));
  slicer.on('close', () => source.destroy());
  source.pipe(slicer);
  return slicer;
}

const NO_STORE_RANGE = {
  'Cache-Control': 'no-store',
  'Accept-Ranges': 'bytes',
};

/** Response headers for a full (200) or partial (206) video response. */
export function videoHeaders(range: ByteRange, totalBytes: number, mime: string): { status: number; headers: Record<string, string> } {
  if (range.kind === 'partial') {
    const length = range.end - range.start + 1;
    return {
      status: 206,
      headers: {
        ...NO_STORE_RANGE,
        'Content-Type': mime,
        'Content-Length': String(length),
        'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(totalBytes)}`,
      },
    };
  }
  return {
    status: 200,
    headers: { ...NO_STORE_RANGE, 'Content-Type': mime, 'Content-Length': String(totalBytes) },
  };
}
