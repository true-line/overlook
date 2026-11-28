import sharp from 'sharp';

import { bakeDecoded, decodable } from '../import/bake-transform.js';
import { embeddedJpegFromRaf } from '../import/raf-preview.js';
import { IDENTITY_TRANSFORM, isIdentityTransform, type EditTransform } from '../../shared/library/edit-revision.js';
import type { FileKind } from '../../shared/library/types.js';

// JPEG transcode for export (#98): "Format: JPEG" must open anywhere,
// including from RAW sources — which transcode from their embedded preview
// (ADR-0006 v1 policy), resolution honestly capped at preview size.
// Metadata is STRIPPED on transcode (sharp's default, kept deliberately):
// per ADR-0006's GPS stance, location and camera identity travel only when
// the user exports ORIGINALS. Orientation is baked in before the tag drops.
// The Baked mode (#497, ADR-0031 §6) renders the head edit stack into the
// pixels with the same math the derivatives use, at an explicit quality.

/** Recorded default quality setting (#98). */
export const EXPORT_JPEG_QUALITY = 90;
/** Per native pipeline, measured by libvips after input opens, not queue time. */
export const EXPORT_PROCESSING_TIMEOUT_SECONDS = 30;

export interface TranscodeOptions {
  readonly signal?: AbortSignal | undefined;
  /** Edits to bake into the pixels; absent or identity = the untouched pipeline. */
  readonly transform?: EditTransform | undefined;
  /** JPEG quality 1–100; defaults to EXPORT_JPEG_QUALITY. */
  readonly quality?: number | undefined;
}

export interface TranscodeResult {
  readonly jpeg: Buffer;
  /** True when the source was a RAW container's embedded preview. */
  readonly fromPreview: boolean;
}

export async function transcodeToJpeg(bytes: Buffer, fileKind: FileKind, options: TranscodeOptions = {}): Promise<TranscodeResult> {
  options.signal?.throwIfAborted();
  let source = bytes;
  let fromPreview = false;
  if (fileKind === 'raw') {
    // Every accepted RAW kind routes through the embedded-preview policy
    // (PR #195 review). v1 extracts RAF's documented preview; other RAW
    // containers have no v1 renderer — fail the entry honestly instead of
    // handing container bytes to sharp.
    const preview = embeddedJpegFromRaf(bytes);
    if (preview === null) {
      throw new Error('RAW has no extractable preview (v1 renders RAF previews only) — export as Original instead');
    }
    source = preview;
    fromPreview = true;
  }
  const transform = options.transform ?? IDENTITY_TRANSFORM;
  const quality = options.quality ?? EXPORT_JPEG_QUALITY;
  if (isIdentityTransform(transform)) {
    const jpeg = await sharp(source, { failOn: 'error' })
      .timeout({ seconds: EXPORT_PROCESSING_TIMEOUT_SECONDS })
      .rotate()
      .jpeg({ quality })
      .toBuffer();
    options.signal?.throwIfAborted();
    return { jpeg, fromPreview };
  }
  const baked = await bakeDecoded(source, transform, { signal: options.signal, timeoutSeconds: EXPORT_PROCESSING_TIMEOUT_SECONDS });
  options.signal?.throwIfAborted();
  const jpeg = await decodable(baked).timeout({ seconds: EXPORT_PROCESSING_TIMEOUT_SECONDS }).jpeg({ quality }).toBuffer();
  options.signal?.throwIfAborted();
  return { jpeg, fromPreview };
}
