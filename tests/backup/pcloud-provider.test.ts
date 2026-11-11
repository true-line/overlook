import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { PCloudProvider } from '../../src/main/backup/pcloud/pcloud-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import type { PCloudAuthRecord } from '../../src/main/backup/pcloud/token-store.js';
import { exerciseProviderAccountContract } from './provider-account-contract.js';

// #255 exit criteria: every StorageProvider method and every error-mapping
// class proven against a scripted pCloud API — no network.

const RECORD: PCloudAuthRecord = { accessToken: 'tok-1', apiHost: 'api.pcloud.com', connectedAt: '2026-07-13T00:00:00.000Z' };

interface ApiCall {
  readonly method: string;
  readonly params: Map<string, string>;
  /** Multipart entry names in wire order — pCloud reads params only when
   * they PRECEDE the file part. */
  readonly entryOrder: readonly string[];
  readonly fileBytes?: Buffer;
  readonly contentLength?: string | null;
}

type Script = Record<string, (params: Map<string, string>, call: ApiCall) => unknown>;

/** A fetch stub speaking pCloud's envelope: routes API methods through the
 * script, serves download hosts from `downloads`. */
function world(script: Script, downloads: Record<string, string | number> = {}, spoolThresholdBytes?: number) {
  const calls: ApiCall[] = [];
  const route = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname.startsWith('dl.')) {
      const body = downloads[url.pathname];
      if (body === undefined) {
        return new Response(null, { status: 404 });
      }
      return typeof body === 'number' ? new Response(null, { status: body }) : new Response(body);
    }
    const method = url.pathname.slice(1);
    const params = new Map<string, string>();
    const entryOrder: string[] = [];
    let fileBytes: Buffer | undefined;
    const headers = new Headers(init?.headers);
    const contentLength = headers.get('content-length');
    const body = init?.body;
    if (body instanceof URLSearchParams) {
      for (const [key, value] of body.entries()) {
        entryOrder.push(key);
        params.set(key, value);
      }
    } else if (body !== undefined && body !== null) {
      const form = body instanceof FormData ? body : await new Response(body, { headers }).formData();
      for (const [key, value] of form.entries()) {
        entryOrder.push(key);
        if (typeof value === 'string') {
          params.set(key, value);
        } else {
          fileBytes = Buffer.from(await value.arrayBuffer());
        }
      }
    }
    const call: ApiCall = {
      method,
      params,
      entryOrder,
      ...(fileBytes === undefined ? {} : { fileBytes }),
      contentLength,
    };
    calls.push(call);
    const handler = script[method];
    if (handler === undefined) {
      throw new Error(`unscripted pCloud method: ${method}`);
    }
    const result = handler(params, call);
    return result instanceof Response ? result : new Response(JSON.stringify(result));
  };
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => route(input, init)) as typeof fetch;
  const provider = new PCloudProvider({
    auth: () => RECORD,
    libraryId: 'lib1',
    fetchImpl,
    ...(spoolThresholdBytes === undefined ? {} : { spoolThresholdBytes }),
  });
  return { provider, calls };
}

const ok = (extra: Record<string, unknown> = {}) => ({ result: 0, ...extra });

test('pCloud distinguishes folder preparation refusal from an issued upload', async () => {
  for (const result of [2094, 2008]) {
    let fail = true;
    const state = world({
      createfolderifnotexists: () => (fail ? { result, error: 'setup refused' } : ok()),
      uploadfile: () => ok({ metadata: [{ size: 3 }] }),
    });
    await assert.rejects(
      state.provider.put('recovery/bootstrap.ovrb', Readable.from(['abc'])),
      (error: unknown) => error instanceof ProviderError && error.mutationNotStarted && error.kind === (result === 2008 ? 'quota' : 'auth'),
    );
    assert.equal(
      state.calls.some((call) => call.method === 'uploadfile'),
      false,
    );
    fail = false;
    assert.deepEqual(await state.provider.put('recovery/bootstrap.ovrb', Readable.from(['abc'])), { bytes: 3 });
  }
  const issued = world({
    createfolderifnotexists: () => ok(),
    uploadfile: () => {
      throw new Error('lost response');
    },
  });
  await assert.rejects(
    issued.provider.put('recovery/bootstrap.ovrb', Readable.from(['abc'])),
    (error: unknown) => error instanceof ProviderError && !error.mutationNotStarted,
  );
  assert.equal(
    issued.calls.some((call) => call.method === 'uploadfile'),
    true,
  );
});

