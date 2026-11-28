import { addAbortSignal, type Readable } from 'node:stream';

import { CustodyResolutionError, type CustodyHandle, type CustodyHandleResolver } from './custody-handle.js';
import { ProviderError } from './provider.js';
import type { SyncStatus } from '../../shared/library/types.js';
import { custodyStateFromFailure, type EphemeralFailureReason, type PhotoCustodyStatus } from '../../shared/backup/custody-status.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

export type OriginalPurpose = 'view' | 'prefetch' | 'export';
export type OriginalCustody = 'durable' | 'ephemeral';
export type EphemeralStage = 'fetching' | 'verifying' | 'ready' | 'released' | 'error';
export interface EphemeralOriginalState {
  readonly photoId: string;
  readonly stage: EphemeralStage;
  readonly reason?: EphemeralFailureReason | undefined;
}

export class EphemeralOriginalError extends Error {
  override readonly name = 'EphemeralOriginalError';

  constructor(
    message: string,
    readonly reason: EphemeralFailureReason,
  ) {
    super(message);
  }
}

export interface EphemeralOriginalDeps {
  readonly custody: Pick<CustodyHandleResolver, 'resolve'>;
  readonly custodyStatus: (photoId: string) => Promise<PhotoCustodyStatus>;
  readonly custodyChanged: () => void;
  readonly ledger: {
    readonly status: (photoId: string) => SyncStatus | undefined;
    readonly requiresRemoteCustody: (photoId: string) => boolean;
    readonly setStatus: (photoId: string, status: SyncStatus) => void;
  };
  readonly repo: {
    readonly get: (photoId: string) => { readonly contentHash: string; readonly assetOwnerId?: string | null | undefined } | undefined;
  };
  readonly blobs: {
    readonly hasOriginal: (contentHash: string) => boolean;
    readonly durableStream: (contentHash: string, photoId: string) => Readable;
    readonly hasEphemeral: (contentHash: string) => boolean;
    readonly stageEphemeral: (contentHash: string, ciphertext: Readable, photoId: string) => Promise<number>;
    readonly ephemeralStream: (contentHash: string, photoId: string) => Readable;
    readonly promoteEphemeral: (contentHash: string) => Promise<void>;
    readonly deleteEphemeral: (contentHash: string) => Promise<void>;
  };
  readonly reOffloadAfterViewing: () => boolean;
  readonly permanentRestore: (photoId: string) => Promise<void>;
  readonly workChanged: (delta: 1 | -1) => void;
  readonly syncStateChanged: (updates: readonly { readonly id: string; readonly syncState: SyncStatus }[]) => void;
  readonly storageChanged: () => void;
  readonly stateChanged: (state: EphemeralOriginalState) => void;
  readonly audit: (line: string) => void;
  readonly maxCacheBytes?: number | undefined;
}

interface CacheEntry {
  readonly bytes: number;
  readonly owners: Map<string, number>;
}

const DEFAULT_CACHE_BYTES = 1024 * 1024 * 1024;

function remotePath(contentHash: string): string {
  return `blobs/${contentHash.slice(0, 2)}/${contentHash}`;
}

/** Verified encrypted process-lifetime custody for cloud-only originals.
 * Durable sync state remains offloaded until keepDownloaded() succeeds. */
