import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { PurgeService, createPurgeRepository } from '../../src/main/library/purge-service.js';
import { ExportEngine } from '../../src/main/export/export-engine.js';
import { createConsistencyChecker } from '../../src/main/library/consistency-factory.js';
import { parseBackupManifest } from '../../src/main/backup/backup-manifest.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { BackupEngine, sidecarBackupDeps, type BackupEngineDeps } from '../../src/main/backup/backup-engine.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { createBackupClaimDeps } from '../../src/main/db/backup-claims.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { KeyringRepository } from '../../src/main/db/keyring-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { SidecarRepository } from '../../src/main/db/sidecar-repository.js';
import { run } from '../../src/main/db/sql.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// Sidecar objects in the backup round trip (#484, PR #849 review): companions
// ride the owning photo's upload, manifests list only snapshot photos'
// companions, and reconciliation re-uploads a locally held companion the
// selected provider is missing instead of owing a manifest forever.

const XMP = Buffer.from(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description dc:title="backup-test"/></rdf:RDF></x:xmpmeta>',
  'utf8',
);

function photoInsert(id: string, contentHash: string, bytes: number): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes,
    contentHash,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-29T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  };
}

async function world(separateSidecarKey = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-sidecar-backup-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (2, 'test', '2026-07-13T00:00:00.000Z')`);
  const keys = new KeyringRepository(db);
  const repo = new PhotosRepository(db);
  const sidecars = new SidecarRepository(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const companionKey: EnvelopeKey = separateSidecarKey ? { id: 2, key: randomBytes(32) } : key;
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-sidecar-remote-')) });
  const ledger = new SyncLedger(db);
  let clock = 0;
  const deps: BackupEngineDeps = {
    provider,
    ledger,
    dirtyPhotos: () => repo.dirtyPhotos(),
    encryptedStream: (hash) => store.getEncryptedStream(hash),
    sealManifest: (json) => Promise.resolve(Buffer.from(json)),
    sealRecoveryBootstrap: () => Buffer.from('recovery-bootstrap'),
    libraryId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    manifestSnapshot: () => repo.manifestSnapshot(),
    ...sidecarBackupDeps(db, store),
    settings: () => ({ throttlePercent: null, wifiOnly: false, autoBackupOnImport: false }),
    network: () => 'wifi',
    events: { progress: () => undefined },
    now: () => (clock += 40),
    sleep: () => Promise.resolve(),
    pendingCountChanged: () => undefined,
    pendingCount: () => repo.pendingCount(),
    syncStateChanged: () => undefined,
    audit: () => undefined,
    integrityScrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: false }),
    recoveryGenerationHealthy: () => Promise.resolve(true),
    ...createBackupClaimDeps(db, store),
  };

  async function addPhoto(id: string, seed: number, withSidecar: boolean): Promise<string | null> {
    const bytes = sampleJpeg(seed);
    const ref = await store.putOriginal(Readable.from([bytes]), key, id);
    repo.insert(photoInsert(id, ref.contentHash, ref.bytes));
    if (!withSidecar) return null;
    const sidecarRef = await store.putSidecar(Readable.from([XMP]), companionKey, id);
    sidecars.insert({
      photoId: id,
      role: 'xmp',
      fileName: `${id}.xmp`,
      contentHash: sidecarRef.contentHash,
      bytes: sidecarRef.bytes,
      keyId: companionKey.id,
      importedAt: '2026-07-29T00:00:00.000Z',
    });
    return sidecarRef.contentHash;
  }

  async function latestManifest(): Promise<{ sidecars: { photoId: string; blobPath: string }[]; photos: { id: string }[] }> {
    const generations = await provider.list('manifest');
    const newest = [...generations].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })).at(-1);
    assert.ok(newest, 'a manifest generation exists');
    const sealed = await buffer(await provider.getStream(newest.path));
    return JSON.parse(sealed.toString('utf8')) as { sidecars: { photoId: string; blobPath: string }[]; photos: { id: string }[] };
  }

  return { db, key, sidecars, keys, deps, repo, store, ledger, provider, addPhoto, latestManifest, engine: new BackupEngine(deps) };
}

describe('sidecar backup round trip (#484)', () => {
  test('an absent companion key locks counts, uploads, integrity selection and reconciliation (#1134)', async () => {
    const w = await world(true);
    const hash = await w.addPhoto('P0', 1, true);
    assert.ok(hash);
    w.keys.setPresent(2, false);
    assert.equal(w.repo.pendingCount(), 0);
    assert.equal(w.ledger.pendingCount(), 0);
    assert.equal((await w.engine.run()).uploaded, 0);
    assert.equal(w.ledger.isDirty('P0'), true);
    assert.equal((await w.provider.list('blobs')).length, 0);
    assert.equal((await w.provider.list('sidecars')).length, 0);
    w.keys.setPresent(2, true);
    assert.equal(w.repo.pendingCount(), 1);
    assert.equal((await w.engine.run()).uploaded, 1);
    w.ledger.markDirty('P0');
    w.keys.setPresent(2, false);
    assert.deepEqual(w.repo.integrityItems({ afterId: null, limit: 10 }), []);
    await w.provider.delete(`sidecars/P0/${hash}`);
    const audits: string[] = [];
    const reconciler = new BackupEngine({ ...w.deps, audit: (line) => audits.push(line) });
    reconciler.oweManifest();
    const blocked = await reconciler.run();
    assert.equal(blocked.failed, 0);
    assert.equal(blocked.uploaded, 0);
    assert.equal(blocked.manifestUploaded, false);
    assert.deepEqual(
      audits.filter((line) => line.startsWith('BACKUP-SKIP-LOCKED')),
      ['BACKUP-SKIP-LOCKED skips=1 key=2'],
    );
    assert.equal((await w.provider.list('sidecars')).length, 0);
    assert.equal(w.ledger.isDirty('P0'), true);
    w.keys.setPresent(2, true);
    const resumed = await reconciler.run();
    assert.equal(resumed.manifestUploaded, true);
    assert.equal(w.ledger.isDirty('P0'), false);
  });

  test('removal during original put or verification preserves dirty work and skips companions (#1134)', async () => {
    for (const removedKeyId of [1, 2]) {
      for (const phase of ['put', 'verify']) {
        const w = await world(true);
        await w.addPhoto('P0', 1, true);
        const put = w.provider.put.bind(w.provider);
        const verify = w.provider.verify.bind(w.provider);
        w.provider.put = async (path, stream) => {
          const result = await put(path, stream);
          if (phase === 'put' && path.startsWith('blobs/')) w.keys.setPresent(removedKeyId, false);
          return result;
        };
        w.provider.verify = async (path) => {
          const result = await verify(path);
          if (phase === 'verify' && path.startsWith('blobs/')) w.keys.setPresent(removedKeyId, false);
          return result;
        };
        const skipped = await w.engine.run();
        assert.equal(skipped.uploaded, 0);
        assert.equal(skipped.failed, 0);
        assert.equal(w.ledger.status('P0'), 'local');
        assert.equal(w.ledger.isDirty('P0'), true);
        assert.equal(w.repo.pendingCount(), 0);
        assert.equal((await w.provider.list('sidecars')).length, 0);
        w.provider.put = put;
        w.provider.verify = verify;
        w.keys.setPresent(removedKeyId, true);
        assert.equal(w.repo.pendingCount(), 1);
        assert.equal((await w.engine.run()).uploaded, 1);
        assert.equal(w.ledger.isDirty('P0'), false);
      }
    }
  });

  test('ACCEPTANCE: the companion uploads with its photo and lands in the schema-6 manifest; a deleted-unbacked photo stays out', async () => {
    const w = await world();
    const hash = await w.addPhoto('P0', 1, true);
    // Imported-with-sidecar then soft-deleted BEFORE any backup: its rows
    // must not poison the manifest (PR #849 review).
    await w.addPhoto('P1', 2, true);
    w.repo.softDelete(['P1']);

    const result = await w.engine.run();
    assert.deepEqual(
      { uploaded: result.uploaded, failed: result.failed, blocked: result.blockedRemoteOnly },
      { uploaded: 1, failed: 0, blocked: 0 },
    );
    assert.equal(result.manifestUploaded, true);

    const remote = await w.provider.list('sidecars');
    assert.deepEqual(
      remote.map((entry) => entry.path),
      [`sidecars/P0/${hash ?? ''}`],
      'only the recoverable photo uploads its companion',
    );
    const manifest = await w.latestManifest();
    assert.deepEqual(
      manifest.sidecars.map((sidecar) => sidecar.photoId),
      ['P0'],
    );
  });

  test('ADR-0033 §4 (PR #1124 review): an excluded photo keeps its record but its companion leaves the manifest', async () => {
    const w = await world();
    const hash = await w.addPhoto('P0', 1, true);
    await w.addPhoto('P1', 2, true);
    assert.equal((await w.engine.run()).manifestUploaded, true);
    assert.deepEqual((await w.latestManifest()).sidecars.map((sidecar) => sidecar.photoId).sort(), ['P0', 'P1']);

    // The coverage ceremony records the exclusion and owes a generation;
    // the generation that lands must not reference the companion the
    // settlement is about to delete.
    w.ledger.markExcluding('P0', 'user', '2026-09-02T04:00:00.000Z');
    w.engine.oweManifest();
    assert.equal((await w.engine.run()).manifestUploaded, true);
    const manifest = await w.latestManifest();
    assert.deepEqual(
      manifest.photos.map((photo) => photo.id).sort(),
      ['P0', 'P1'],
      'the excluded record is still carried for its metadata',
    );
    assert.deepEqual(
      manifest.sidecars.map((sidecar) => sidecar.photoId),
      ['P1'],
      `sidecars/P0/${hash ?? ''} is not promised by the recording generation`,
    );
  });

  test("REGRESSION (PR #849): a provider missing a clean photo's companion re-uploads it during reconciliation", async () => {
    const w = await world();
    const hash = await w.addPhoto('P0', 1, true);
    assert.equal((await w.engine.run()).manifestUploaded, true);

    // The remote loses the companion while the photo stays clean synced —
    // nothing dirties the ledger, so only the publication preflight's
    // reconciliation can repair it. A FRESH engine models the relaunch or
    // provider reselect that surfaces the loss (the in-process presence
    // cache is the integrity scrubber's territory, not this path's).
    await w.provider.delete(`sidecars/P0/${hash ?? ''}`);
    w.deps.manifestDebt?.save(true);

    const again = await new BackupEngine(w.deps).run();
    assert.equal(again.manifestUploaded, true, 'the owed generation publishes after the sidecar re-upload');
    assert.equal(again.blockedRemoteOnly, 0);
    const remote = await w.provider.list('sidecars');
    assert.deepEqual(
      remote.map((entry) => entry.path),
      [`sidecars/P0/${hash ?? ''}`],
    );
  });
});

test('shared companions survive root purge, export byte-exactly, and remain in backup (#1120)', async () => {
  const w = await world();
  const hash = await w.addPhoto('root', 1, true);
  assert.ok(hash);
  const root = w.repo.get('root');
  assert.ok(root);
  new VariantRepository(w.db).duplicate(root, 'variant', '2026-09-21T00:00:00.000Z');
  assert.equal((await w.engine.run()).manifestUploaded, true);
  assert.equal((await w.provider.list('sidecars')).length, 1, 'one physical object, multiple references');
  const shared = await w.latestManifest();
  assert.throws(
    () => parseBackupManifest({ ...shared, sidecars: shared.sidecars.map((entry) => ({ ...entry, ownerId: '../root' })) }),
    /invalid schema-16/u,
  );
  assert.throws(
    () =>
      parseBackupManifest({
        ...shared,
        sidecars: shared.sidecars.map((entry, index) =>
          index === 0 ? entry : { ...entry, ciphertext: { sha256: 'f'.repeat(64), bytes: 999 } },
        ),
      }),
    /shared companion references disagree/u,
  );

  const purge = new PurgeService({
    repo: createPurgeRepository(w.repo, w.sidecars),
    blobs: w.store,
    remoteProvider: () => Promise.resolve(w.provider),
    custodyChanged: () => undefined,
    oweManifest: () => w.engine.oweManifest(),
    libraryChanged: () => undefined,
    audit: () => undefined,
    retention: () => '30',
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
  });
  w.repo.softDelete(['root']);
  assert.equal((await purge.purge(['root'])).purged, 1);
  assert.equal(await w.store.verifySidecar('root', hash, () => w.key.key), true);
  const written = new Map<string, Buffer>();
  const exporter = new ExportEngine({
    repo: w.repo,
    blobs: w.store,
    resolveKey: () => w.key.key,
    sidecarsFor: (id) => w.sidecars.listForPhoto(id),
    sidecarStream: (id, contentHash) => w.store.getSidecarStream(id, contentHash, () => w.key.key),
    writeFile: async (path, stream) => {
      written.set(path, await buffer(stream));
    },
    exists: () => Promise.resolve(false),
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    joinPath: join,
    transcodeJpeg: () => Promise.reject(new Error('unused')),
    bufferStream: buffer,
    events: { progress: () => undefined },
  });
  const exported = await exporter.exportPhotos(['variant'], '/export');
  assert.equal(exported.sidecarsExported, 1);
  assert.deepEqual(written.get(join('/export', 'root.xmp')), XMP);
  const listEntries = w.store.listSidecarEntries.bind(w.store);
  w.store.listSidecarEntries = async () => (await listEntries()).map((entry) => ({ ...entry, ageMs: 86_400_000 }));
  const checker = createConsistencyChecker({
    db: w.db,
    repo: w.repo,
    blobStore: w.store,
    provider: w.provider,
    libraryChanged: () => undefined,
    audit: () => undefined,
  });
  assert.deepEqual((await checker.scan()).orphanSidecars, []);
  assert.equal((await w.engine.run()).manifestUploaded, true);
  const manifest = await w.latestManifest();
  assert.deepEqual(
    manifest.photos.map((photo) => photo.id),
    ['variant'],
  );
  assert.equal(manifest.sidecars[0]?.blobPath, `sidecars/root/${hash}`);
  assert.equal(parseBackupManifest(manifest).restorable, true);
  w.repo.softDelete(['variant']);
  assert.equal((await purge.purge(['variant'])).purged, 1);
  assert.equal(w.store.hasSidecar('root', hash), false);
  assert.equal((await w.provider.list('sidecars')).length, 0);
  w.db.close();
});
