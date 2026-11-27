import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { DisclosurePlan } from '../../shared/disclosure/policy.js';
import type { SourceSidecarFinding } from '../../shared/disclosure/source-sidecars.js';
import { inspectSourceXmp, MAX_SOURCE_SIDECAR_BYTES, type SourceInspection } from './source-xmp.js';

export interface SourceSidecar {
  readonly fileName: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly keyId: number;
  readonly ownerId?: string | undefined;
}
export interface SourceSidecarReader {
  readonly sidecarsFor: (photoId: string) => readonly SourceSidecar[];
  readonly sidecarStream: (ownerId: string, contentHash: string) => Readable;
}

/** A bounded, authenticated copy. Write these exact verified bytes, never
 * reopen a stream after inspecting different bytes. */
export async function readSourceSidecar(sidecar: SourceSidecar, open: () => Readable): Promise<Buffer> {
  if (!Number.isSafeInteger(sidecar.bytes) || sidecar.bytes < 0 || sidecar.bytes > MAX_SOURCE_SIDECAR_BYTES)
    throw new Error('Source sidecar exceeds inspection limit');
  const stream = open();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const input: AsyncIterable<unknown> = stream;
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new Error('Invalid sidecar bytes');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_SOURCE_SIDECAR_BYTES) throw new Error('Source sidecar exceeds inspection limit');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== sidecar.bytes || createHash('sha256').update(bytes).digest('hex') !== sidecar.contentHash)
      throw new Error('Source sidecar content changed');
    return bytes;
  } finally {
    stream.destroy();
  }
}

export async function inspectSourceSidecar(sidecar: SourceSidecar, open: () => Readable): Promise<SourceInspection> {
  if (sidecar.bytes > MAX_SOURCE_SIDECAR_BYTES) return { status: 'malformed', fields: [] };
  try {
    return inspectSourceXmp(sidecar.fileName, await readSourceSidecar(sidecar, open));
  } catch {
    return { status: 'unavailable', fields: [] };
  }
}

export function sourceSidecarFinding(
  photoId: string,
  sidecar: SourceSidecar,
  inspection: SourceInspection,
  plan: DisclosurePlan,
): SourceSidecarFinding {
  const blocked =
    inspection.status === 'unknown'
      ? [...plan.withheld]
      : inspection.fields.filter(({ field }) => !plan.disclosed.includes(field)).map(({ field }) => field);
  return {
    photoId,
    fileName: sidecar.fileName,
    ...inspection,
    blocked,
    refused: blocked.length > 0 || inspection.status === 'malformed' || inspection.status === 'unavailable',
  };
}

export function sourceSidecarRefusal(finding: SourceSidecarFinding): string {
  return (
    `Source sidecar ${JSON.stringify(finding.fileName)}: ${finding.status === 'inspected' ? 'withheld' : finding.status}` +
    (finding.blocked.length === 0 ? '' : ` (${finding.blocked.join(', ')})`) +
    '. Use Metadata: Edits/None or review disclosure consent.'
  );
}
