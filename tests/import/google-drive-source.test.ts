import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GOOGLE_DRIVE_SCOPE } from '../../src/main/backup/google-drive/oauth.js';
import { GoogleDriveImportSource } from '../../src/main/import/google-drive-source.js';

const CLIENT_ID = 'desktop.apps.googleusercontent.com';

function testSource(options?: { readonly metadata?: Readonly<Record<string, object>>; readonly fixture?: string }) {
  const stagingRoot = mkdtempSync(join(tmpdir(), 'overlook-drive-stage-'));
  const opened: URL[] = [];
  const metadata = options?.metadata ?? {
    photo_1: { id: 'photo_1', name: 'Kyoto.JPG', mimeType: 'image/jpeg', capabilities: { canDownload: true } },
    raw_2: { id: 'raw_2', name: 'Fuji.RAF', mimeType: 'image/x-fuji-raf', capabilities: { canDownload: true } },
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === 'oauth2.googleapis.com') {
      return Promise.resolve(new Response(JSON.stringify({ access_token: 'access-1', scope: GOOGLE_DRIVE_SCOPE }), { status: 200 }));
    }
    assert.equal(init?.headers === undefined ? '' : new Headers(init.headers).get('authorization'), 'Bearer access-1');
    const id = decodeURIComponent(url.pathname.replace('/drive/v3/files/', ''));
    if (url.searchParams.get('alt') === 'media') {
      return Promise.resolve(new Response(Buffer.from(`bytes:${id}`), { status: 200 }));
    }
    const record = metadata[id];
    return Promise.resolve(record === undefined ? new Response(null, { status: 404 }) : Response.json(record));
  };
  const source = new GoogleDriveImportSource({
    stagingRoot,
    clientId: () => (options?.fixture === undefined ? CLIENT_ID : null),
    openExternal: async (value) => {
      const url = new URL(value);
      opened.push(url);
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      await fetch(
        `${redirect}?code=code-1&state=${url.searchParams.get('state') ?? ''}&picked_file_ids=${Object.keys(metadata).join(',')}`,
      );
    },
    fixtureSource: () => options?.fixture,
    fetchImpl,
  });
  return { source, stagingRoot, opened };
}

