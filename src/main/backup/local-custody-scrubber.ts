import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { LocalOriginalInspection } from '../blobs/local-original-inspection.js';
import { createDecryptStream, EnvelopeError, type KeyResolver } from '../crypto/envelope.js';
import type { LocalCustodyItem, LocalCustodyRepository } from '../db/local-custody-repository.js';
import type { LocalCustodyFailure } from '../../shared/library/types.js';
import type { BackupIntegrityCursor } from './integrity-scrubber.js';

export const LOCAL_CUSTODY_HASH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const LOCAL_CUSTODY_BYTE_BUDGET = 64 * 1024 * 1024;

export interface LocalCustodySummary {
  readonly checked: number;
  readonly hashed: number;
  readonly missing: number;
  readonly corrupt: number;
  readonly cycleComplete: boolean;
}

export interface LocalCustodyScrubberDeps {
  readonly repo: Pick<LocalCustodyRepository, 'items' | 'available' | 'record'>;
  readonly inspect: (hash: string) => Promise<LocalOriginalInspection>;
  readonly encryptedStream: (hash: string) => Readable;
  readonly resolveKey: KeyResolver;
  readonly cursor: {
    readonly load: () => Promise<BackupIntegrityCursor>;
    readonly save: (cursor: BackupIntegrityCursor) => Promise<void>;
  };
  readonly changed: (photoIds: readonly string[]) => void;
  readonly audit: (line: string) => void;
  readonly now: () => Date;
  readonly batchSize?: number;
  readonly byteBudget?: number;
}

class CustodyUnavailableError extends Error {}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Local-only verification never resolves a provider and never repairs bytes.
 * Fast observations cannot clear a failure: only an authenticated content hash can. */
export class LocalCustodyScrubber {
  constructor(private readonly deps: LocalCustodyScrubberDeps) {}

  async scrub(signal: AbortSignal = new AbortController().signal): Promise<LocalCustodySummary> {
    signal.throwIfAborted();
    const cursor = await this.deps.cursor.load();
    signal.throwIfAborted();
    const batchSize = this.deps.batchSize ?? 50;
    const items = this.deps.repo.items({ afterId: cursor.afterId, limit: batchSize });
    const summary = { checked: 0, hashed: 0, missing: 0, corrupt: 0, cycleComplete: false };
    let bytes = 0;
    let consumed = 0;
    const authenticated = new Map<string, { readonly fingerprint: string; readonly valid: boolean }>();

    for (const item of items) {
      if (signal.aborted) break;
      try {
        if (this.deps.repo.available(item)) {
          const inspection = await this.deps.inspect(item.contentHash);
          if (signal.aborted) break;
          const age = item.verifiedAt === null ? Number.NaN : this.deps.now().getTime() - Date.parse(item.verifiedAt);
          const needsHash =
            item.failure !== null ||
            item.fingerprint !== inspection.fingerprint ||
            !Number.isFinite(age) ||
            age < 0 ||
            age >= LOCAL_CUSTODY_HASH_INTERVAL_MS;
          if (needsHash) {
            const identity = `${item.contentHash}:${item.assetOwnerId ?? item.id}`;
            const cached = authenticated.get(identity);
            const reusable = cached?.fingerprint === inspection.fingerprint;
            // No starvation of large originals: one oversized object may consume
            // a pass, but a deferred object retains the cursor for the next pass.
            if (!reusable && bytes > 0 && bytes + inspection.bytes > (this.deps.byteBudget ?? LOCAL_CUSTODY_BYTE_BUDGET)) break;
            if (!reusable) {
              bytes += inspection.bytes;
              summary.hashed += 1;
            }
            const valid = reusable ? cached.valid : await this.authenticate(item, inspection.bytes, signal);
            if (signal.aborted) break;
            const after = await this.deps.inspect(item.contentHash);
            if (signal.aborted) break;
            if (after.fingerprint !== inspection.fingerprint) {
              this.deps.audit(`INTEGRITY-LOCAL-DEFERRED photo=${item.id} reason=changed-during-read`);
            } else if (this.deps.repo.available(item)) {
              authenticated.set(identity, { fingerprint: inspection.fingerprint, valid });
              this.record(item, valid ? null : 'local-corrupt', valid ? inspection.fingerprint : undefined);
              summary.corrupt += valid ? 0 : 1;
            }
          }
          summary.checked += 1;
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof CustodyUnavailableError || !this.deps.repo.available(item)) {
          this.deps.audit(`INTEGRITY-LOCAL-SKIP-LOCKED photo=${item.id}`);
        } else if (missing(error) || error instanceof EnvelopeError) {
          const failure = missing(error) ? 'local-missing' : 'local-corrupt';
          this.record(item, failure);
          summary.checked += 1;
          summary.missing += failure === 'local-missing' ? 1 : 0;
          summary.corrupt += failure === 'local-corrupt' ? 1 : 0;
        } else {
          // Permission/IO failures are not evidence of corruption or recovery.
          this.deps.audit(`INTEGRITY-LOCAL-DEFERRED photo=${item.id} reason=io-unavailable`);
        }
      }
      if (signal.aborted) break;
      await this.deps.cursor.save({ version: 1, afterId: item.id, completedAt: null });
      consumed += 1;
    }
    summary.cycleComplete = !signal.aborted && consumed === items.length && items.length < batchSize;
    if (summary.cycleComplete) {
      await this.deps.cursor.save({ version: 1, afterId: null, completedAt: this.deps.now().toISOString() });
    }
    return summary;
  }

  private record(item: LocalCustodyItem, failure: LocalCustodyFailure | null, fingerprint?: string): void {
    const changed = this.deps.repo.record(
      item,
      failure,
      fingerprint === undefined ? undefined : { fingerprint, at: this.deps.now().toISOString() },
    );
    if (changed.length === 0) return;
    this.deps.changed(changed);
    this.deps.audit(
      `INTEGRITY-LOCAL-${failure === null ? 'VERIFIED' : failure === 'local-missing' ? 'MISSING' : 'CORRUPT'} photo=${item.id}`,
    );
  }

  private async authenticate(item: LocalCustodyItem, ciphertextBytes: number, signal: AbortSignal): Promise<boolean> {
    let read = 0;
    let plaintextBytes = 0;
    const boundedCiphertext = new Transform({
      transform: (chunk: Buffer, _encoding, callback): void => {
        read += chunk.length;
        if (!this.deps.repo.available(item)) callback(new CustodyUnavailableError());
        else if (read > ciphertextBytes) callback(new EnvelopeError('local original grew during verification'));
        else callback(null, chunk);
      },
    });
    const boundedPlaintext = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        plaintextBytes += chunk.length;
        if (plaintextBytes > item.bytes) callback(new EnvelopeError('local original exceeds its recorded size'));
        else callback(null, chunk);
      },
    });
    const hasher = createHash('sha256');
    try {
      await pipeline(
        this.deps.encryptedStream(item.contentHash),
        boundedCiphertext,
        createDecryptStream(this.deps.resolveKey, { photoId: item.assetOwnerId ?? item.id }),
        boundedPlaintext,
        hasher,
        { signal },
      );
    } catch (error) {
      if (error instanceof EnvelopeError) return false;
      throw error;
    }
    return plaintextBytes === item.bytes && hasher.digest('hex') === item.contentHash;
  }
}