export class EphemeralOriginalService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly ownersByHash = new Map<string, Map<string, number>>();
  private readonly releasedWhilePreparing = new Set<string>();
  private readonly states = new Map<string, Omit<EphemeralOriginalState, 'photoId'>>();
  private readonly maxCacheBytes: number;
  private cachedBytes = 0;

  constructor(private readonly deps: EphemeralOriginalDeps) {
    this.maxCacheBytes = deps.maxCacheBytes ?? DEFAULT_CACHE_BYTES;
  }

  async open(
    photoId: string,
    purpose: OriginalPurpose,
    signal?: AbortSignal,
  ): Promise<{ readonly stream: Readable; readonly custody: OriginalCustody; readonly release?: (() => Promise<void>) | undefined }> {
    signal?.throwIfAborted();
    const selected = this.deps.repo.get(photoId);
    if (selected === undefined) throw new EphemeralOriginalError(`photo ${photoId} does not exist`, 'not-found');
    // Provider acquisition is shared and has no abortable getStream contract.
    // Do not cancel another viewer's fetch. An abandoned export relinquishes
    // its own reference when that acquisition actually retires.
    const custody = await this.prepare(photoId, purpose);
    if (signal?.aborted === true) {
      if (custody === 'ephemeral' && purpose !== 'prefetch') await this.releaseHash(photoId, selected.contentHash, purpose);
      signal.throwIfAborted();
    }
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) {
      if (custody === 'ephemeral' && purpose !== 'prefetch') await this.releaseHash(photoId, selected.contentHash, purpose);
      throw new EphemeralOriginalError(`photo ${photoId} does not exist`, 'not-found');
    }
    try {
      const stream =
        custody === 'durable'
          ? this.deps.blobs.durableStream(photo.contentHash, assetOwnerOf({ id: photoId, ...photo }))
          : this.deps.blobs.ephemeralStream(photo.contentHash, photoId);
      let released = false;
      const release =
        custody === 'ephemeral' && purpose !== 'prefetch'
          ? () => {
              if (released) return Promise.resolve();
              released = true;
              return this.releaseHash(photoId, selected.contentHash, purpose);
            }
          : undefined;
      return { stream: signal === undefined ? stream : addAbortSignal(signal, stream), custody, release };
    } catch (error) {
      if (custody === 'ephemeral' && purpose !== 'prefetch') await this.releaseHash(photoId, selected.contentHash, purpose);
      throw error;
    }
  }

  async prepare(photoId: string, purpose: OriginalPurpose): Promise<OriginalCustody> {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) throw new EphemeralOriginalError(`photo ${photoId} does not exist`, 'not-found');
    if (!this.deps.ledger.requiresRemoteCustody(photoId)) {
      if (!this.deps.blobs.hasOriginal(photo.contentHash)) {
        throw new EphemeralOriginalError(`photo ${photoId} has no local original`, 'not-found');
      }
      return 'durable';
    }
    if (!this.deps.reOffloadAfterViewing() && purpose === 'view') {
      await this.permanentlyRestore(photoId);
      return 'durable';
    }

    const owners = this.owners(photo.contentHash);
    const ownedPurpose = purpose === 'prefetch' ? null : purpose;
    const owner = ownedPurpose === null ? null : this.ownerKey(photoId, ownedPurpose);
    if (owner !== null && ownedPurpose !== null) this.acquireOwner(owners, owner, ownedPurpose);
    let entry: CacheEntry;
    try {
      entry = await this.ensure(photoId, photo.contentHash);
    } catch (error) {
      if (owner !== null && ownedPurpose !== null) this.releaseOwner(owners, owner, ownedPurpose);
      this.dropEmptyOwners(photo.contentHash, owners);
      throw error;
    }
    if (owner !== null && this.releasedWhilePreparing.delete(owner) && owners.size === 0) {
      await this.remove(photo.contentHash, entry);
      this.changeState(photoId, 'released');
    }
    this.touch(photo.contentHash, entry);
    return 'ephemeral';
  }

  async keepDownloaded(photoId: string): Promise<void> {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) throw new EphemeralOriginalError(`photo ${photoId} does not exist`, 'not-found');
    if (this.deps.ledger.status(photoId) !== 'offloaded') return;
    if (!this.deps.reOffloadAfterViewing()) {
      await this.permanentlyRestore(photoId);
      return;
    }
    await this.ensure(photoId, photo.contentHash);
    await this.deps.blobs.promoteEphemeral(photo.contentHash);
    this.deps.ledger.setStatus(photoId, 'synced');
    this.deps.custodyChanged();
    this.deps.syncStateChanged([{ id: photoId, syncState: 'synced' }]);
    this.deps.storageChanged();
    this.deps.audit(`EPHEMERAL-PROMOTE photo=${photoId}`);
    await this.release(photoId);
  }

  status(photoId: string): Omit<EphemeralOriginalState, 'photoId'> | null {
    return this.states.get(photoId) ?? null;
  }

  async custodyStatus(photoId: string): Promise<PhotoCustodyStatus> {
    const status = await this.deps.custodyStatus(photoId);
    const failure = this.states.get(photoId)?.reason;
    const failureState = failure === undefined ? null : custodyStateFromFailure(failure);
    return failureState === null ? status : { ...status, state: failureState };
  }

  async release(photoId: string, purpose: Exclude<OriginalPurpose, 'prefetch'> = 'view'): Promise<void> {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) return;
    await this.releaseHash(photoId, photo.contentHash, purpose);
  }

  private async releaseHash(photoId: string, contentHash: string, purpose: Exclude<OriginalPurpose, 'prefetch'>): Promise<void> {
    const owner = this.ownerKey(photoId, purpose);
    const owners = this.ownersByHash.get(contentHash);
    if (owners !== undefined) this.releaseOwner(owners, owner, purpose);
    const entry = this.cache.get(contentHash);
    if (entry === undefined) {
      if (this.inFlight.has(contentHash)) this.releasedWhilePreparing.add(owner);
      this.dropEmptyOwners(contentHash, owners);
      return;
    }
    if (entry.owners.size > 0) return;
    await this.remove(contentHash, entry);
    this.changeState(photoId, 'released');
  }

  stats(): { readonly cachedBytes: number; readonly entries: number; readonly inFlight: number } {
    return { cachedBytes: this.cachedBytes, entries: this.cache.size, inFlight: this.inFlight.size };
  }

  private async ensure(photoId: string, contentHash: string): Promise<CacheEntry> {
    const cached = this.cache.get(contentHash);
    if (cached !== undefined && this.deps.blobs.hasEphemeral(contentHash)) return cached;
    if (cached !== undefined) {
      this.cache.delete(contentHash);
      this.cachedBytes -= cached.bytes;
    }
    const pending = this.inFlight.get(contentHash);
    if (pending !== undefined) return pending;
    const promise = this.fetch(photoId, contentHash);
    this.inFlight.set(contentHash, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(contentHash);
    }
  }

  private async fetch(photoId: string, contentHash: string): Promise<CacheEntry> {
    this.deps.workChanged(1);
    this.changeState(photoId, 'fetching');
    let staged = false;
    let published = false;
    try {
      let custody: CustodyHandle;
      try {
        custody = await this.deps.custody.resolve(photoId);
      } catch (error) {
        if (error instanceof CustodyResolutionError) {
          throw new EphemeralOriginalError(error.message, error.reason);
        }
        throw new EphemeralOriginalError('custody is unavailable', 'custody-unavailable');
      }
      let ciphertext: Readable;
      try {
        ciphertext = await custody.provider.getStream(remotePath(contentHash));
      } catch (error) {
        throw new EphemeralOriginalError(
          error instanceof Error ? error.message : 'remote original unavailable',
          error instanceof ProviderError && error.kind === 'not-found' ? 'remote-missing' : 'custody-unavailable',
        );
      }
      this.changeState(photoId, 'verifying');
      let bytes: number;
      try {
        bytes = await this.deps.blobs.stageEphemeral(contentHash, ciphertext, photoId);
        staged = true;
      } catch (error) {
        throw new EphemeralOriginalError(error instanceof Error ? error.message : 'verification failed', 'verify-failed');
      }
      if (bytes > this.maxCacheBytes) {
        await this.deps.blobs.deleteEphemeral(contentHash);
        throw new EphemeralOriginalError('original exceeds the temporary cache limit', 'cache-full');
      }
      await this.makeRoom(bytes);
      const entry = { bytes, owners: this.owners(contentHash) };
      this.cache.set(contentHash, entry);
      this.cachedBytes += bytes;
      published = true;
      this.changeState(photoId, 'ready');
      this.deps.audit(`EPHEMERAL-READY photo=${photoId} bytes=${String(bytes)}`);
      return entry;
    } catch (error) {
      if (staged && !published) await this.deps.blobs.deleteEphemeral(contentHash);
      this.changeState(photoId, 'error', error instanceof EphemeralOriginalError ? error.reason : 'custody-unavailable');
      throw error;
    } finally {
      this.deps.workChanged(-1);
    }
  }

  private async permanentlyRestore(photoId: string): Promise<void> {
    this.deps.workChanged(1);
    try {
      await this.deps.permanentRestore(photoId);
    } finally {
      this.deps.workChanged(-1);
    }
  }

  private async makeRoom(incomingBytes: number): Promise<void> {
    for (const [hash, entry] of this.cache) {
      if (this.cachedBytes + incomingBytes <= this.maxCacheBytes) break;
      if (entry.owners.size === 0) await this.remove(hash, entry);
    }
    if (this.cachedBytes + incomingBytes > this.maxCacheBytes) {
      throw new EphemeralOriginalError('temporary cache is full with active originals', 'cache-full');
    }
  }

  private touch(contentHash: string, entry: CacheEntry): void {
    if (!this.cache.has(contentHash)) return;
    this.cache.delete(contentHash);
    this.cache.set(contentHash, entry);
  }

  private async remove(contentHash: string, entry: CacheEntry): Promise<void> {
    this.cache.delete(contentHash);
    this.cachedBytes -= entry.bytes;
    await this.deps.blobs.deleteEphemeral(contentHash);
    this.dropEmptyOwners(contentHash, entry.owners);
  }

  private owners(contentHash: string): Map<string, number> {
    const current = this.ownersByHash.get(contentHash);
    if (current !== undefined) return current;
    const created = new Map<string, number>();
    this.ownersByHash.set(contentHash, created);
    return created;
  }

  private ownerKey(photoId: string, purpose: Exclude<OriginalPurpose, 'prefetch'>): string {
    return `${purpose}:${photoId}`;
  }

  private acquireOwner(owners: Map<string, number>, owner: string, purpose: Exclude<OriginalPurpose, 'prefetch'>): void {
    const current = owners.get(owner) ?? 0;
    owners.set(owner, purpose === 'view' ? Math.max(current, 1) : current + 1);
  }

  private releaseOwner(owners: Map<string, number>, owner: string, purpose: Exclude<OriginalPurpose, 'prefetch'>): void {
    const current = owners.get(owner) ?? 0;
    if (purpose === 'view' || current <= 1) owners.delete(owner);
    else owners.set(owner, current - 1);
  }

  private dropEmptyOwners(contentHash: string, owners: Map<string, number> | undefined): void {
    if (owners?.size === 0 && this.ownersByHash.get(contentHash) === owners) this.ownersByHash.delete(contentHash);
  }

  private changeState(photoId: string, stage: EphemeralStage, reason?: EphemeralFailureReason): void {
    const state = { stage, ...(reason === undefined ? {} : { reason }) };
    this.states.set(photoId, state);
    this.deps.stateChanged({ photoId, ...state });
  }
}
