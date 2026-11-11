import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GoogleDriveAuthClient } from '../../src/main/backup/google-drive/auth-client.js';
import { GoogleDriveProvider } from '../../src/main/backup/google-drive/google-drive-provider.js';
import { GoogleDrivePathStore } from '../../src/main/backup/google-drive/path-store.js';
import { GoogleDriveTokenStore } from '../../src/main/backup/google-drive/token-store.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { exerciseProviderAccountContract } from './provider-account-contract.js';

const CLIENT_ID = 'desktop.apps.googleusercontent.com';
const LIBRARY_ID = '01KXGOOGLEDRIVELIBRARY001';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};

interface StoredFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parents: readonly string[];
  readonly appProperties: Record<string, string>;
  readonly bytes: Buffer;
  readonly trashed: boolean;
}

interface UploadSession {
  readonly metadata: {
    readonly name: string;
    readonly mimeType: string;
    readonly parents?: readonly string[];
    readonly appProperties: Record<string, string>;
  };
  readonly existingId: string | null;
  bytes: Buffer;
  completed: StoredFile | null;
}

function inputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function bodyText(body: RequestInit['body']): string {
  if (typeof body === 'string') return body;
  throw new Error('expected a string request body');
}

class DriveWorld {
  readonly files = new Map<string, StoredFile>();
  readonly sessions = new Map<string, UploadSession>();
  includeSha = true;
  quotaLimit: string | undefined = '1000000';
  account: { readonly permissionId: string; readonly emailAddress: string } | null = {
    permissionId: 'permission-1',
    emailAddress: 'owner@google.test',
  };
  interruptAfterCommit = false;
  badUploadLocation = false;
  rejectUploadStart = false;
  omitUploadSize = false;
  unauthorizedOnce = false;
  failNext: { status: number; reason?: string } | null = null;
  throwNext = false;
  refreshCalls = 0;
  private nextFile = 1;
  private nextSession = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = inputUrl(input);
    if (url.hostname === 'oauth2.googleapis.com') {
      this.refreshCalls += 1;
      return new Response(JSON.stringify({ access_token: `refreshed-${String(this.refreshCalls)}`, expires_in: 3600 }), { status: 200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization')?.startsWith('Bearer '), true, 'Drive calls use the Authorization header');
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('offline');
    }
    if (this.unauthorizedOnce) {
      this.unauthorizedOnce = false;
      return this.error(401, 'authError');
    }
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return this.error(failure.status, failure.reason);
    }
    if (url.pathname.startsWith('/upload/session/')) return this.uploadChunk(url, init);
    if (url.pathname.startsWith('/upload/drive/v3/files'))
      return this.rejectUploadStart ? this.error(403, 'storageQuotaExceeded') : this.startUpload(url, init);
    if (url.pathname === '/drive/v3/about') {
      return Response.json({
        ...(url.searchParams.get('fields')?.includes('user') === true ? { user: this.account ?? {} } : {}),
        storageQuota: { usage: String(this.usedBytes()), ...(this.quotaLimit === undefined ? {} : { limit: this.quotaLimit }) },
      });
    }
    if (url.pathname === '/drive/v3/files') {
      if (init?.method === 'POST') return this.createFolder(init);
      return this.list(url);
    }
    const id = decodeURIComponent(url.pathname.replace('/drive/v3/files/', ''));
    const file = this.files.get(id);
    if (file === undefined || file.trashed) return this.error(404, 'notFound');
    if (init?.method === 'DELETE') {
      // #750: `DELETE /files/{id}` bypasses Drive's trash. The product rule
      // forbids permanent remote destruction, so the fake refuses it too —
      // any adapter regression back to hard deletes fails here.
      return this.error(403, 'permanentDeleteForbidden');
    }
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(bodyText(init.body)) as { trashed?: boolean };
      if (patch.trashed !== true) return this.error(400, 'unsupportedPatch');
      this.files.set(id, { ...file, trashed: true });
      return Response.json(this.metadata({ ...file, trashed: true }));
    }
    if (url.searchParams.get('alt') === 'media') return new Response(file.bytes, { status: 200 });
    return Response.json(this.metadata(file));
  };

  removeFolder(name: string): void {
    for (const [id, file] of this.files) {
      if (file.name === name && file.mimeType === FOLDER_MIME) this.files.delete(id);
    }
  }

  private error(status: number, reason?: string): Response {
    return Response.json({ error: { errors: reason === undefined ? [] : [{ reason }] } }, { status });
  }

  private createFolder(init: RequestInit | undefined): Response {
    const metadata = JSON.parse(bodyText(init?.body)) as {
      name: string;
      mimeType: string;
      parents: string[];
      appProperties: Record<string, string>;
    };
    const file = this.store(metadata, Buffer.alloc(0));
    return Response.json({ id: file.id });
  }

  private startUpload(url: URL, init: RequestInit | undefined): Response {
    const metadata = JSON.parse(bodyText(init?.body)) as UploadSession['metadata'];
    const match = /^\/upload\/drive\/v3\/files\/(.+)$/u.exec(url.pathname);
    const existingId = match?.[1] === undefined ? null : decodeURIComponent(match[1]);
    const sessionId = `session-${String(this.nextSession++)}`;
    this.sessions.set(sessionId, { metadata, existingId, bytes: Buffer.alloc(0), completed: null });
    return new Response(null, {
      status: 200,
      headers: {
        location: this.badUploadLocation ? 'https://evil.example/upload' : `https://www.googleapis.com/upload/session/${sessionId}`,
      },
    });
  }

  private async uploadChunk(url: URL, init: RequestInit | undefined): Promise<Response> {
    const session = this.sessions.get(url.pathname.split('/').at(-1) ?? '');
    assert.ok(session !== undefined);
    const contentRange = new Headers(init?.headers).get('content-range') ?? '';
    if (contentRange === 'bytes */0' && (new Headers(init?.headers).get('content-length') ?? '0') === '0' && session.completed === null) {
      const prior = session.existingId === null ? null : this.files.get(session.existingId);
      const file = this.store(
        {
          ...session.metadata,
          parents: session.metadata.parents ?? prior?.parents ?? [],
        },
        session.bytes,
        session.existingId,
      );
      session.completed = file;
      return Response.json(this.metadata(file));
    }
    if (contentRange.startsWith('bytes */')) {
      if (session.completed !== null) return Response.json(this.metadata(session.completed));
      return new Response(null, {
        status: 308,
        headers: session.bytes.length === 0 ? {} : { range: `bytes=0-${String(session.bytes.length - 1)}` },
      });
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(contentRange);
    assert.ok(match !== null);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === '*' ? null : Number(match[3]);
    assert.equal(start, session.bytes.length);
    const incoming = Buffer.from(await new Response(init?.body).arrayBuffer());
    assert.equal(incoming.length, end - start + 1);
    session.bytes = Buffer.concat([session.bytes, incoming]);
    if (total === null || session.bytes.length < total) {
      return new Response(null, { status: 308, headers: { range: `bytes=0-${String(session.bytes.length - 1)}` } });
    }
    const prior = session.existingId === null ? null : this.files.get(session.existingId);
    const file = this.store(
      {
        ...session.metadata,
        parents: session.metadata.parents ?? prior?.parents ?? [],
      },
      session.bytes,
      session.existingId,
    );
    session.completed = file;
    if (this.interruptAfterCommit) {
      this.interruptAfterCommit = false;
      return this.error(503, 'backendError');
    }
    return Response.json(this.metadata(file));
  }

  private list(url: URL): Response {
    const query = url.searchParams.get('q') ?? '';
    const all = [...this.files.values()].filter((file) => this.matches(file, query));
    const offset = Number(url.searchParams.get('pageToken') ?? '0');
    const page = all.slice(offset, offset + 1);
    return Response.json({
      files: page.map((file) => this.metadata(file)),
      ...(offset + page.length < all.length ? { nextPageToken: String(offset + page.length) } : {}),
    });
  }

  private matches(file: StoredFile, query: string): boolean {
    if (query.includes('trashed = false') && file.trashed) return false;
    const parent = /'([^']+)' in parents/u.exec(query)?.[1];
    if (parent !== undefined && !file.parents.includes(parent)) return false;
    const name = /name = '([^']*)'/u.exec(query)?.[1];
    if (name !== undefined && file.name !== name.replace(/\\'/gu, "'")) return false;
    if (query.includes(`mimeType = '${FOLDER_MIME}'`) && file.mimeType !== FOLDER_MIME) return false;
    if (query.includes(`mimeType != '${FOLDER_MIME}'`) && file.mimeType === FOLDER_MIME) return false;
    const hash = /key='overlookPathHash' and value='([^']+)'/u.exec(query)?.[1];
    if (hash !== undefined && file.appProperties['overlookPathHash'] !== hash) return false;
    if (query.includes("key='overlookOwner'") && file.appProperties['overlookOwner'] !== 'qwts-photos') return false;
    return true;
  }

  private store(
    metadata: {
      readonly name: string;
      readonly mimeType: string;
      readonly parents: readonly string[];
      readonly appProperties: Record<string, string>;
    },
    bytes: Buffer,
    existingId: string | null = null,
  ): StoredFile {
    const file: StoredFile = {
      id: existingId ?? `file-${String(this.nextFile++)}`,
      name: metadata.name,
      mimeType: metadata.mimeType,
      parents: metadata.parents,
      appProperties: metadata.appProperties,
      bytes,
      trashed: false,
    };
    this.files.set(file.id, file);
    return file;
  }

  private metadata(file: StoredFile): Record<string, unknown> {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      appProperties: file.appProperties,
      trashed: file.trashed,
      ...(file.mimeType === FOLDER_MIME
        ? {}
        : {
            size: this.omitUploadSize ? undefined : String(file.bytes.length),
            sha256Checksum: this.includeSha ? createHash('sha256').update(file.bytes).digest('hex') : undefined,
          }),
    };
  }

  private usedBytes(): number {
    return [...this.files.values()].reduce((sum, file) => sum + file.bytes.length, 0);
  }
}

