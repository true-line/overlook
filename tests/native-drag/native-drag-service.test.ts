import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { NativeDragOutService, uniquePromiseNames } from '../../src/main/native-drag/native-drag-service.js';
import { decodePhotoDrag } from '../../src/shared/library/photo-drag.js';
import { photo, FakeBridge, defaultPlanner } from './native-drag-fixture.js';

describe('native drag-out materialization (#796)', () => {
  test('creates deterministic case-insensitive multi-selection names', () => {
    assert.deepEqual(uniquePromiseNames(['IMG.JPG', 'img.jpg', 'IMG.JPG', 'README']), ['IMG.JPG', 'img (2).jpg', 'IMG (3).JPG', 'README']);
    assert.throws(() => uniquePromiseNames(['../']));
  });

  test('stays lazy until a receiver accepts each promise and preserves the internal payload', async () => {
    const bridge = new FakeBridge();
    const rows = new Map([
      ['P1', photo('P1', 'Shared.JPG')],
      ['P2', photo('P2', 'shared.jpg')],
    ]);
    let opens = 0;
    let releases = 0;
    const service = new NativeDragOutService({
      disclosure: defaultPlanner,
      bridge,
      getPhoto: (id) => rows.get(id),
      openOriginal: () => {
        opens += 1;
        return Promise.resolve({
          stream: Readable.from(['bytes']),
          release: () => {
            releases += 1;
            return Promise.resolve();
          },
        });
      },
      admit: () => true,
    });

    assert.deepEqual(service.start(Buffer.alloc(8), { photoIds: ['P1', 'P2'], sourceAlbumId: 'A1' }), {
      started: true,
      reason: null,
    });
    assert.equal(opens, 0, 'starting a drag must not materialize plaintext');
    assert.deepEqual(decodePhotoDrag(bridge.input?.internalPayload ?? ''), {
      version: 1,
      photoIds: ['P1', 'P2'],
      sourceAlbumId: 'A1',
    });
    assert.deepEqual(
      bridge.input?.items.map(({ fileName }) => fileName),
      ['Shared.JPG', 'shared (2).jpg'],
    );

    const destination = mkdtempSync(join(tmpdir(), 'overlook-native-drag-'));
    const item = bridge.input?.items[1];
    assert.ok(item);
    const output = join(destination, 'receiver-resolved.jpg');
    await bridge.input?.materialize({ token: item.token, destinationPath: output });
    assert.equal(readFileSync(output, 'utf8'), 'bytes');
    assert.equal(opens, 1);
    assert.equal(releases, 1);
  });

  test('fails the whole selection closed for missing, deleted, locked, or forged destinations', async () => {
    const bridge = new FakeBridge();
    let admitted = true;
    let opens = 0;
    const deleted = { ...photo('DELETED'), deletedAt: '2026-01-01T00:00:00.000Z' };
    const rows = new Map([
      ['P1', photo('P1')],
      ['DELETED', deleted],
    ]);
    const service = new NativeDragOutService({
      disclosure: defaultPlanner,
      bridge,
      getPhoto: (id) => rows.get(id),
      openOriginal: () => {
        opens += 1;
        return Promise.resolve({ stream: Readable.from(['bytes']) });
      },
      admit: () => admitted,
    });
    assert.deepEqual(service.start(Buffer.alloc(8), { photoIds: ['P1', 'MISSING'], sourceAlbumId: null }), {
      started: false,
      reason: 'content-unavailable',
    });
    assert.deepEqual(service.start(Buffer.alloc(8), { photoIds: ['DELETED'], sourceAlbumId: null }), {
      started: false,
      reason: 'content-unavailable',
    });
    admitted = false;
    assert.deepEqual(service.start(Buffer.alloc(8), { photoIds: ['P1'], sourceAlbumId: null }), {
      started: false,
      reason: 'content-unavailable',
    });
    admitted = true;
    assert.equal(service.start(Buffer.alloc(8), { photoIds: ['P1'], sourceAlbumId: null }).started, true);
    const item = bridge.input?.items[0];
    assert.ok(item);
    await assert.rejects(bridge.input?.materialize({ token: item.token, destinationPath: 'relative/forged.jpg' }) ?? Promise.resolve());
    assert.equal(opens, 0);
  });

  test('rejects photos in protected migration before advertising native promises (#796 review)', () => {
    const bridge = new FakeBridge();
    const service = new NativeDragOutService({
      disclosure: defaultPlanner,
      bridge,
      getPhoto: () => photo('P1'),
      isMigrating: (photoId) => photoId === 'P1',
      openOriginal: () => Promise.resolve({ stream: Readable.from(['bytes']) }),
      admit: () => true,
    });

    assert.deepEqual(service.start(Buffer.alloc(8), { photoIds: ['P1'], sourceAlbumId: null }), {
      started: false,
      reason: 'content-unavailable',
    });
    assert.equal(bridge.input, null);
  });

  test('does not delete a receiver-owned destination when exclusive creation fails (#796 review)', async () => {
    const bridge = new FakeBridge();
    const service = new NativeDragOutService({
      disclosure: defaultPlanner,
      bridge,
      getPhoto: () => photo('P1'),
      openOriginal: () => Promise.resolve({ stream: Readable.from(['new bytes']) }),
      admit: () => true,
    });
    service.start(Buffer.alloc(8), { photoIds: ['P1'], sourceAlbumId: null });
    const item = bridge.input?.items[0];
    assert.ok(item);
    const destination = join(mkdtempSync(join(tmpdir(), 'overlook-native-drag-owned-')), item.fileName);
    writeFileSync(destination, 'receiver bytes');

    await assert.rejects(bridge.input?.materialize({ token: item.token, destinationPath: destination }) ?? Promise.resolve());
    assert.equal(readFileSync(destination, 'utf8'), 'receiver bytes');
  });

  test('cancellation races a pending offloaded open and releases any late custody (#796 review)', async () => {
    const bridge = new FakeBridge();
    let resolveOpen: ((opened: { stream: Readable; release: () => Promise<void> }) => void) | undefined;
    let releases = 0;
    const service = new NativeDragOutService({
      disclosure: defaultPlanner,
      bridge,
      getPhoto: () => ({ ...photo('P1'), syncState: 'offloaded' }),
      openOriginal: () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
      admit: () => true,
    });
    service.start(Buffer.alloc(8), { photoIds: ['P1'], sourceAlbumId: null });
    const item = bridge.input?.items[0];
    assert.ok(item);
    const materializing = bridge.input?.materialize({ token: item.token, destinationPath: join(tmpdir(), item.fileName) });
    await new Promise((resolve) => setImmediate(resolve));

    service.close();
    await assert.rejects(materializing ?? Promise.resolve());
    await service.drain();
    resolveOpen?.({
      stream: Readable.from(['late bytes']),
      release: () => {
        releases += 1;
        return Promise.resolve();
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases, 1);
  });

  test('lock/close aborts in-flight writes, releases offloaded custody, and cancels native promises', async () => {
    const bridge = new FakeBridge();
    let release = 0;
    let rejectWrite: ((error: Error) => void) | undefined;
    const service = new NativeDragOutService({
      disclosure: defaultPlanner,
      bridge,
      getPhoto: () => ({ ...photo('P1'), syncState: 'offloaded' }),
      openOriginal: () =>
        Promise.resolve({
          stream: Readable.from(['ciphertext-decrypted-stream']),
          release: () => {
            release += 1;
            return Promise.resolve();
          },
        }),
      admit: () => true,
      writeFile: (_path, _stream, signal) =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    service.start(Buffer.alloc(8), { photoIds: ['P1'], sourceAlbumId: null });
    const item = bridge.input?.items[0];
    assert.ok(item);
    const materializing = bridge.input?.materialize({ token: item.token, destinationPath: join(tmpdir(), item.fileName) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(rejectWrite, undefined);
    service.close();
    await assert.rejects(materializing ?? Promise.resolve());
    assert.equal(release, 1);
    assert.ok(bridge.cancels >= 1);
    assert.equal(bridge.closes, 1);
  });
});
