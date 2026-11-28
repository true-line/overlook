import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import {
  EphemeralOriginalError,
  EphemeralOriginalService,
  type EphemeralOriginalState,
} from '../../src/main/backup/ephemeral-originals.js';
import { CustodyResolutionError } from '../../src/main/backup/custody-handle.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import type { ProviderAuthState } from '../../src/main/backup/provider.js';
import type { CustodyAuthority } from '../../src/main/backup/custody-authority-repository.js';
import type { SyncStatus } from '../../src/shared/library/types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AUTHORITY: CustodyAuthority = {
  id: 1,
  providerId: 'mock',
  accountId: 'mock-account',
  accountLabel: 'Mock account',
  remoteRoot: '/Overlook/mock-library/',
  state: 'bound',
  createdAt: '2026-08-06T00:00:00.000Z',
  lastVerifiedAt: null,
};

async function world(
  options: {
    readonly maxCacheBytes?: number;
    readonly policy?: boolean;
    readonly stageGate?: Promise<void>;
    readonly stageStarted?: (() => void) | undefined;
    readonly stageError?: Error;
  } = {},
) {
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-ephemeral-')) });
  const remote = new Map([
    [HASH_A, Buffer.from('encrypted-a')],
    [HASH_B, Buffer.from('encrypted-bb')],
    [HASH_C, Buffer.from('encrypted-ccc')],
  ]);
  for (const [hash, bytes] of remote) await provider.put(`blobs/${hash.slice(0, 2)}/${hash}`, Readable.from([bytes]));
  let getCalls = 0;
  const getStream = provider.getStream.bind(provider);
  provider.getStream = (path) => {
    getCalls += 1;
    return getStream(path);
  };
  const photos = new Map([
    ['P0', { contentHash: HASH_A }],
    ['P1', { contentHash: HASH_A }],
    ['P2', { contentHash: HASH_B }],
    ['P3', { contentHash: HASH_C }],
  ]);
  const statuses = new Map<string, SyncStatus>([...photos.keys()].map((id) => [id, 'offloaded']));
  const cleanRemoteErrors = new Set<string>();
  const ephemeral = new Map<string, Buffer>();
  const durable = new Set<string>();
  const states: EphemeralOriginalState[] = [];
  const syncUpdates: { id: string; syncState: SyncStatus }[][] = [];
  const work: number[] = [];
  let storageChanges = 0;
  let permanentRestores = 0;
  let policy = options.policy ?? true;
  let providerConnected = true;
  const service = new EphemeralOriginalService({
    custody: {
      resolve: async () => {
        if (!providerConnected) throw new CustodyResolutionError('custody-disconnected');
        let state: ProviderAuthState;
        try {
          state = await provider.authState();
        } catch {
          throw new CustodyResolutionError('custody-unavailable');
        }
        if (state === 'not-connected') throw new CustodyResolutionError('custody-disconnected');
        if (state !== 'connected') throw new CustodyResolutionError('custody-unavailable');
        return { authority: AUTHORITY, provider };
      },
    },
    custodyStatus: () =>
      Promise.resolve({
        state: providerConnected ? 'available' : 'disconnected',
        providerId: 'mock',
        providerLabel: 'Local mock',
        accountLabel: 'Mock account',
      }),
    custodyChanged: () => undefined,
    ledger: {
      status: (id) => statuses.get(id),
      requiresRemoteCustody: (id) => statuses.get(id) === 'offloaded' || cleanRemoteErrors.has(id),
      setStatus: (id, status) => statuses.set(id, status),
    },
    repo: { get: (id) => photos.get(id) },
    blobs: {
      hasOriginal: (hash) => durable.has(hash),
      durableStream: (hash) => Readable.from([Buffer.from(`durable-${hash}`)]),
      hasEphemeral: (hash) => ephemeral.has(hash),
      stageEphemeral: async (hash, ciphertext) => {
        options.stageStarted?.();
        if (options.stageGate !== undefined) await options.stageGate;
        if (options.stageError !== undefined) throw options.stageError;
        const bytes = await buffer(ciphertext);
        ephemeral.set(hash, bytes);
        return bytes.length;
      },
      ephemeralStream: (hash) => Readable.from([ephemeral.get(hash) ?? Buffer.alloc(0)]),
      promoteEphemeral: (hash) => {
        durable.add(hash);
        return Promise.resolve();
      },
      deleteEphemeral: (hash) => {
        ephemeral.delete(hash);
        return Promise.resolve();
      },
    },
    reOffloadAfterViewing: () => policy,
    permanentRestore: (photoId) => {
      permanentRestores += 1;
      const photo = photos.get(photoId);
      if (photo !== undefined) durable.add(photo.contentHash);
      statuses.set(photoId, 'synced');
      return Promise.resolve();
    },
    workChanged: (delta) => work.push(delta),
    syncStateChanged: (updates) => syncUpdates.push([...updates]),
    storageChanged: () => (storageChanges += 1),
    stateChanged: (state) => states.push(state),
    audit: () => undefined,
    maxCacheBytes: options.maxCacheBytes,
  });
  return {
    provider,
    service,
    statuses,
    ephemeral,
    durable,
    states,
    syncUpdates,
    work,
    getCalls: () => getCalls,
    removePhoto: (photoId: string) => photos.delete(photoId),
    storageChanges: () => storageChanges,
    permanentRestores: () => permanentRestores,
    setPolicy: (next: boolean) => (policy = next),
    setProviderConnected: (next: boolean) => (providerConnected = next),
    setErrorState: (photoId: string, cleanRemote: boolean) => {
      statuses.set(photoId, 'error');
      if (cleanRemote) cleanRemoteErrors.add(photoId);
      else cleanRemoteErrors.delete(photoId);
    },
  };
}

