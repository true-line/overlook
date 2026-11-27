import { KeyringRepository } from '../../src/main/db/keyring-repository.js';
import { photoKeySelection } from '../../src/main/db/photo-key-selection.js';
import { unavailableKeyIdsForPhoto, lockedDirtySnapshot } from '../../src/main/db/backup-key-availability.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { OriginalAvailabilityRepository } from '../../src/main/db/original-availability.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll, run } from '../../src/main/db/sql.js';
import { OriginalRecoveryService, type OriginalRecoveryOptions } from '../../src/main/library/original-recovery-service.js';

async function world(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'overlook-original-recovery-'));
  const db = openLibraryDatabase({ path: join(dir, 'library.db'), dbKey: randomBytes(32) });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-01-01')");
  const repo = new PhotosRepository(db);
  const bytes = randomBytes(2048);
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const id of ['root', 'sibling']) {
    repo.insert({
      id,
      fileName: `${id}.jpg`,
      fileKind: 'jpeg',
      width: 20,
      height: 10,
      bytes: bytes.length,
      contentHash: hash,
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
      importedAt: '2026-01-01',
      importSource: 'test',
      keyId: 1,
      assetOwnerId: id === 'root' ? null : 'root',
      derivativeKey: id === 'root' ? hash : createHash('sha256').update(id).digest('hex'),
    });
  }
  const availability = new OriginalAvailabilityRepository(db);
  availability.repair('root', 'error');
  availability.repair('sibling', 'error');
  run(db, "UPDATE sync_ledger SET coverage = 'excluded' WHERE photo_id = 'sibling'");
  const blobs = new BlobStore({ dataDir: dir });
  await blobs.init();
  const key = { id: 1, key: randomBytes(32) };
  const source = join(dir, 'source.jpg');
  await writeFile(source, bytes);
  const changed: string[][] = [];
  const options: OriginalRecoveryOptions = {
    getPhoto: (id) => repo.get(id),
    blobs,
    ready: Promise.resolve(),
    writeKey: () => ({ ...key, key: Buffer.from(key.key) }),
    resolveKey: (id) => (id === key.id ? key.key : undefined),
    restored: (value, keyId) => changed.push([...availability.recoveredLocal(value, keyId)]),
  };
  return { db, repo, bytes, hash, blobs, source, key, options, changed };
}

test('local recovery from a sibling restores the shared owner and both rows without re-including exclusions (#1101)', async (t) => {
  const w = await world(t);
  const service = new OriginalRecoveryService(w.options);
  assert.equal(await service.recover('sibling', w.source), 'recovered');
  assert.deepEqual(await buffer(w.blobs.getStream(w.hash, w.options.resolveKey, 'root')), w.bytes);
  assert.deepEqual(new Set(w.changed.flat()), new Set(['root', 'sibling']));
  for (const id of ['root', 'sibling']) {
    assert.equal(w.repo.get(id)?.originalFailure, null);
    assert.equal(w.repo.get(id)?.syncState, 'local');
  }
  assert.equal(w.repo.get('sibling')?.coverage, 'excluded');
});

test('wrong same-sized file leaves missing evidence and publishes no original (#1101)', async (t) => {
  const w = await world(t);
  await writeFile(w.source, randomBytes(w.bytes.length));
  assert.equal(await new OriginalRecoveryService(w.options).recover('root', w.source), 'failed');
  assert.equal(w.blobs.hasOriginal(w.hash), false);
  assert.equal(w.repo.get('root')?.originalFailure, 'missing-original');
  assert.deepEqual(w.changed, []);
});

test('excluded local-missing evidence alone admits exact-file recovery and clears without re-inclusion (#1135)', async (t) => {
  const w = await world(t);
  run(w.db, "UPDATE photos SET original_failure = NULL, local_custody_failure = 'local-missing' WHERE id = 'sibling'");
  assert.equal(await new OriginalRecoveryService(w.options).recover('sibling', w.source), 'recovered');
  assert.equal(w.repo.get('sibling')?.localCustodyFailure, null);
  assert.equal(w.repo.get('sibling')?.coverage, 'excluded');
  assert.equal(w.repo.pendingCount(), 1, 'only the included root is backup work');
});

