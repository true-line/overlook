import { open } from 'node:fs/promises';

import { ENVELOPE_FORMAT_VERSION, EnvelopeError } from '../crypto/envelope.js';

export interface LocalOriginalInspection {
  readonly bytes: number;
  readonly fingerprint: string;
}

/** A cheap observation, not an authentication claim. A changed identity or
 * timestamp forces a full authenticated hash before health can be recorded. */
export async function inspectLocalOriginal(path: string): Promise<LocalOriginalInspection> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat({ bigint: true });
    const header = Buffer.alloc(17);
    if (!info.isFile() || info.size < 42n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new EnvelopeError('local original is not a complete envelope');
    }
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.subarray(0, 4).toString('ascii') !== 'OVLK' || header[4] !== ENVELOPE_FORMAT_VERSION) {
      throw new EnvelopeError('local original has an invalid envelope header');
    }
    return {
      bytes: Number(info.size),
      fingerprint: `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}:${String(info.ctimeNs)}`,
    };
  } finally {
    await file.close();
  }
}