describe('ephemeral originals (#306)', () => {
  test('concurrent shared-hash opens download once and release respects active owners', async () => {
    const w = await world();
    const [first, second] = await Promise.all([w.service.open('P0', 'view'), w.service.open('P1', 'view')]);
    assert.equal(first.custody, 'ephemeral');
    assert.equal(second.custody, 'ephemeral');
    assert.equal(w.getCalls(), 1, 'content-addressed in-flight fetch is shared');
    assert.equal(w.statuses.get('P0'), 'offloaded');
    assert.equal(w.statuses.get('P1'), 'offloaded');
    assert.deepEqual(w.work, [1, -1]);

    await w.service.release('P0');
    assert.equal(w.ephemeral.has(HASH_A), true, 'the second viewer still owns custody');
    await w.service.release('P1');
    assert.equal(w.ephemeral.has(HASH_A), false);
    assert.equal(w.service.stats().cachedBytes, 0);
  });

  test('Keep downloaded promotes verified ciphertext before transitioning the ledger', async () => {
    const w = await world();
    await w.service.open('P0', 'view');
    await w.service.keepDownloaded('P0');
    assert.equal(w.durable.has(HASH_A), true);
    assert.equal(w.statuses.get('P0'), 'synced');
    assert.deepEqual(w.syncUpdates, [[{ id: 'P0', syncState: 'synced' }]]);
    assert.equal(w.storageChanges(), 1);
    assert.equal(w.ephemeral.has(HASH_A), false);
  });

  test('clean integrity errors retain remote custody while dirty upload errors use durable bytes (#734 review)', async () => {
    const w = await world();
    w.setErrorState('P0', true);
    assert.equal((await w.service.open('P0', 'view')).custody, 'ephemeral');
    await w.service.release('P0');

    w.setErrorState('P2', false);
    w.durable.add(HASH_B);
    assert.equal((await w.service.open('P2', 'view')).custody, 'durable');
  });

  test('view and same-photo exports hold independent reference-counted custody (#306 review)', async () => {
    const w = await world();
    await w.service.open('P0', 'view');
    await Promise.all([w.service.open('P0', 'export'), w.service.open('P0', 'export')]);

    await w.service.release('P0', 'export');
    assert.equal(w.ephemeral.has(HASH_A), true, 'the second export and lightbox still own custody');
    await w.service.release('P0', 'export');
    assert.equal(w.ephemeral.has(HASH_A), true, 'the open lightbox still owns custody after both exports');
    await w.service.release('P0', 'view');
    assert.equal(w.ephemeral.has(HASH_A), false);
  });

  test('policy off permanently restores only real views; prefetch and export stay temporary', async () => {
    const w = await world({ maxCacheBytes: 20 });
    w.setPolicy(false);

    assert.equal((await w.service.open('P2', 'prefetch')).custody, 'ephemeral');
    assert.equal((await w.service.open('P3', 'export')).custody, 'ephemeral');
    assert.equal(w.permanentRestores(), 0, 'background and export reads preserve the offloaded storage choice');
    assert.equal(w.statuses.get('P2'), 'offloaded');
    assert.equal(w.statuses.get('P3'), 'offloaded');
    await w.service.release('P3', 'export');

    assert.equal((await w.service.open('P0', 'view')).custody, 'durable');
    assert.equal(w.permanentRestores(), 1);
  });

  test('an export abandoned during shared acquisition releases only its own reference (#1217)', async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const w = await world({ stageGate: gate, stageStarted: started });
    const controller = new AbortController();
    const abandoned = w.service.open('P0', 'export', controller.signal);
    const viewer = w.service.open('P1', 'view');
    const otherExport = w.service.open('P0', 'export');
    await entered;
    controller.abort();
    const rejected = assert.rejects(abandoned, { name: 'AbortError' });
    finish?.();
    await rejected;
    const retained = await Promise.all([viewer, otherExport]);
    for (const opened of retained) opened.stream.destroy();
    assert.equal(w.ephemeral.has(HASH_A), true);
    await w.service.release('P1', 'view');
    assert.equal(w.ephemeral.has(HASH_A), true, 'the other export still owns the shared ciphertext');
    await w.service.release('P0', 'export');
    assert.equal(w.ephemeral.has(HASH_A), false, 'the abandoned export left no phantom reference');
    assert.equal(w.getCalls(), 1);
  });

  test('late export cancellation releases captured custody after the photo row disappears (#1217)', async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const w = await world({ stageGate: gate, stageStarted: started });
    const controller = new AbortController();
    const opening = w.service.open('P2', 'export', controller.signal);
    await entered;
    controller.abort();
    w.removePhoto('P2');
    const rejected = assert.rejects(opening, { name: 'AbortError' });
    finish?.();
    await rejected;
    assert.equal(w.ephemeral.has(HASH_B), false);
    assert.deepEqual(w.service.stats(), { cachedBytes: 0, entries: 0, inFlight: 0 });
  });

  test('opened export references release once even after row deletion (#1217)', async () => {
    const w = await world();
    const [first, second] = await Promise.all([w.service.open('P0', 'export'), w.service.open('P0', 'export')]);
    first.stream.destroy();
    second.stream.destroy();
    w.removePhoto('P0');
    assert.ok(first.release);
    assert.ok(second.release);
    await first.release();
    await first.release();
    assert.equal(w.ephemeral.has(HASH_A), true, 'repeating one handle cannot release the other owner');
    await second.release();
    assert.equal(w.ephemeral.has(HASH_A), false, 'release does not depend on a surviving repository row');
    assert.deepEqual(w.service.stats(), { cachedBytes: 0, entries: 0, inFlight: 0 });
  });

  test('temporary prefetch remains LRU-bounded', async () => {
    const w = await world({ maxCacheBytes: 20 });
    w.setPolicy(true);
    await w.service.open('P2', 'prefetch');
    await w.service.open('P3', 'prefetch');
    assert.equal(w.ephemeral.has(HASH_B), false, 'old inactive prefetch evicted to make room');
    assert.equal(w.ephemeral.has(HASH_C), true);
    assert.ok(w.service.stats().cachedBytes <= 20);
  });

  test('oversized and missing remote originals fail closed without cached custody', async () => {
    const oversized = await world({ maxCacheBytes: 2 });
    await assert.rejects(
      oversized.service.open('P0', 'view'),
      (error: unknown) => error instanceof EphemeralOriginalError && error.reason === 'cache-full',
    );
    assert.equal(oversized.ephemeral.size, 0);
    assert.deepEqual(await oversized.service.custodyStatus('P0'), {
      state: 'unavailable',
      providerId: 'mock',
      providerLabel: 'Local mock',
      accountLabel: 'Mock account',
    });

    const missing = await world();
    await missing.provider.delete(`blobs/${HASH_A.slice(0, 2)}/${HASH_A}`);
    await assert.rejects(
      missing.service.open('P0', 'view'),
      (error: unknown) => error instanceof EphemeralOriginalError && error.reason === 'remote-missing',
    );
    assert.equal(missing.ephemeral.size, 0);
    assert.equal(missing.states.at(-1)?.stage, 'error');
    assert.equal(missing.states.at(-1)?.reason, 'remote-missing');
    assert.deepEqual(await missing.service.custodyStatus('P0'), {
      state: 'missing-corrupt',
      providerId: 'mock',
      providerLabel: 'Local mock',
      accountLabel: 'Mock account',
    });
  });

  test('close during verification cannot publish abandoned custody or evict a shared viewer', async () => {
    let unlock: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let stageStarted: (() => void) | undefined;
    const enteredStage = new Promise<void>((resolve) => {
      stageStarted = resolve;
    });
    const shared = await world({ stageGate: gate, stageStarted });
    const abandoned = shared.service.prepare('P0', 'view');
    const retained = shared.service.prepare('P1', 'view');
    await enteredStage;
    await shared.service.release('P0');
    unlock?.();
    await Promise.all([abandoned, retained]);
    assert.equal(shared.ephemeral.has(HASH_A), true, 'the second viewer retains shared custody');
    await shared.service.release('P1');
    assert.equal(shared.ephemeral.has(HASH_A), false);

    let finishSingle: (() => void) | undefined;
    const singleGate = new Promise<void>((resolve) => {
      finishSingle = resolve;
    });
    let singleStarted: (() => void) | undefined;
    const singleEntered = new Promise<void>((resolve) => {
      singleStarted = resolve;
    });
    const single = await world({ stageGate: singleGate, stageStarted: singleStarted });
    const opening = single.service.prepare('P2', 'view');
    await singleEntered;
    await single.service.release('P2');
    finishSingle?.();
    await opening;
    assert.equal(single.ephemeral.has(HASH_B), false, 'an abandoned fetch is removed immediately after verification');
    assert.equal(single.states.at(-1)?.stage, 'released');
  });

  test('disconnected, expired, offline, transient, and corrupt providers fail closed', async () => {
    const disconnected = await world();
    disconnected.setProviderConnected(false);
    await assert.rejects(
      disconnected.service.open('P0', 'view'),
      (error: unknown) => error instanceof EphemeralOriginalError && error.reason === 'custody-disconnected',
    );

    const expired = await world();
    expired.provider.authState = () => Promise.resolve('expired');
    await assert.rejects(
      expired.service.open('P0', 'view'),
      (error: unknown) => error instanceof EphemeralOriginalError && error.reason === 'custody-unavailable',
    );

    const offline = await world();
    offline.provider.authState = () => Promise.reject(new Error('network offline'));
    await assert.rejects(
      offline.service.open('P0', 'view'),
      (error: unknown) => error instanceof EphemeralOriginalError && error.reason === 'custody-unavailable',
    );

    const transient = await world();
    transient.provider.getStream = () => Promise.reject(new ProviderError('connection reset', 'transient'));
    await assert.rejects(
      transient.service.open('P0', 'view'),
      (error: unknown) => error instanceof EphemeralOriginalError && error.reason === 'custody-unavailable',
    );

    const corrupt = await world({ stageError: new Error('authentication failed') });
    await assert.rejects(
      corrupt.service.open('P0', 'view'),
      (error: unknown) => error instanceof EphemeralOriginalError && error.reason === 'verify-failed',
    );
    assert.equal(corrupt.ephemeral.size, 0);
  });
});