describe('pCloud provider adapter (#255)', () => {
  test('declares the conservative capability contract used by generic UI', () => {
    const { provider } = world({});
    assert.deepEqual(provider.capabilities, {
      quota: 'known',
      verification: 'download-hash',
      resumableUpload: false,
      platforms: ['darwin', 'win32', 'linux'],
      interactiveAuth: true,
      reconnectRequired: true,
      accountIdentity: 'stable-subject',
    });
  });

  test('captures a stable account subject and rejects anonymous identity', async () => {
    const current = world({ userinfo: () => ok({ userid: 4242, email: 'owner@pcloud.test' }) });
    await exerciseProviderAccountContract(current.provider, { accountId: '4242', accountLabel: 'owner@pcloud.test' });

    const changed = world({ userinfo: () => ok({ userid: 5252, email: 'replacement@pcloud.test' }) });
    assert.deepEqual(await changed.provider.accountIdentity(), { accountId: '5252', accountLabel: 'replacement@pcloud.test' });

    const anonymous = world({ userinfo: () => ok({ userid: 4242 }) });
    await assert.rejects(
      anonymous.provider.accountIdentity(),
      (error: unknown) => error instanceof ProviderError && error.kind === 'transient',
    );
  });

  test('discovers only completed recovery homes; ignores in-progress backups and empty scratch folders (#291)', async () => {
    const { provider, calls } = world({
      listfolder: (params) => {
        const path = params.get('path');
        if (path === '/Overlook') {
          return ok({
            metadata: {
              name: 'Overlook',
              isfolder: true,
              contents: [
                { name: '01JSAFE', isfolder: true },
                { name: '01JUPLOADING', isfolder: true },
                { name: 'contract-scratch-01JEMPTY', isfolder: true },
                { name: '../escape', isfolder: true },
                { name: 'file.txt', isfolder: false, size: 2 },
              ],
            },
          });
        }
        if (path === '/Overlook/01JSAFE/recovery') {
          return ok({
            metadata: {
              name: 'recovery',
              isfolder: true,
              contents: [{ name: 'bootstrap.ovrb', isfolder: false, size: 123 }],
            },
          });
        }
        return { result: 2005, error: 'Directory does not exist.' };
      },
    });
    assert.deepEqual(await provider.listLibraries(), ['01JSAFE']);
    assert.equal(calls[0]?.params.get('path'), '/Overlook');
    assert.equal(calls[0]?.params.has('recursive'), false, 'the root listing never enumerates every backup object');
    assert.deepEqual(
      calls.slice(1).map((call) => call.params.get('path')),
      ['/Overlook/01JSAFE/recovery', '/Overlook/01JUPLOADING/recovery', '/Overlook/contract-scratch-01JEMPTY/recovery'],
    );
    assert.equal(provider.forLibrary('01JSAFE').id, 'pcloud');
    assert.throws(
      () => provider.forLibrary('../escape'),
      (error: unknown) => error instanceof ProviderError && error.kind === 'corrupt',
    );
  });

  test('EXIT CRITERIA: put ensures ancestors once, uploads under /Overlook/<libraryId>/, reports recorded size', async () => {
    const { provider, calls } = world({
      createfolderifnotexists: () => ok(),
      uploadfile: () => ok({ metadata: [{ name: 'h1', isfolder: false, size: 7 }] }),
    });
    assert.deepEqual(await provider.put('blobs/ab/h1', Readable.from([Buffer.from('payload')])), { bytes: 7 });

    const folders = calls.filter((c) => c.method === 'createfolderifnotexists').map((c) => c.params.get('path'));
    assert.deepEqual(folders, ['/Overlook', '/Overlook/lib1', '/Overlook/lib1/blobs', '/Overlook/lib1/blobs/ab']);
    const upload = calls.find((c) => c.method === 'uploadfile');
    assert.equal(upload?.params.get('path'), '/Overlook/lib1/blobs/ab');
    assert.equal(upload?.params.get('filename'), 'h1');
    assert.equal(upload?.params.get('access_token'), 'tok-1');
    assert.equal(upload?.params.get('nopartial'), '1');
    // pCloud reads POST params only when they precede the file part
    // (Codex P1 on PR #259): the file must be the LAST multipart entry.
    assert.equal(upload?.entryOrder.at(-1), 'file');
    assert.ok((upload?.entryOrder.indexOf('access_token') ?? -1) < (upload?.entryOrder.indexOf('file') ?? -1));

    // Second put in the same fan-out folder: the ancestor cache pays zero
    // extra createfolder round-trips.
    await provider.put('blobs/ab/h2', Readable.from([Buffer.from('x')]));
    assert.equal(calls.filter((c) => c.method === 'createfolderifnotexists').length, 4);
  });

  test('unsafe remote paths are rejected outright, before any network', async () => {
    const { provider, calls } = world({});
    for (const bad of ['/abs', 'a/../b', '', 'a//b', 'a\\..\\outside', 'C:/evil']) {
      await assert.rejects(
        provider.put(bad, Readable.from([Buffer.from('x')])),
        (error: unknown) => error instanceof ProviderError && error.kind === 'corrupt',
      );
    }
    assert.equal(calls.length, 0);
  });

  test('without custody every data call is kind=auth and authState says not-connected', async () => {
    const provider = new PCloudProvider({ auth: () => null, libraryId: 'lib1', fetchImpl: fetch });
    assert.equal(await provider.authState(), 'not-connected');
    await assert.rejects(provider.quota(), (error: unknown) => error instanceof ProviderError && error.kind === 'auth');
  });

  test('error mapping: token codes → auth, 2008 → quota, 2009 → not-found, network/HTTP-5xx → transient', async () => {
    const kinds = async (script: Script, run: (p: PCloudProvider) => Promise<unknown>) => {
      const { provider } = world(script);
      try {
        await run(provider);
        return null;
      } catch (error) {
        return error instanceof ProviderError ? error.kind : 'not-provider-error';
      }
    };
    assert.equal(await kinds({ userinfo: () => ({ result: 2094, error: 'Invalid access_token provided.' }) }, (p) => p.quota()), 'auth');
    assert.equal(
      await kinds({ createfolderifnotexists: () => ok(), uploadfile: () => ({ result: 2008, error: 'over quota' }) }, (p) =>
        p.put('blobs/ab/h1', Readable.from([Buffer.from('x')])),
      ),
      'quota',
    );
    assert.equal(
      await kinds({ getfilelink: () => ({ result: 2009, error: 'File not found.' }) }, (p) => p.getStream('blobs/ab/h1')),
      'not-found',
    );
    // 2002 = a component of the parent path does not exist — not-found, so
    // delete stays idempotent and reads surface honestly (Codex P2).
    assert.equal(
      await kinds({ getfilelink: () => ({ result: 2002, error: 'No parent directory.' }) }, (p) => p.getStream('blobs/ab/h1')),
      'not-found',
    );
    assert.equal(
      await kinds(
        {
          userinfo: () => {
            throw new Error('socket hang up');
          },
        },
        (p) => p.quota(),
      ),
      'transient',
    );
    assert.equal(await kinds({ userinfo: () => new Response(null, { status: 503 }) }, (p) => p.quota()), 'transient');
  });

  test('probe: uses checksumfile size and never fetches the download host', async () => {
    const { provider, calls } = world({
      checksumfile: () => ok({ metadata: { name: 'h1', isfolder: false, size: 12 } }),
    });
    assert.deepEqual(await provider.probe('blobs/ab/h1'), { bytes: 12 });
    assert.equal(
      calls.some((call) => call.method === 'getfilelink'),
      false,
    );
  });

  test('probe: missing checksumfile size is transient, not zero bytes', async () => {
    const { provider, calls } = world({
      checksumfile: () => ok({ metadata: { name: 'h1', isfolder: false } }),
    });
    await assert.rejects(provider.probe('blobs/ab/h1'), (error: unknown) => error instanceof ProviderError && error.kind === 'transient');
    assert.equal(
      calls.some((call) => call.method === 'getfilelink'),
      false,
    );
  });

  test('getStream: follows the download host and streams the bytes', async () => {
    const { provider } = world({ getfilelink: () => ok({ hosts: ['dl.pcloud.com'], path: '/x/h1.bin' }) }, { '/x/h1.bin': 'DATA' });
    assert.deepEqual(await buffer(await provider.getStream('blobs/ab/h1')), Buffer.from('DATA'));
  });

  test('list: flattens the recursive tree into provider-relative entries; missing prefix lists empty', async () => {
    const tree = {
      metadata: {
        name: 'blobs',
        isfolder: true,
        contents: [
          { name: 'ab', isfolder: true, contents: [{ name: 'h1', isfolder: false, size: 3 }] },
          { name: 'manifest.bin', isfolder: false, size: 5 },
        ],
      },
    };
    const { provider, calls } = world({ listfolder: () => ok(tree) });
    assert.deepEqual(await provider.list('blobs'), [
      { path: 'blobs/ab/h1', bytes: 3 },
      { path: 'blobs/manifest.bin', bytes: 5 },
    ]);
    assert.equal(calls[0]?.params.get('recursive'), '1');

    const empty = world({ listfolder: () => ({ result: 2005, error: 'Directory does not exist.' }) });
    assert.deepEqual(await empty.provider.list('blobs'), []);
  });

  test('delete: idempotent — deleting a missing entry resolves like the mock', async () => {
    const { provider } = world({ deletefile: () => ({ result: 2009, error: 'File not found.' }) });
    await provider.delete('blobs/ab/gone');
  });

  test('quota maps userinfo fields', async () => {
    const { provider } = world({ userinfo: () => ok({ usedquota: 380, quota: 500 }) });
    assert.deepEqual(await provider.quota(), { usedBytes: 380, totalBytes: 500 });
  });

  test('verify: uses the API sha256 when the region provides it', async () => {
    const { provider } = world({ checksumfile: () => ok({ sha256: 'abc123', metadata: { name: 'h1', isfolder: false, size: 9 } }) });
    assert.deepEqual(await provider.verify('blobs/ab/h1'), { sha256: 'abc123', bytes: 9 });
  });

  test('verify: US region (no sha256) falls back to download-and-hash — never skips', async () => {
    const { provider } = world(
      {
        checksumfile: () => ok({ sha1: 'ignored', metadata: { name: 'h1', isfolder: false, size: 4 } }),
        getfilelink: () => ok({ hosts: ['dl.pcloud.com'], path: '/x/h1.bin' }),
      },
      { '/x/h1.bin': 'DATA' },
    );
    assert.deepEqual(await provider.verify('blobs/ab/h1'), {
      sha256: createHash('sha256').update('DATA').digest('hex'),
      bytes: 4,
    });
  });

  test('#1438: large streams spill above spoolThresholdBytes with exact Content-Length, param-first wire order, and temp cleanup', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x5a);
    const { provider, calls } = world(
      {
        createfolderifnotexists: () => ok(),
        uploadfile: (_params, call) => ok({ metadata: [{ name: 'big.ovlk', isfolder: false, size: call.fileBytes?.length ?? 0 }] }),
      },
      {},
      4096,
    );
    assert.deepEqual(await provider.put('blobs/ab/big.ovlk', Readable.from([payload.subarray(0, 8192), payload.subarray(8192)])), {
      bytes: payload.length,
    });
    const upload = calls.find((call) => call.method === 'uploadfile');
    assert.ok(upload !== undefined);
    assert.equal(upload.entryOrder.at(-1), 'file');
    assert.ok(Number(upload.contentLength) > payload.length);
    assert.deepEqual(upload.fileBytes, payload);
  });

  test('#1438: closes the temporary spool writer before unlinking when an upload stream fails mid-spill', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith('overlook-pcloud-')));
    const { provider } = world({ createfolderifnotexists: () => ok() }, {}, 1024);
    async function* failingBytes(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(2048, 0x33);
      await Promise.resolve();
      throw new Error('source stream failed');
    }
    await assert.rejects(() => provider.put('blobs/ab/broken.ovlk', Readable.from(failingBytes())), ProviderError);
    const leaked = readdirSync(tmpdir()).filter((entry) => entry.startsWith('overlook-pcloud-') && !before.has(entry));
    assert.deepEqual(leaked, []);
  });
});
