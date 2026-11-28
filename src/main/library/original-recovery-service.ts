import { open } from 'node:fs/promises';

import type { BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';
import type { PhotoRecord } from '../../shared/library/types.js';

export type OriginalRecoveryResult = 'recovered' | 'unavailable' | 'cancelled' | 'failed';

export interface OriginalRecoveryOptions {
  readonly getPhoto: (id: string) => PhotoRecord | undefined;
  readonly blobs: Pick<BlobStore, 'putOriginal' | 'verifyOriginal'>;
  readonly ready: Promise<void>;
  /** Returns an owned copy; recovery wipes it on every exit. */
  readonly writeKey: () => EnvelopeKey;
  readonly resolveKey: KeyResolver;
  /** Called only after authenticated publication, while the library is open. */
  readonly restored: (contentHash: string, keyId: number) => void;
}

/** Exact-file recovery preserves the recorded asset owner. Closing the
 * library stops admission, aborts the file stream, and drains before DB/key teardown. */
export class OriginalRecoveryService {
  private closed = false;
  private controller: AbortController | undefined;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OriginalRecoveryOptions) {}

  recover(photoId: string, sourcePath: string): Promise<OriginalRecoveryResult> {
    const task = this.turn.then(() => this.restore(photoId, sourcePath));
    this.turn = task.catch(() => undefined);
    return task;
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
  }

  async drain(): Promise<void> {
    await this.turn;
  }

  private async restore(photoId: string, sourcePath: string): Promise<OriginalRecoveryResult> {
    if (this.closed) return 'cancelled';
    const photo = this.options.getPhoto(photoId);
    if (
      photo === undefined ||
      photo.deletedAt !== null ||
      photo.locked ||
      (photo.originalFailure !== 'missing-original' && photo.localCustodyFailure !== 'local-missing')
    ) {
      return 'unavailable';
    }
    const controller = new AbortController();
    let recoveryKey: EnvelopeKey | undefined;
    this.controller = controller;
    const current = (): boolean => {
      if (this.closed || controller.signal.aborted) return false;
      const latest = this.options.getPhoto(photoId);
      return (
        latest !== undefined &&
        latest.deletedAt === null &&
        !latest.locked &&
        latest.contentHash === photo.contentHash &&
        latest.keyId === photo.keyId &&
        assetOwnerOf(latest) === assetOwnerOf(photo)
      );
    };
    try {
      await this.options.ready;
      if (!current()) return 'cancelled';
      const source = await open(sourcePath, 'r');
      try {
        const stat = await source.stat();
        if (!stat.isFile() || stat.size !== photo.bytes) return 'failed';
        if (!current()) return 'cancelled';
        recoveryKey = this.options.writeKey();
        // Read at most the recorded length plus one byte, so a growing file
        // cannot turn recovery into an unbounded input. Hash verification is authoritative.
        const stream = source.createReadStream({ autoClose: false, end: photo.bytes, signal: controller.signal });
        const stored = await this.options.blobs.putOriginal(stream, recoveryKey, assetOwnerOf(photo), photo.contentHash);
        // No-replace publication may have found an existing envelope. Its
        // presence (and even its readable header) is not proof of recovery.
        if (!current()) return 'cancelled';
        const verified = await this.options.blobs.verifyOriginal(
          photo.contentHash,
          this.options.resolveKey,
          assetOwnerOf(photo),
          controller.signal,
        );
        if (!current()) return 'cancelled';
        if (!verified) return 'failed';
        this.options.restored(photo.contentHash, stored.keyId);
        return 'recovered';
      } finally {
        await source.close();
      }
    } catch {
      return this.closed || controller.signal.aborted ? 'cancelled' : 'failed';
    } finally {
      recoveryKey?.key.fill(0);
      this.controller = undefined;
    }
  }
}
