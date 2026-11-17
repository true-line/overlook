import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPCloudConnect } from '../../src/main/backup/pcloud/connect.js';
import { PCloudTokenStore } from '../../src/main/backup/pcloud/token-store.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';

// #254 exit criteria: the whole handshake — listener, browser hop, capture,
// sealed custody, providerId flip — under a scripted "browser".

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(`sealed:${plainText}`, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8').slice('sealed:'.length),
};

// Each world gets its own temp dir; remove them so runs leave nothing behind.
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'overlook-pcloud-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

let nextPort = 42_100;

function world(browser: (authorizeUrl: string, port: number) => Promise<void>) {
  const port = nextPort;
  nextPort += 1;
  const tokenStore = new PCloudTokenStore({ safeStorage: fakeSafeStorage, dataDir: tempDir() });
  let connectedCalls = 0;
  const connect = createPCloudConnect({
    tokenStore,
    clientId: 'public-test-client',
    openExternal: (url) => browser(url, port),
    onConnected: () => {
      connectedCalls += 1;
      assert.notEqual(tokenStore.load(), null, 'providerId must not flip before custody exists');
    },
    port,
    timeoutMs: 5_000,
  });
  return { connect, tokenStore, connectedCalls: () => connectedCalls };
}

function stateOf(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get('state');
  assert.ok(state !== null && state.length >= 32, 'state nonce rides the authorize URL');
  return state;
}

describe('pCloud connect flow (#254)', () => {
  test('EXIT CRITERIA: handshake seals the token, then flips providerId', async () => {
    const { connect, tokenStore, connectedCalls } = world(async (url, port) => {
      await fetch(`http://127.0.0.1:${String(port)}/capture?access_token=tok-1&state=${stateOf(url)}&hostname=eapi.pcloud.com`);
    });
    assert.deepEqual(await connect(), { ok: true, reason: null });
    assert.equal(connectedCalls(), 1);
    const record = tokenStore.load();
    assert.equal(record?.accessToken, 'tok-1');
    assert.equal(record?.apiHost, 'eapi.pcloud.com');
  });

  test('denied authorization: no custody, no flip, redacted reason', async () => {
    const { connect, tokenStore, connectedCalls } = world(async (url, port) => {
      await fetch(`http://127.0.0.1:${String(port)}/capture?error=access_denied&state=${stateOf(url)}`);
    });
    const result = await connect();
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /access_denied/u);
    assert.equal(tokenStore.load(), null);
    assert.equal(connectedCalls(), 0);
  });

  test('one flow at a time; the port is reusable after a failure', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { connect } = world(async () => {
      // First "browser" stalls until released, then abandons the flow.
      await gate;
      throw new Error('browser never came back');
    });
    const first = connect();
    assert.deepEqual(await connect(), { ok: false, reason: 'A pCloud sign-in is already in progress — finish it in the browser.' });
    release?.();
    assert.equal((await first).ok, false);

    // The failed flow closed its listener — the fixed port is free again.
    assert.equal((await connect()).ok, false, 'flow runs (and fails in the fake browser) rather than EADDRINUSE');
  });
});
