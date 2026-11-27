import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { BackupIntegrityCursorStore } from '../../src/main/backup/integrity-cursor.js';
import { createLocalCustodyRuntime } from '../../src/main/backup/local-custody-runtime.js';
import {
  LOCAL_CUSTODY_HASH_INTERVAL_MS,
  LocalCustodyScrubber,
  type LocalCustodyScrubberDeps,
} from '../../src/main/backup/local-custody-scrubber.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { LocalCustodyRepository } from '../../src/main/db/local-custody-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

async function world(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'overlook-local-integrity-'));
  const db = openLibraryDatabase({ path: join(dir, 'library.db'), dbKey: randomBytes(32) });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-11-27')");
  const photos = new PhotosRepository(db);
  const ledger = new SyncLedger(db);
  const repo = new LocalCustodyRepository(db);
  const blobs = new BlobStore({ dataDir: dir });
  await blobs.init();
  const key = { id: 1, key: randomBytes(32) };
  const cursor = new BackupIntegrityCursorStore(db, 'local-custody');
  const changed: string[][] = [];
  const audits: string[] = [];
  let now = new Date('2026-11-27T00:00:00Z');
  const add = async (id: string, plaintext = randomBytes(100)) => {
    const blob = await blobs.putOriginal(Readable.from([plaintext]), key, id);
    photos.insert({
      id,
      fileName: `${id}.jpg`,
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes: plaintext.length,
      contentHash: blob.contentHash,
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
      importedAt: now.toISOString(),
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
    ledger.markExcluding(id, 'user', now.toISOString());
    ledger.markExcluded(id);
    return {
      hash: blob.contentHash,
      plaintext,
      path: join(dir, 'blobs', blob.contentHash.slice(0, 2), blob.contentHash.slice(2, 4), blob.contentHash),
    };
  };
  const deps: LocalCustodyScrubberDeps = {
    repo,
    cursor,
    inspect: (hash) => blobs.inspectOriginal(hash),
    encryptedStream: (hash) => blobs.getEncryptedStream(hash),
    resolveKey: (id) => (id === 1 ? key.key : undefined),
    changed: (ids) => changed.push([...ids]),
    audit: (line) => audits.push(line),
    now: () => now,
  };
  const scrub = (overrides: Partial<LocalCustodyScrubberDeps> = {}, signal?: AbortSignal) =>
    new LocalCustodyScrubber({ ...deps, ...overrides }).scrub(signal);
  const policy = (id: string) => queryGet(db, 'SELECT * FROM sync_ledger WHERE photo_id = ?', id);
  return {
    dir,
    db,
    photos,
    ledger,
    repo,
    blobs,
    key,
    cursor,
    changed,
    audits,
    deps,
    add,
    scrub,
    policy,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

test('healthy excluded originals authenticate locally without entering remote scrub or changing backup policy (#1135)', async (t) => {
  const w = await world(t);
  await w.add('A');
  const before = w.policy('A');
  assert.deepEqual(w.photos.integrityItems({ afterId: null, limit: 10 }), [], 'no remote-presence claim');
  assert.equal((await w.scrub()).hashed, 1);
  assert.equal(w.photos.get('A')?.localCustodyFailure, null);
  assert.deepEqual(w.policy('A'), before);
  assert.equal(w.photos.stats().localMissingCount, 0);
  assert.equal((await w.scrub()).hashed, 0, 'unchanged header/stat is not rehashed every minute');
  w.advance(LOCAL_CUSTODY_HASH_INTERVAL_MS);
  assert.equal((await w.scrub()).hashed, 1, 'a full authenticated hash is repeated on the daily cadence');
});

test('missing excluded originals persist honest loss and recover on a verified recheck, without re-including (#1135)', async (t) => {
  const w = await world(t);
  const original = await w.add('A');
  const ciphertext = await readFile(original.path);
  const before = w.policy('A');
  await rm(original.path);
  assert.equal((await w.scrub()).missing, 1);
  assert.equal(w.photos.get('A')?.localCustodyFailure, 'local-missing');
  assert.equal(w.photos.stats().localMissingCount, 1);
  assert.equal(w.photos.stats().localMissingBytes, original.plaintext.length);
  assert.equal(w.photos.stats().excludedCount, 1, 'the exclusion is still durable policy');
  assert.equal(w.photos.counts('2026-01-01').unavailable, 1);
  assert.deepEqual(w.policy('A'), before);
  await writeFile(original.path, ciphertext);
  assert.equal((await w.scrub()).hashed, 1);
  assert.equal(w.photos.get('A')?.localCustodyFailure, null);
  assert.equal(w.photos.stats().localMissingCount, 0);
  assert.equal(w.photos.stats().localMissingBytes, 0);
  assert.equal(w.photos.counts('2026-01-01').unavailable, 0);
  assert.deepEqual(w.policy('A'), before);
  assert.deepEqual(w.changed, [['A'], ['A']]);
});

test('malformed headers, truncation, authentication damage, wrong AAD and wrong content all fail local verification (#1135)', async (t) => {
  for (const damage of ['header', 'truncated-header', 'truncated-final', 'tag', 'wrong-owner', 'wrong-hash'] as const) {
    await t.test(damage, async (st) => {
      const w = await world(st);
      const original = await w.add('A');
      const saved = await readFile(original.path);
      let damaged = Buffer.from(saved);
      if (damage === 'header') damaged[0] = 0;
      if (damage === 'truncated-header') damaged = damaged.subarray(0, 8);
      if (damage === 'truncated-final') damaged = damaged.subarray(0, damaged.length - 1);
      if (damage === 'tag') damaged[26] = (damaged[26] ?? 0) ^ 1;
      if (damage === 'wrong-owner') run(w.db, "UPDATE photos SET asset_owner_id = 'wrong' WHERE id = 'A'");
      if (damage === 'wrong-hash') {
        const other = await w.blobs.putOriginal(Readable.from([Buffer.alloc(original.plaintext.length)]), w.key, 'A');
        damaged = await readFile(join(w.dir, 'blobs', other.contentHash.slice(0, 2), other.contentHash.slice(2, 4), other.contentHash));
      }
      await writeFile(original.path, damaged);
      const before = w.policy('A');
      assert.equal((await w.scrub()).corrupt, 1);
      assert.equal(w.photos.get('A')?.localCustodyFailure, 'local-corrupt');
      assert.equal(w.photos.stats().localCorruptCount, 1);
      assert.equal(w.photos.stats().localMissingCount, 0);
      assert.deepEqual(w.policy('A'), before);
      assert.deepEqual(await readFile(original.path), damaged, 'scrub never deletes or repairs source bytes');
    });
  }
});

test('changed bytes force authentication before the daily deadline and a good header cannot clear corruption (#1135)', async (t) => {
  const w = await world(t);
  const original = await w.add('A');
  const saved = await readFile(original.path);
  await w.scrub();
  const damaged = Buffer.from(saved);
  damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
  await writeFile(original.path, damaged);
  assert.equal((await w.scrub()).corrupt, 1);
  assert.equal((await w.scrub()).hashed, 1, 'known corruption is fully rechecked, never cleared by a readable header');
  assert.equal(w.photos.get('A')?.localCustodyFailure, 'local-corrupt');
  await writeFile(original.path, saved);
  await w.scrub();
  assert.equal(w.photos.get('A')?.localCustodyFailure, null);
});

test('local pages, persisted cursor and soft byte budget make bounded progress including oversized originals (#1135)', async (t) => {
  const w = await world(t);
  for (const id of ['A', 'B', 'C']) await w.add(id);
  assert.equal((await w.scrub({ batchSize: 2, byteBudget: 1 })).hashed, 1, 'one oversized original may finish');
  assert.equal((await w.cursor.load()).afterId, 'A');
  assert.equal((await w.scrub({ byteBudget: 1 })).hashed, 1);
  assert.equal((await w.cursor.load()).afterId, 'B', 'the deferred original becomes first next time');
  assert.equal((await w.scrub({ byteBudget: 1 })).hashed, 1);
  assert.equal((await w.cursor.load()).afterId, null);
  assert.equal((await w.cursor.load()).completedAt, '2026-11-27T00:00:00.000Z');
});

test('excluded shared variants use the original owner and missing-byte statistics count the asset once (#1135)', async (t) => {
  const w = await world(t);
  const original = await w.add('A');
  const root = w.photos.get('A');
  assert.ok(root);
  new VariantRepository(w.db).duplicate(root, 'B', '2026-11-27');
  run(w.db, "UPDATE sync_ledger SET coverage = 'excluded', dirty = 0 WHERE photo_id = 'B'");
  assert.equal((await w.scrub()).hashed, 1, 'one authentication is reused only for the same hash, owner and file identity');
  await rm(original.path);
  await w.scrub();
  assert.equal(w.photos.stats().localMissingCount, 2);
  assert.equal(w.photos.stats().localMissingBytes, original.plaintext.length);
});

test('included rows, absent keys and restored placeholders never become excluded local-loss findings (#1135)', async (t) => {
  const w = await world(t);
  for (const id of ['included', 'locked', 'placeholder']) {
    const original = await w.add(id);
    await rm(original.path);
  }
  w.ledger.markIncluded('included', '2026-11-27');
  run(w.db, "UPDATE photos SET restored_exclusion_at = '2026-11-26', original_failure = 'missing-original' WHERE id = 'placeholder'");
  run(w.db, "INSERT INTO keys (id, wrapped_key, created_at, material_present) VALUES (2, 'absent', '2026-11-27', 0)");
  run(w.db, "UPDATE photos SET key_id = 2 WHERE id = 'locked'");
  assert.deepEqual(w.repo.items({ afterId: null, limit: 10 }), []);
  assert.equal((await w.scrub()).checked, 0);
  assert.equal(w.photos.get('placeholder')?.originalFailure, 'missing-original');
  assert.deepEqual(w.changed, []);
});

test('cancellation and key revocation destroy active streams without committing corrupt or healthy evidence (#1135)', async (t) => {
  for (const revoke of [false, true])
    await t.test(revoke ? 'key revoked' : 'library closed', async (st) => {
      const w = await world(st);
      const original = await w.add('A');
      const controller = new AbortController();
      const bytes = await readFile(original.path);
      const stream = Readable.from(
        (async function* () {
          yield bytes.subarray(0, 18);
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (revoke) run(w.db, 'UPDATE keys SET material_present = 0 WHERE id = 1');
          else controller.abort();
          yield bytes.subarray(18);
        })(),
      );
      await w.scrub({ encryptedStream: () => stream }, controller.signal);
      assert.equal(stream.destroyed, true);
      assert.equal(w.photos.get('A')?.localCustodyFailure, null);
      assert.deepEqual(w.changed, []);
      assert.equal((await w.cursor.load()).completedAt, revoke ? '2026-11-27T00:00:00.000Z' : null);
    });
});

test('coverage changes, file replacement and IO failures cannot commit stale verification (#1135)', async (t) => {
  const w = await world(t);
  await w.add('A');
  const inspect = w.deps.inspect;
  let observations = 0;
  await w.scrub({
    inspect: async (hash) => {
      const result = await inspect(hash);
      observations += 1;
      if (observations === 2) w.ledger.markIncluded('A', '2026-11-27');
      return result;
    },
  });
  assert.deepEqual(w.changed, []);
  assert.equal(w.photos.get('A')?.localCustodyFailure, null);
  assert.equal(w.ledger.coverage('A')?.coverage, 'included');
  run(w.db, "UPDATE sync_ledger SET coverage = 'excluded' WHERE photo_id = 'A'");
  await w.scrub({ inspect: () => Promise.reject(Object.assign(new Error('unreadable'), { code: 'EACCES' })) });
  assert.equal(w.photos.get('A')?.localCustodyFailure, null);
  observations = 0;
  await w.scrub({ inspect: async (hash) => ({ ...(await inspect(hash)), fingerprint: String(++observations) }) });
  assert.equal(w.repo.items({ afterId: null, limit: 10 })[0]?.verifiedAt, null);
  assert.deepEqual(w.changed, []);
});

test('provider-independent runtime joins concurrent checks and aborts/drains before keys or database close (#1135)', async (t) => {
  const w = await world(t);
  await w.add('A');
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stream = new Readable({
    read() {
      started();
    },
  });
  const runtime = createLocalCustodyRuntime(
    {
      db: w.db,
      blobStore: { inspectOriginal: w.deps.inspect, getEncryptedStream: () => stream },
      blobStoreReady: Promise.resolve(),
      keyStore: { resolver: () => w.deps.resolveKey },
    },
    (ids) => w.changed.push([...ids]),
    (line) => w.audits.push(line),
  );
  const first = runtime.scrub();
  assert.equal(runtime.scrub(), first, 'manual and scheduled triggers share one pass');
  await reading;
  await runtime.close();
  await first;
  assert.equal(stream.destroyed, true);
  assert.deepEqual(w.changed, []);
  assert.equal(await runtime.scrub(), undefined, 'closed library refuses new work');
  assert.equal((await w.cursor.load()).afterId, null);
});

test('protected migration hides excluded rows and stale local findings cannot cross that boundary (#1135)', async (t) => {
  const w = await world(t);
  const original = await w.add('A');
  const item = w.repo.items({ afterId: null, limit: 1 })[0];
  assert.ok(item);
  // Same ordinary-view boundary as production protect preparation. The source
  // row remains on disk until its protected transaction completes.
  run(
    w.db,
    `INSERT INTO protected_album_records
    (album_id, record_version, migration_state, credential_generation, metadata_generation, credential_record, sealed_metadata, created_at, updated_at)
    VALUES ('protected', 1, 'active', 1, 1, X'00', X'00', '2026-11-27', '2026-11-27')`,
  );
  run(
    w.db,
    `INSERT INTO protected_photo_migrations
    (migration_id, operation, target_album_id, phase, created_at, updated_at)
    VALUES ('move', 'protect', 'protected', 'prepare', '2026-11-27', '2026-11-27')`,
  );
  run(
    w.db,
    `INSERT INTO protected_photo_migration_items
    (migration_id, photo_id, source_blob_ref, target_blob_ref, sealed_target_metadata, has_thumb, has_mid, item_phase)
    VALUES ('move', 'A', ?, 'opaque', X'00', 0, 0, 'prepare')`,
    original.hash,
  );
  assert.deepEqual(w.repo.items({ afterId: null, limit: 10 }), []);
  assert.deepEqual(w.repo.record(item, 'local-missing'), []);
  assert.equal(w.photos.stats().localMissingCount, 0);
});

test('local-custody evidence survives restart but never enters the backup manifest (#1135)', async (t) => {
  const w = await world(t);
  const original = await w.add('A');
  await rm(original.path);
  await w.scrub();
  assert.equal(new PhotosRepository(w.db).get('A')?.localCustodyFailure, 'local-missing');
  const snapshot = w.photos.manifestSnapshot();
  assert.equal(snapshot.photos.length, 1);
  assert.equal('localCustodyFailure' in (snapshot.photos[0] ?? {}), false);
  assert.equal('local_custody_fingerprint' in (snapshot.photos[0] ?? {}), false);
  const photo = snapshot.photos[0];
  assert.ok(photo !== undefined && 'coverage' in photo);
  assert.equal(photo.coverage, 'excluded');
});

test('a growing input is bounded by the observed size and destroys the stream (#1135)', { timeout: 2000 }, async (t) => {
  const w = await world(t);
  const original = await w.add('A');
  const bytes = await readFile(original.path);
  let produced = 0;
  const stream = Readable.from(
    (function* () {
      yield bytes;
      while (true) {
        produced += 1;
        yield Buffer.alloc(1024);
      }
    })(),
  );
  await w.scrub({ encryptedStream: () => stream });
  assert.equal(stream.destroyed, true);
  assert.ok(produced < 1000, 'verification must stop a growing input, not read indefinitely');
  assert.equal(w.photos.get('A')?.localCustodyFailure, 'local-corrupt');
});

test('an excluded variant retains the import-owner AAD after that owner row is purged (#1135)', async (t) => {
  const w = await world(t);
  await w.add('A');
  const root = w.photos.get('A');
  assert.ok(root);
  new VariantRepository(w.db).duplicate(root, 'B', '2026-11-27');
  run(w.db, "UPDATE sync_ledger SET coverage = 'excluded', dirty = 0 WHERE photo_id = 'B'");
  run(w.db, "DELETE FROM photos WHERE id = 'A'");
  assert.equal((await w.scrub()).hashed, 1);
  assert.equal(w.photos.get('B')?.localCustodyFailure, null);
  assert.equal(w.photos.get('B')?.assetOwnerId, 'A');
});
