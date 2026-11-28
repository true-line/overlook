import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { ProtectedBlobStore, ProtectedBlobStoreError } from '../../src/main/blobs/protected-blob-store.js';

async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function files(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('ProtectedBlobStore', () => {
  test('cancelling a protected decrypt stream closes its upstream file descriptor (#1217)', async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-protected-read-cancel-'));
    const store = new ProtectedBlobStore(dataDir);
    await store.init();
    const albumKey = randomBytes(32);
    const plaintext = Buffer.alloc(2 * 1024 * 1024);
    const contentHash = createHash('sha256').update(plaintext).digest('hex');
    const blobRef = await store.putOriginal({ albumId: 'album-a', albumKey, contentHash, plaintext: Readable.from(plaintext) });
    let reported = false;
    let entered: ((stream: ReadStream) => void) | undefined;
    let closed: (() => void) | undefined;
    const started = new Promise<ReadStream>((resolve) => {
      entered = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const read = Reflect.get<ReadStream, '_read'>(ReadStream.prototype, '_read');
    t.mock.method(ReadStream.prototype, '_read', function (this: ReadStream, size: number) {
      if (!reported && typeof this.path === 'string' && this.path.startsWith(dataDir)) {
        reported = true;
        this.once('close', () => closed?.());
        entered?.(this);
      }
      read.call(this, size);
    });
    const stream = store.getStream('album-a', blobRef, 'original', albumKey);
    const source = await started;
    stream.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        finished,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('decrypt cancellation left an upstream descriptor open')), 1_000);
        }),
      ]);
      assert.equal(source?.destroyed, true);
    } finally {
      clearTimeout(timer);
      source?.destroy();
      stream.destroy();
    }
  });

  test('stores originals and both derivatives outside ordinary consistency scans', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-protected-blobs-'));
    const ordinary = new BlobStore({ dataDir });
    const store = new ProtectedBlobStore(dataDir);
    await ordinary.init();
    await store.init();
    const albumKey = randomBytes(32);
    const original = Buffer.from('private original');
    const contentHash = createHash('sha256').update(original).digest('hex');
    const blobRef = await store.putOriginal({ albumId: 'album-a', albumKey, contentHash, plaintext: Readable.from(original) });
    await store.putDerivative({ albumId: 'album-a', albumKey, blobRef, kind: 'thumb', plaintext: Readable.from('small') });
    await store.putDerivative({ albumId: 'album-a', albumKey, blobRef, kind: 'mid', plaintext: Readable.from('medium') });

    assert.notEqual(blobRef, contentHash);
    assert.equal(await store.verify('album-a', blobRef, 'original', albumKey, contentHash), true);
    assert.equal((await bytes(store.getStream('album-a', blobRef, 'original', albumKey))).toString(), 'private original');
    assert.deepEqual(await ordinary.listOriginalHashes(), []);
    assert.deepEqual(await ordinary.listThumbHashes(), []);
    const protectedFiles = await files(join(dataDir, 'protected-blobs'));
    assert.equal(protectedFiles.length, 3);
    assert.ok(protectedFiles.every((path) => !path.includes(contentHash)));
  });

  test('same plaintext dedupes within one domain and is unlinkable across domains', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-protected-domains-'));
    const store = new ProtectedBlobStore(dataDir);
    await store.init();
    const plaintext = Buffer.from('same secret bytes');
    const contentHash = createHash('sha256').update(plaintext).digest('hex');
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const refA = await store.putOriginal({ albumId: 'album-a', albumKey: keyA, contentHash, plaintext: Readable.from(plaintext) });
    const repeated = await store.putOriginal({ albumId: 'album-a', albumKey: keyA, contentHash, plaintext: Readable.from(plaintext) });
    const refB = await store.putOriginal({ albumId: 'album-b', albumKey: keyB, contentHash, plaintext: Readable.from(plaintext) });
    assert.equal(repeated, refA);
    assert.notEqual(refB, refA);

    const encrypted = await files(join(dataDir, 'protected-blobs'));
    assert.equal(encrypted.length, 2);
    const [first, second] = await Promise.all(encrypted.map((path) => readFile(path)));
    assert.notDeepEqual(first, second);
  });

  test('refuses wrong plaintext and detects corrupted ciphertext before custody transfer', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-protected-corrupt-'));
    const store = new ProtectedBlobStore(dataDir);
    await store.init();
    const albumKey = randomBytes(32);
    const expected = createHash('sha256').update('expected').digest('hex');
    await assert.rejects(
      store.putOriginal({ albumId: 'album-a', albumKey, contentHash: expected, plaintext: Readable.from('wrong') }),
      ProtectedBlobStoreError,
    );

    const blobRef = await store.putOriginal({ albumId: 'album-a', albumKey, contentHash: expected, plaintext: Readable.from('expected') });
    const [path] = await files(join(dataDir, 'protected-blobs'));
    assert.ok(path !== undefined);
    const ciphertext = await readFile(path);
    ciphertext[ciphertext.length - 1] = (ciphertext.at(-1) ?? 0) ^ 1;
    await writeFile(path, ciphertext);
    assert.equal(await store.verify('album-a', blobRef, 'original', albumKey, expected), false);
  });
});