function setup(world = new DriveWorld(), pathsDir = mkdtempSync(join(tmpdir(), 'overlook-google-paths-test-'))) {
  const tokenStore = new GoogleDriveTokenStore({ safeStorage, dataDir: mkdtempSync(join(tmpdir(), 'overlook-google-provider-auth-')) });
  tokenStore.save({ clientId: CLIENT_ID, refreshToken: 'refresh-1', connectedAt: 'now' });
  const auth = new GoogleDriveAuthClient({ clientId: () => CLIENT_ID, tokenStore, fetchImpl: world.fetch });
  auth.seed('access-1', 3600);
  const paths = new GoogleDrivePathStore(pathsDir);
  const provider = new GoogleDriveProvider({ auth, paths, libraryId: LIBRARY_ID, fetchImpl: world.fetch });
  return { world, auth, paths, pathsDir, provider };
}

const PAYLOAD = Buffer.from('OVLK-encrypted-envelope');

test('Drive setup and upload initiation refusal permit retry without issuing target bytes', async () => {
  for (const phase of ['lookup', 'initiation']) {
    const state = setup();
    if (phase === 'lookup') state.world.failNext = { status: 403, reason: 'storageQuotaExceeded' };
    else state.world.rejectUploadStart = true;
    await assert.rejects(
      state.provider.put('recovery/bootstrap.ovrb', Readable.from([PAYLOAD])),
      (error: unknown) => error instanceof ProviderError && error.kind === 'quota' && error.mutationNotStarted,
    );
    assert.equal(state.world.sessions.size, 0);
    assert.equal(
      [...state.world.files.values()].some((file) => file.bytes.equals(PAYLOAD)),
      false,
    );
    state.world.rejectUploadStart = false;
    assert.deepEqual(await state.provider.put('recovery/bootstrap.ovrb', Readable.from([PAYLOAD])), { bytes: PAYLOAD.length });
  }
});

