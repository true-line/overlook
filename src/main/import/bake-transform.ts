import sharp, { type Sharp } from 'sharp';

import { displayDimensions } from './display-dimensions.js';
import type { EditTransform } from '../../shared/library/edit-revision.js';

// Renders a persisted edit stack into oriented pixels (ADR-0031 §2 order:
// EXIF orientation first, then rotate/flip, then the crop in oriented space).
// Shared by the thumbnail worker (#493) and the baked export (#497, §6) so a
// baked file shows exactly what the tiles show.

type RawInputOptions = NonNullable<NonNullable<Parameters<typeof sharp>[1]>['raw']>;

/** Bytes sharp can decode: encoded, or raw pixels with their layout. */
export interface DecodableInput {
  readonly bytes: Uint8Array;
  readonly raw?: RawInputOptions | undefined;
}

export function decodable(input: DecodableInput): Sharp {
  return sharp(input.bytes, { failOn: 'error', ...(input.raw === undefined ? {} : { raw: input.raw }) });
}

/** Export supplies a processing deadline and cancellation checkpoints; other
 * derivative consumers retain their existing policy. Sharp's clock excludes
 * libuv queue wait and cannot interrupt an arbitrary OS syscall. */
interface BakeExecution {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutSeconds?: number | undefined;
}

function executing(pipeline: Sharp, execution: BakeExecution): Sharp {
  execution.signal?.throwIfAborted();
  return execution.timeoutSeconds === undefined ? pipeline : pipeline.timeout({ seconds: execution.timeoutSeconds });
}

/** sharp mirrors before it rotates whatever the call order, so the visual
 * "rotate, then mirror" becomes "mirror, then rotate the other way"
 * (F·R(θ) = R(−θ)·F); the crop is cut from the rotated frame. */
export async function bakeTransform(
  bytes: Uint8Array,
  transform: EditTransform,
  width: number,
  height: number,
  execution: BakeExecution = {},
): Promise<DecodableInput> {
  const oriented = await executing(sharp(bytes, { failOn: 'error' }), execution)
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let pipeline = sharp(oriented.data, {
    raw: { width: oriented.info.width, height: oriented.info.height, channels: oriented.info.channels },
  });
  if (transform.flipped) pipeline = pipeline.flop();
  const angle = transform.flipped ? (360 - transform.quarterTurns * 90) % 360 : transform.quarterTurns * 90;
  if (angle !== 0) pipeline = pipeline.rotate(angle);
  if (transform.crop !== null) {
    const rotatedWidth = transform.quarterTurns % 2 === 0 ? width : height;
    const rotatedHeight = transform.quarterTurns % 2 === 0 ? height : width;
    const left = Math.min(rotatedWidth - 1, Math.round(transform.crop.left * rotatedWidth));
    const top = Math.min(rotatedHeight - 1, Math.round(transform.crop.top * rotatedHeight));
    const cropWidth = Math.max(1, Math.min(rotatedWidth - left, Math.round(transform.crop.width * rotatedWidth)));
    const cropHeight = Math.max(1, Math.min(rotatedHeight - top, Math.round(transform.crop.height * rotatedHeight)));
    pipeline = pipeline.extract({ left, top, width: cropWidth, height: cropHeight });
  }
  const baked = await executing(pipeline, execution).raw().toBuffer({ resolveWithObject: true });
  execution.signal?.throwIfAborted();
  return { bytes: baked.data, raw: { width: baked.info.width, height: baked.info.height, channels: baked.info.channels } };
}

/** Bakes against the image's own display dimensions (EXIF orientation applied). */
export async function bakeDecoded(bytes: Uint8Array, transform: EditTransform, execution: BakeExecution = {}): Promise<DecodableInput> {
  const meta = await executing(sharp(bytes, { failOn: 'error' }), execution).metadata();
  const dimensions = displayDimensions(meta.width, meta.height, meta.orientation);
  if (dimensions === null) throw new Error('decoded image has invalid dimensions');
  return bakeTransform(bytes, transform, dimensions.width, dimensions.height, execution);
}