describe('Google Drive import source (#465)', () => {
  test('cancelling an active Picker closes capture and releases the busy guard', async () => {
    let rejectResult: ((error: Error) => void) | undefined;
    let closes = 0;
    let configured = true;
    const source = new GoogleDriveImportSource({
      stagingRoot: mkdtempSync(join(tmpdir(), 'overlook-drive-cancel-picker-')),
      clientId: () => (configured ? CLIENT_ID : null),
      openExternal: () => Promise.resolve(),
      capture: () => ({
        listening: Promise.resolve({ port: 1, redirectUri: 'http://127.0.0.1:1' }),
        result: new Promise((_resolve, reject) => {
          rejectResult = reject;
        }),
        close: () => {
          closes += 1;
          rejectResult?.(new Error('cancelled'));
        },
      }),
    });
    const picking = source.pick();
    await new Promise((resolve) => setImmediate(resolve));
    source.cancelPick();
    assert.deepEqual(await picking, { status: 'cancelled' });
    assert.ok(closes >= 1);
    configured = false;
    assert.deepEqual(await source.pick(), { status: 'unavailable' });
  });

  test('cancelling an in-flight download removes partial plaintext staging', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'overlook-drive-cancel-download-'));
    let downloadStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const source = new GoogleDriveImportSource({
      stagingRoot,
      clientId: () => CLIENT_ID,
      openExternal: () => Promise.resolve(),
      capture: () => ({
        listening: Promise.resolve({ port: 1, redirectUri: 'http://127.0.0.1:1' }),
        result: Promise.resolve({ code: 'code-1', pickedFileIds: ['photo_1'] }),
        close: () => undefined,
      }),
      fetchImpl: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.hostname === 'oauth2.googleapis.com') {
          return Promise.resolve(new Response(JSON.stringify({ access_token: 'access-1', scope: GOOGLE_DRIVE_SCOPE }), { status: 200 }));
        }
        if (url.searchParams.get('alt') !== 'media') {
          return Promise.resolve(
            Response.json({ id: 'photo_1', name: 'Cloud.jpg', mimeType: 'image/jpeg', capabilities: { canDownload: true } }),
          );
        }
        downloadStarted?.();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    });
    const picking = source.pick();
    await started;
    source.cancelPick();
    assert.deepEqual(await picking, { status: 'cancelled' });
    assert.deepEqual(readdirSync(stagingRoot), []);
  });

  test('a second picker request is refused while the browser flow is active', async () => {
    let finish: ((value: { code: string; pickedFileIds: readonly string[] }) => void) | undefined;
    const result = new Promise<{ code: string; pickedFileIds: readonly string[] }>((resolve) => {
      finish = resolve;
    });
    const source = new GoogleDriveImportSource({
      stagingRoot: mkdtempSync(join(tmpdir(), 'overlook-drive-busy-')),
      clientId: () => CLIENT_ID,
      openExternal: () => Promise.resolve(),
      capture: () => ({
        listening: Promise.resolve({ port: 1, redirectUri: 'http://127.0.0.1:1' }),
        result,
        close: () => undefined,
      }),
      fetchImpl: () =>
        Promise.resolve(new Response(JSON.stringify({ access_token: 'access-1', scope: GOOGLE_DRIVE_SCOPE }), { status: 200 })),
    });
    const first = source.pick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await source.pick(), { status: 'busy' });
    finish?.({ code: 'code-1', pickedFileIds: [] });
    assert.deepEqual(await first, { status: 'no-supported-files' });
  });

  test('Picker grants selected files only, stages supported media, and discards it', async () => {
    const world = testSource();
    const result = await world.source.pick();
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    const [url] = world.opened;
    assert.equal(url?.searchParams.get('scope'), GOOGLE_DRIVE_SCOPE);
    assert.equal(url?.searchParams.get('trigger_onepick'), 'true');
    assert.equal(url?.searchParams.get('allow_multiple'), 'true');
    assert.deepEqual(
      result.selection.files.map(({ fileName, kind }) => ({ fileName, kind })),
      [
        { fileName: 'Kyoto.JPG', kind: 'jpeg' },
        { fileName: 'Fuji.RAF', kind: 'raw' },
      ],
    );
    assert.deepEqual(
      result.selection.files.map(({ path }) => readFileSync(path, 'utf8')),
      ['bytes:photo_1', 'bytes:raw_2'],
    );
    const root = result.selection.rootPath ?? '';
    assert.equal(existsSync(root), true);
    await world.source.discard(result.selection);
    assert.equal(existsSync(root), false);
  });

  test('unsupported and non-downloadable selections are skipped honestly', async () => {
    const world = testSource({
      metadata: {
        note: { id: 'note', name: 'notes.pdf', mimeType: 'application/pdf', capabilities: { canDownload: true } },
        locked: { id: 'locked', name: 'locked.jpg', mimeType: 'image/jpeg', capabilities: { canDownload: false } },
        good: { id: 'good', name: 'good.heic', mimeType: 'image/heic', capabilities: { canDownload: true } },
      },
    });
    const result = await world.source.pick();
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(result.selection.skipped, 2);
    assert.deepEqual(
      result.selection.files.map((file) => file.fileName),
      ['good.heic'],
    );
  });

  test('fixture flow needs no OAuth credential and never removes user files', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'overlook-drive-fixture-'));
    writeFileSync(join(fixture, 'cloud.jpg'), 'fixture');
    writeFileSync(join(fixture, 'ignored.txt'), 'fixture');
    const world = testSource({ fixture });
    const result = await world.source.pick();
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(result.selection.rootPath, null);
    assert.deepEqual(
      result.selection.files.map((file) => file.fileName),
      ['cloud.jpg'],
    );
    await world.source.discard(result.selection);
    assert.equal(existsSync(join(fixture, 'cloud.jpg')), true);
    assert.equal(world.opened.length, 0);
  });

  test('startup cleanup preserves only the journal-owned selection', async () => {
    const world = testSource({ fixture: mkdtempSync(join(tmpdir(), 'overlook-empty-fixture-')) });
    const keep = join(world.stagingRoot, 'selection-keep');
    const remove = join(world.stagingRoot, 'selection-remove');
    mkdirSync(keep);
    mkdirSync(remove);
    await world.source.cleanupOrphans(keep);
    assert.equal(existsSync(keep), true);
    assert.equal(existsSync(remove), false);
  });

  test('sanitizes remote path-traversal, separator, and control-character filenames (#1428)', async () => {
    const world = testSource({
      metadata: {
        trav_posix: { id: 'trav_posix', name: '../../outside.jpg', mimeType: 'image/jpeg', capabilities: { canDownload: true } },
        trav_win: { id: 'trav_win', name: '..\\..\\win.png', mimeType: 'image/png', capabilities: { canDownload: true } },
        dated: { id: 'dated', name: '2026/07/Beach\u0000Shot.JPG', mimeType: 'image/jpeg', capabilities: { canDownload: true } },
        dots_only: { id: 'dots_only', name: '../..', mimeType: 'image/jpeg', capabilities: { canDownload: true } },
      },
    });
    const result = await world.source.pick();
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(result.selection.skipped, 1);
    assert.deepEqual(
      result.selection.files.map((file) => file.fileName),
      ['outside.jpg', 'win.png', '2026_07_Beach_Shot.JPG'],
    );
  });
});