describe('Google Drive provider adapter (#277)', () => {
  test('captures account identity, detects replacement, and rejects an unavailable subject', async () => {
    const state = setup();
    await exerciseProviderAccountContract(state.provider, {
      accountId: 'permission-1',
      accountLabel: 'owner@google.test',
    });
    state.world.account = { permissionId: 'permission-2', emailAddress: 'replacement@google.test' };
    assert.deepEqual(await state.provider.accountIdentity(), {
      accountId: 'permission-2',
      accountLabel: 'replacement@google.test',
    });
    state.world.account = null;
    await assert.rejects(
      state.provider.accountIdentity(),
      (error: unknown) => error instanceof ProviderError && error.kind === 'transient',
    );
  });

  test('account replacement clears shared validation and path caches before rebuilding the remote tree', async () => {
    const first = new DriveWorld();
    const second = new DriveWorld();
    let active = first;
    const fetchImpl: typeof fetch = (input, init) => active.fetch(input, init);
    const tokenStore = new GoogleDriveTokenStore({
      safeStorage,
      dataDir: mkdtempSync(join(tmpdir(), 'overlook-google-account-switch-auth-')),
    });
    tokenStore.save({ clientId: CLIENT_ID, refreshToken: 'refresh-1', connectedAt: 'now' });
    const auth = new GoogleDriveAuthClient({ clientId: () => CLIENT_ID, tokenStore, fetchImpl });
    auth.seed('access-1', 3600);
    const paths = new GoogleDrivePathStore(mkdtempSync(join(tmpdir(), 'overlook-google-account-switch-paths-')));
    const provider = new GoogleDriveProvider({ auth, paths, libraryId: LIBRARY_ID, fetchImpl });

    await provider.put('blobs/aa/first.ovlk', Readable.from([PAYLOAD]));
    assert.notEqual(paths.overlookFolderId(), null);
    const scoped = provider.forLibrary('RESTORE_LIBRARY');

    active = second;
    auth.seed('access-2', 3600);
    provider.resetAccountCache();
    assert.equal(paths.overlookFolderId(), null);
    await scoped.put('blobs/bb/second.ovlk', Readable.from([PAYLOAD]));

    assert.equal(
      [...second.files.values()].some((file) => file.name === 'Overlook'),
      true,
    );
    assert.equal(
      [...second.files.values()].some((file) => file.name === 'RESTORE_LIBRARY'),
      true,
    );
  });

  test('provider contract: resumable put/list/get/verify/delete, quota, and restore discovery', async () => {
    const { provider } = setup();
    assert.equal(await provider.authState(), 'connected');
    assert.deepEqual(await provider.listLibraries(), []);

    assert.deepEqual(await provider.put('blobs/aa/one.ovlk', Readable.from([PAYLOAD])), { bytes: PAYLOAD.length });
    const large = Buffer.alloc(8 * 1024 * 1024 + 7, 9);
    assert.deepEqual(await provider.put('blobs/bb/two.ovlk', Readable.from([large])), { bytes: large.length });
    await provider.put('recovery/bootstrap.ovrb', Readable.from([PAYLOAD]));

    assert.deepEqual(await provider.listLibraries(), [LIBRARY_ID]);
    assert.deepEqual(await provider.list('blobs'), [
      { path: 'blobs/aa/one.ovlk', bytes: PAYLOAD.length },
      { path: 'blobs/bb/two.ovlk', bytes: large.length },
    ]);
    assert.deepEqual(await provider.probe('blobs/aa/one.ovlk'), { bytes: PAYLOAD.length });
    assert.deepEqual(await buffer(await provider.getStream('blobs/aa/one.ovlk')), PAYLOAD);
    assert.deepEqual(await provider.verify('blobs/aa/one.ovlk'), {
      sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
      bytes: PAYLOAD.length,
    });
    const quota = await provider.quota();
    assert.equal(quota.totalBytes, 1_000_000);
    assert.ok(quota.usedBytes >= PAYLOAD.length * 2 + large.length);

    await provider.delete('blobs/aa/one.ovlk');
    await provider.delete('blobs/aa/one.ovlk');
    await assert.rejects(
      provider.probe('blobs/aa/one.ovlk'),
      (error: unknown) => error instanceof ProviderError && error.kind === 'not-found',
    );
    await assert.rejects(
      provider.getStream('blobs/aa/one.ovlk'),
      (error: unknown) => error instanceof ProviderError && error.kind === 'not-found',
    );
    assert.equal(provider.forLibrary(LIBRARY_ID).id, 'google-drive');
    assert.throws(
      () => provider.forLibrary('../bad'),
      (error: unknown) => error instanceof ProviderError && error.kind === 'corrupt',
    );
  });

  test('delete trashes the Drive file: recoverable in place, absent to every read path (#750)', async () => {
    const { world, provider } = setup();
    await provider.put('blobs/aa/kept.ovlk', Readable.from([PAYLOAD]));
    await provider.delete('blobs/aa/kept.ovlk');

    const stored = [...world.files.values()].find((file) => file.name === 'kept.ovlk');
    assert.equal(stored?.trashed, true, 'the object survives in Drive trash — never permanently destroyed');
    assert.deepEqual(await provider.list('blobs'), [], 'a trashed object is absent to listing');
    await assert.rejects(
      provider.getStream('blobs/aa/kept.ovlk'),
      (error: unknown) => error instanceof ProviderError && error.kind === 'not-found',
    );
    await assert.rejects(
      provider.verify('blobs/aa/kept.ovlk'),
      (error: unknown) => error instanceof ProviderError && error.kind === 'not-found',
    );
    await provider.delete('blobs/aa/kept.ovlk');

    const replacement = Buffer.from('OVLK-replacement-after-trash');
    await provider.put('blobs/aa/kept.ovlk', Readable.from([replacement]));
    assert.deepEqual(await buffer(await provider.getStream('blobs/aa/kept.ovlk')), replacement);
    const survivors = [...world.files.values()].filter((file) => file.name === 'kept.ovlk');
    assert.equal(survivors.filter((file) => file.trashed).length, 1, 'the trashed generation still exists after re-upload');
    assert.equal(survivors.filter((file) => !file.trashed).length, 1);
  });

  test('lost final response resumes, missing SHA-256 re-downloads, unlimited quota stays honest, stale IDs rebuild', async () => {
    const world = new DriveWorld();
    world.includeSha = false;
    world.interruptAfterCommit = true;
    world.quotaLimit = undefined;
    const first = setup(world);
    assert.deepEqual(await first.provider.put('blobs/cc/resumed.ovlk', Readable.from([PAYLOAD])), { bytes: PAYLOAD.length });
    assert.deepEqual(await first.provider.verify('blobs/cc/resumed.ovlk'), {
      sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
      bytes: PAYLOAD.length,
    });
    assert.deepEqual(await first.provider.quota(), { usedBytes: PAYLOAD.length, totalBytes: null });

    const restarted = setup(world, first.pathsDir).provider;
    assert.deepEqual(
      await buffer(await restarted.getStream('blobs/cc/resumed.ovlk')),
      PAYLOAD,
      'persisted IDs are revalidated after restart',
    );
    world.removeFolder('cc');
    assert.deepEqual(await restarted.put('blobs/cc/rebuilt.ovlk', Readable.from([PAYLOAD])), { bytes: PAYLOAD.length });
  });

  test('auth refresh and Drive errors map without leaking credentials', async () => {
    const state = setup();
    state.world.unauthorizedOnce = true;
    assert.equal((await state.provider.quota()).totalBytes, 1_000_000);
    assert.equal(state.world.refreshCalls, 1, '401 invalidates and refreshes once');

    const failures: readonly [number, string | undefined, ProviderError['kind']][] = [
      [403, 'storageQuotaExceeded', 'quota'],
      [403, 'insufficientFilePermissions', 'auth'],
      [429, 'rateLimitExceeded', 'transient'],
      [400, 'badRequest', 'corrupt'],
    ];
    for (const [status, reason, kind] of failures) {
      state.world.failNext = { status, ...(reason === undefined ? {} : { reason }) };
      await assert.rejects(state.provider.quota(), (error: unknown) => error instanceof ProviderError && error.kind === kind);
    }
    state.world.throwNext = true;
    await assert.rejects(state.provider.quota(), (error: unknown) => error instanceof ProviderError && error.kind === 'transient');
  });

  test('unsafe paths, unsafe session hosts, and incomplete upload metadata fail closed', async () => {
    const state = setup();
    for (const path of ['', '/abs', 'a/../b', 'a\\b']) {
      await assert.rejects(
        state.provider.put(path, Readable.from([PAYLOAD])),
        (error: unknown) => error instanceof ProviderError && error.kind === 'corrupt',
      );
    }
    state.world.badUploadLocation = true;
    await assert.rejects(
      state.provider.put('blobs/xx/bad-location', Readable.from([PAYLOAD])),
      (error: unknown) => error instanceof ProviderError && error.kind === 'corrupt',
    );
    const missing = setup();
    missing.world.omitUploadSize = true;
    await assert.rejects(
      missing.provider.put('blobs/xx/missing-size', Readable.from([PAYLOAD])),
      (error: unknown) => error instanceof ProviderError && error.kind === 'transient' && !error.mutationNotStarted,
    );
  });

  test('#1438: multi-chunk upload streams lazily with bounded read-ahead instead of buffering the whole stream', async () => {
    const world = new DriveWorld();
    const tokenStore = new GoogleDriveTokenStore({ safeStorage, dataDir: mkdtempSync(join(tmpdir(), 'overlook-google-stream-auth-')) });
    tokenStore.save({ clientId: CLIENT_ID, refreshToken: 'refresh-1', connectedAt: 'now' });
    const auth = new GoogleDriveAuthClient({ clientId: () => CLIENT_ID, tokenStore, fetchImpl: world.fetch });
    auth.seed('access-1', 3600);
    const paths = new GoogleDrivePathStore(mkdtempSync(join(tmpdir(), 'overlook-google-stream-paths-')));
    const chunkBytes = 256 * 1024;
    const rangesSeen: string[] = [];
    let producedSlices = 0;
    const sliceBytes = 64 * 1024;
    const totalSlices = 10; // 640 KiB = 2 * 256 KiB + 128 KiB
    const expectedHash = createHash('sha256');
    const source = new Readable({
      read() {
        if (producedSlices >= totalSlices) {
          this.push(null);
          return;
        }
        const piece = Buffer.alloc(sliceBytes, producedSlices + 1);
        producedSlices += 1;
        expectedHash.update(piece);
        this.push(piece);
      },
    });
    const fetchSpy: typeof fetch = async (input, init) => {
      const url = inputUrl(input);
      if (url.pathname.startsWith('/upload/session/')) {
        const range = new Headers(init?.headers).get('content-range') ?? '';
        rangesSeen.push(range);
        if (rangesSeen.length === 1) {
          assert.ok(producedSlices < totalSlices, 'first 256 KiB chunk uploads before the remainder of the stream is pulled');
        }
      }
      return world.fetch(input, init);
    };
    const provider = new GoogleDriveProvider({ auth, paths, libraryId: LIBRARY_ID, fetchImpl: fetchSpy, chunkBytes });
    const result = await provider.put('blobs/st/streamed.ovlk', source);
    assert.deepEqual(result, { bytes: totalSlices * sliceBytes });
    assert.deepEqual(rangesSeen, ['bytes 0-262143/*', 'bytes 262144-524287/*', 'bytes 524288-655359/655360']);
    assert.deepEqual(await provider.verify('blobs/st/streamed.ovlk'), {
      sha256: expectedHash.digest('hex'),
      bytes: totalSlices * sliceBytes,
    });
  });
});
