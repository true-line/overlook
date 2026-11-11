import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { resolveFullCorsOrigin } from '../../src/main/fullres/full-cors.js';
import { handleFullRequest } from '../../src/main/fullres/full-response.js';
import { FullService } from '../../src/main/fullres/full-service.js';
import { createGuardedIpcRegistrar, installIpcSenderGuard, type IpcSenderEventLike } from '../../src/main/ipc-sender-guard.js';
import { LibraryRegistryError } from '../../src/main/library/library-registry.js';
import { LibraryRegistryRuntime } from '../../src/main/library/library-registry-runtime.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fullUrl } from '../../src/shared/library/full-url.js';

const PHOTO_ID = '01HZX4N9G6V8R2Q9K1M3P5S7T9';

interface FakeSenderEvent extends IpcSenderEventLike {
  readonly isInspector?: boolean;
}

describe('IPC sender guard and window hardening (#1436)', () => {
  test('rejects subframe senders and restricts detached Inspector to its channel allowlist', async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const blocked: Array<{ channelName: string; reason: 'subframe' | 'inspector-channel' }> = [];
    const guarded = createGuardedIpcRegistrar<FakeSenderEvent>(
      {
        handle(channelName, handler) {
          handlers.set(channelName, handler);
        },
      },
      {
        isInspectorSender: (event) => event.isInspector === true,
        reportBlocked: (channelName, reason) => blocked.push({ channelName, reason }),
      },
    );

    let purgeCalls = 0;
    let snapshotCalls = 0;
    guarded.handle(channels.libraryPurge.name, () => {
      purgeCalls += 1;
      return { ok: true };
    });
    guarded.handle(channels.inspectorWindowSnapshot.name, () => {
      snapshotCalls += 1;
      return { photoId: null };
    });

    const mainFrame = { id: 'main' };
    const subFrame = { id: 'child' };
    const primaryEvent: FakeSenderEvent = { sender: { mainFrame }, senderFrame: mainFrame, isInspector: false };
    const subframeEvent: FakeSenderEvent = { sender: { mainFrame }, senderFrame: subFrame, isInspector: false };
    const inspectorEvent: FakeSenderEvent = { sender: { mainFrame }, senderFrame: mainFrame, isInspector: true };

    const purgeHandler = handlers.get(channels.libraryPurge.name);
    const snapshotHandler = handlers.get(channels.inspectorWindowSnapshot.name);
    assert.ok(purgeHandler && snapshotHandler);

    assert.deepEqual(await purgeHandler(subframeEvent, {}), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_HANDLER_FAILED' },
    });
    assert.equal(purgeCalls, 0);

    assert.deepEqual(await purgeHandler(inspectorEvent, {}), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_HANDLER_FAILED' },
    });
    assert.equal(purgeCalls, 0);

    assert.deepEqual(await snapshotHandler(inspectorEvent, {}), { photoId: null });
    assert.equal(snapshotCalls, 1);

    assert.deepEqual(await purgeHandler(primaryEvent, {}), { ok: true });
    assert.equal(purgeCalls, 1);

    assert.deepEqual(blocked, [
      { channelName: channels.libraryPurge.name, reason: 'subframe' },
      { channelName: channels.libraryPurge.name, reason: 'inspector-channel' },
    ]);
  });

  test('installIpcSenderGuard wraps ipcMain.handle idempotently', () => {
    const rawHandlers = new Map<string, (event: FakeSenderEvent, ...args: unknown[]) => unknown>();
    const fakeIpcMain = {
      handle(channel: string, listener: (event: FakeSenderEvent, ...args: unknown[]) => unknown) {
        rawHandlers.set(channel, listener);
      },
    };
    installIpcSenderGuard(fakeIpcMain, {
      isInspectorSender: (event) => event.isInspector === true,
      reportBlocked: () => undefined,
    });
    installIpcSenderGuard(fakeIpcMain, {
      isInspectorSender: () => false,
      reportBlocked: () => undefined,
    });

    fakeIpcMain.handle(channels.keysExport.name, () => ({ exported: true }));
    const handler = rawHandlers.get(channels.keysExport.name);
    assert.ok(handler);

    const frame = { id: 'main' };
    assert.deepEqual(handler({ sender: { mainFrame: frame }, senderFrame: frame, isInspector: true }, {}), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_HANDLER_FAILED' },
    });
    assert.deepEqual(handler({ sender: { mainFrame: frame }, senderFrame: frame, isInspector: false }, {}), {
      exported: true,
    });
  });

  test('LibraryRegistryRuntime.removeEntry refuses removing the locked active library when openId is null', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'overlook-1436-registry-'));
    try {
      const runtime = new LibraryRegistryRuntime({ userDataDir: () => dir });
      const active = runtime.healActiveId();
      assert.throws(
        () => runtime.removeEntry(active.id, null, active.id),
        (error: unknown) =>
          error instanceof LibraryRegistryError && /cannot remove the active library while it is locked/u.test(error.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveFullCorsOrigin allows only trusted renderer origins and never emits wildcard *', () => {
    assert.deepEqual(resolveFullCorsOrigin(null, undefined), { allowed: true, headers: {} });
    assert.deepEqual(resolveFullCorsOrigin('null', undefined), {
      allowed: true,
      headers: { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' },
    });
    assert.deepEqual(resolveFullCorsOrigin('file://', undefined), {
      allowed: true,
      headers: { 'Access-Control-Allow-Origin': 'file://', Vary: 'Origin' },
    });
    assert.deepEqual(resolveFullCorsOrigin('https://evil.example', undefined), { allowed: false });

    assert.deepEqual(resolveFullCorsOrigin('http://localhost:5173', 'http://localhost:5173/index.html'), {
      allowed: true,
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:5173', Vary: 'Origin' },
    });
    assert.deepEqual(resolveFullCorsOrigin('null', 'http://localhost:5173'), { allowed: false });
    assert.deepEqual(resolveFullCorsOrigin('http://localhost:9999', 'http://localhost:5173'), { allowed: false });
  });

  test('handleFullRequest enforces trusted CORS on still and video responses without wildcard *', async () => {
    const previousDevUrl = process.env['ELECTRON_RENDERER_URL'];
    delete process.env['ELECTRON_RENDERER_URL'];
    const full = new FullService({
      loadOriginal: () =>
        Promise.resolve({
          bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          contentHash: 'a'.repeat(64),
          fileKind: 'jpeg',
        }),
      openVideoStream: (photoId) =>
        photoId === PHOTO_ID
          ? Promise.resolve(null)
          : Promise.resolve({
              stream: Readable.from(Buffer.from('0123456789')),
              totalBytes: 10,
              mime: 'video/mp4',
            }),
    });
    const videoId = '01HZX4N9G6V8R2Q9K1M3P5S7TA';
    try {
      const blocked = await handleFullRequest(
        () => full,
        () => undefined,
        new Request(fullUrl(PHOTO_ID), { headers: { Origin: 'https://evil.example' } }),
      );
      assert.equal(blocked.status, 403);
      assert.equal(blocked.headers.get('access-control-allow-origin'), null);
      assert.equal(blocked.headers.get('cache-control'), 'no-store');

      const internal = await handleFullRequest(
        () => full,
        () => undefined,
        new Request(fullUrl(PHOTO_ID)),
      );
      assert.equal(internal.status, 200);
      assert.equal(internal.headers.get('access-control-allow-origin'), null);

      const fileOrigin = await handleFullRequest(
        () => full,
        () => undefined,
        new Request(fullUrl(PHOTO_ID), { headers: { Origin: 'null' } }),
      );
      assert.equal(fileOrigin.status, 200);
      assert.equal(fileOrigin.headers.get('access-control-allow-origin'), 'null');

      const videoRange = await handleFullRequest(
        () => full,
        () => undefined,
        new Request(fullUrl(videoId), { headers: { Range: 'bytes=0-3', Origin: 'file://' } }),
      );
      assert.equal(videoRange.status, 206);
      assert.equal(videoRange.headers.get('access-control-allow-origin'), 'file://');

      const videoUnsatisfiable = await handleFullRequest(
        () => full,
        () => undefined,
        new Request(fullUrl(videoId), { headers: { Range: 'bytes=50-60' } }),
      );
      assert.equal(videoUnsatisfiable.status, 416);
      assert.equal(videoUnsatisfiable.headers.get('access-control-allow-origin'), null);
    } finally {
      if (previousDevUrl === undefined) delete process.env['ELECTRON_RENDERER_URL'];
      else process.env['ELECTRON_RENDERER_URL'] = previousDevUrl;
      await full.close();
    }
  });
});