test('recovery publishes with the active write key and commits the verified key ID to every sibling (#1101)', async (t) => {
  const w = await world(t);
  const active = { id: 2, key: randomBytes(32) };
  run(w.db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (2, 'test', '2026-01-02')");
  const resolveKey = (id: number) => (id === 2 ? active.key : w.options.resolveKey(id));
  const service = new OriginalRecoveryService({ ...w.options, resolveKey, writeKey: () => ({ ...active, key: Buffer.from(active.key) }) });
  assert.equal(await service.recover('sibling', w.source), 'recovered');
  assert.deepEqual(await buffer(w.blobs.getStream(w.hash, resolveKey, 'root')), w.bytes);
  assert.equal(w.repo.get('root')?.keyId, 2);
  assert.equal(w.repo.get('sibling')?.keyId, 2);
  assert.equal(w.repo.get('sibling')?.coverage, 'excluded');
  const keyring = new KeyringRepository(w.db);
  assert.equal(keyring.usage(1).photos, 2);
  assert.deepEqual(keyring.photoIds(1), ['root', 'sibling']);
  keyring.setPresent(1, false);
  assert.equal(w.repo.get('root')?.locked, true);
  assert.deepEqual(photoKeySelection(w.db, ['root', 'sibling']), { photoIds: [], locked: 2, missing: 0 });
  assert.deepEqual(unavailableKeyIdsForPhoto(w.db, 'root'), [1]);
  assert.deepEqual(lockedDirtySnapshot(w.db), { photoIds: ['root'], keyIds: [1] });
  keyring.setPresent(1, true);
  assert.equal(w.repo.get('root')?.locked, false);
});

test('failed ledger update rolls back evidence and can reconcile an already-published original on retry (#1101)', async (t) => {
  const w = await world(t);
  w.db.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE ON sync_ledger BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const service = new OriginalRecoveryService(w.options);
  assert.equal(await service.recover('root', w.source), 'failed');
  assert.equal(w.repo.get('root')?.originalFailure, 'missing-original');
  assert.deepEqual(w.changed, []);
  w.db.exec('DROP TRIGGER reject_recovery');
  assert.equal(await service.recover('root', w.source), 'recovered');
  assert.equal(w.repo.get('root')?.originalFailure, null);
});

test('existing envelope with wrong owner cannot count as recovery or be overwritten (#1101)', async (t) => {
  const w = await world(t);
  await w.blobs.putOriginal(Readable.from([w.bytes]), w.key, 'wrong-owner');
  const before = await buffer(w.blobs.getEncryptedStream(w.hash));
  assert.equal(await new OriginalRecoveryService(w.options).recover('root', w.source), 'failed');
  assert.deepEqual(await buffer(w.blobs.getEncryptedStream(w.hash)), before);
  assert.equal(w.repo.get('root')?.originalFailure, 'missing-original');
});

test('locked and trashed rows cannot recover (#1101)', async (t) => {
  const w = await world(t);
  run(w.db, 'UPDATE keys SET material_present = 0 WHERE id = 1');
  assert.equal(await new OriginalRecoveryService(w.options).recover('root', w.source), 'unavailable');
  run(w.db, 'UPDATE keys SET material_present = 1 WHERE id = 1');
  run(w.db, "UPDATE photos SET deleted_at = '2026-01-02' WHERE id = 'root'");
  assert.equal(await new OriginalRecoveryService(w.options).recover('root', w.source), 'unavailable');
  assert.equal(w.blobs.hasOriginal(w.hash), false);
});

test('key removal during streaming cannot corrupt the envelope or clear absence evidence (#1101)', async (t) => {
  const w = await world(t);
  const saved = Buffer.from(w.key.key);
  let sealedWith: Buffer | undefined;
  const service = new OriginalRecoveryService({
    ...w.options,
    blobs: {
      verifyOriginal: (...args) => w.blobs.verifyOriginal(...args),
      putOriginal: (source, key, owner, expected) => {
        sealedWith = key.key;
        source.once('data', () => {
          w.key.key.fill(0);
          run(w.db, 'UPDATE keys SET material_present = 0 WHERE id = 1');
        });
        return w.blobs.putOriginal(source, key, owner, expected);
      },
    },
  });
  assert.equal(await service.recover('root', w.source), 'cancelled');
  assert.deepEqual(await buffer(w.blobs.getStream(w.hash, () => saved, 'root')), w.bytes);
  assert.ok(sealedWith !== undefined);
  assert.deepEqual(sealedWith, Buffer.alloc(32));
  assert.equal(w.repo.get('root')?.originalFailure, 'missing-original');
  saved.fill(0);
});

test('close aborts in-flight verification without clearing evidence or admitting queued recovery (#1101)', { timeout: 2000 }, async (t) => {
  const w = await world(t);
  let started = (): void => {};
  const verifying = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = new OriginalRecoveryService({
    ...w.options,
    blobs: {
      putOriginal: (...args) => w.blobs.putOriginal(...args),
      verifyOriginal: (_hash, _resolveKey, _owner, signal) => {
        assert.ok(signal);
        return new Promise<boolean>((resolve) => {
          signal.addEventListener('abort', () => resolve(false), { once: true });
          started();
        });
      },
    },
  });
  const first = service.recover('root', w.source);
  const second = service.recover('sibling', w.source);
  await verifying;
  service.close();
  assert.equal(await first, 'cancelled');
  assert.equal(await second, 'cancelled');
  await service.drain();
  assert.deepEqual(w.changed, []);
  assert.equal(w.repo.get('root')?.originalFailure, 'missing-original');
});

test('retained recovery keys commit atomically, deduplicate, and follow photo purge (#1101)', async (t) => {
  const w = await world(t);
  run(w.db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (2, 'test', '2026-01-02')");
  const availability = new OriginalAvailabilityRepository(w.db);
  const references = () =>
    queryAll<{ photo_id: string; key_id: number }>(w.db, 'SELECT * FROM retained_photo_keys ORDER BY photo_id, key_id');
  w.db.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE ON sync_ledger BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => availability.recoveredLocal(w.hash, 2), /injected/u);
  assert.deepEqual(references(), []);
  assert.equal(w.repo.get('root')?.keyId, 1);
  assert.equal(w.repo.get('root')?.originalFailure, 'missing-original');
  w.db.exec('DROP TRIGGER reject_recovery');
  availability.recoveredLocal(w.hash, 2);
  availability.recoveredLocal(w.hash, 2);
  assert.deepEqual(references(), [
    { photo_id: 'root', key_id: 1 },
    { photo_id: 'sibling', key_id: 1 },
  ]);
  run(w.db, "DELETE FROM photos WHERE id = 'root'");
  assert.equal(new KeyringRepository(w.db).usage(1).photos, 1);
  run(w.db, "DELETE FROM photos WHERE id = 'sibling'");
  assert.deepEqual(references(), []);
  assert.equal(new KeyringRepository(w.db).usage(1).photos, 0);
});

for (const status of ['synced', 'offloaded', 'local'] as const) {
  test(`recovery preserves ${status} Trash sibling custody and manifest membership (#1101)`, async (t) => {
    const w = await world(t);
    const active = { id: 2, key: randomBytes(32) };
    run(w.db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (2, 'test', '2026-01-02')");
    run(w.db, "UPDATE photos SET deleted_at = '2026-01-02' WHERE id = 'sibling'");
    run(w.db, "UPDATE sync_ledger SET status = ?, coverage = 'included', dirty = 0 WHERE photo_id = 'sibling'", status);
    const before = w.repo.manifestSnapshot().photos.map((photo) => photo.id);
    const service = new OriginalRecoveryService({
      ...w.options,
      resolveKey: (id) => (id === active.id ? active.key : w.options.resolveKey(id)),
      writeKey: () => ({ ...active, key: Buffer.from(active.key) }),
    });
    assert.equal(await service.recover('root', w.source), 'recovered');
    assert.equal(w.repo.get('root')?.syncState, 'local');
    assert.equal(w.repo.get('sibling')?.syncState, status);
    assert.equal(w.repo.get('sibling')?.keyId, active.id);
    assert.equal(w.repo.get('sibling')?.originalFailure, null);
    const after = w.repo.manifestSnapshot().photos;
    assert.deepEqual(
      after.map((photo) => photo.id),
      before,
    );
    assert.equal(
      after.some((photo) => photo.id === 'sibling'),
      status !== 'local',
    );
    assert.equal(queryAll<{ dirty: number }>(w.db, "SELECT dirty FROM sync_ledger WHERE photo_id = 'sibling'")[0]?.dirty, 1);
  });
}
