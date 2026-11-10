import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotoMetadataRepository } from '../../src/main/db/photo-metadata-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { readSmartAlbums, smartAlbumCount, smartAlbumCounts } from '../../src/main/db/smart-album-queries.js';
import { createSmartAlbum } from '../../src/main/db/smart-album-repository.js';
import { queryAll, run } from '../../src/main/db/sql.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { DisclosureRepository } from '../../src/main/disclosure/disclosure-repository.js';
import type { SmartPredicate } from '../../src/shared/library/smart-album.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function createWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'overlook-1439-db-'));
  tempDirs.push(dir);
  const db = openLibraryDatabase({
    path: join(dir, 'library.db'),
    dbKey: randomBytes(32),
  });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  const insert = (id: string, overrides: Partial<Pick<PhotoInsert, 'bytes' | 'contentHash' | 'fileKind' | 'camera'>> = {}): void => {
    photos.insert({
      id,
      fileName: `${id}.JPG`,
      fileKind: overrides.fileKind ?? 'jpeg',
      width: 4000,
      height: 3000,
      bytes: overrides.bytes ?? 1024,
      contentHash: overrides.contentHash ?? id.repeat(64).slice(0, 64),
      camera: overrides.camera ?? 'Leica Q2',
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: null,
      gpsLon: null,
      place: null,
      importedAt: '2026-07-13T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    });
  };
  return {
    db,
    photos,
    ledger: new SyncLedger(db),
    metadata: new PhotoMetadataRepository(db),
    disclosure: new DisclosureRepository(db),
    variants: new VariantRepository(db),
    insert,
  };
}

describe('SQLite chunking, album_photos index, smart-album batch counts, and stats dedup (#1439)', () => {
  test('PhotoMetadataRepository.rows and DisclosureRepository.overridesFor chunk >35,000 IDs safely', () => {
    const w = createWorld();
    w.insert('P-FIRST');
    w.insert('P-LAST');
    w.metadata.update({ photoIds: ['P-FIRST'], title: 'Alpha', addTags: [' dawn '] });
    w.metadata.update({ photoIds: ['P-LAST'], title: 'Alpha', addTags: ['dawn', 'dusk'] });

    w.disclosure.setOverride('photo', 'P-FIRST', 'location', 'private', false);
    w.disclosure.setOverride('photo', 'P-FIRST', 'camera', 'shared', true);
    w.disclosure.setOverride('photo', 'P-LAST', 'captureTime', 'public', true);

    const ids: string[] = ['P-FIRST'];
    for (let i = 0; i < 35_005; i += 1) {
      ids.push(`SYNTH-${String(i)}`);
    }
    ids.push('P-LAST', 'P-FIRST');

    const summary = w.metadata.summary(ids);
    assert.equal(summary.found, 2);
    assert.equal(summary.missing, 35_005);
    assert.deepEqual(summary.title, { mixed: false, value: 'Alpha' });
    assert.deepEqual(summary.commonTags, ['dawn']);
    assert.deepEqual(summary.varyingTags, ['dusk']);

    const overrides = w.disclosure.overridesFor('photo', ids);
    assert.equal(overrides.size, 2);
    assert.deepEqual(overrides.get('P-FIRST'), [
      { field: 'camera', class: 'shared', widened: true },
      { field: 'location', class: 'private', widened: false },
    ]);
    assert.deepEqual(overrides.get('P-LAST'), [{ field: 'captureTime', class: 'public', widened: true }]);
    dbClose(w.db);
  });

  test('migration 48 creates idx_album_photos_photo and serves WHERE photo_id = ? via index', () => {
    const w = createWorld();
    assert.equal(MIGRATIONS.find((migration) => migration.version === 48)?.name, 'album-photos-photo-index');
    const indexes = queryAll<{ name: string }>(w.db, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'album_photos'`);
    assert.ok(indexes.some((row) => row.name === 'idx_album_photos_photo'));

    const plan = queryAll<{ detail: string }>(w.db, `EXPLAIN QUERY PLAN SELECT album_id FROM album_photos WHERE photo_id = @photoId`, {
      photoId: 'P-ANY',
    });
    assert.ok(
      plan.some((row) => row.detail.includes('idx_album_photos_photo')),
      `expected idx_album_photos_photo in query plan, got: ${JSON.stringify(plan)}`,
    );
    dbClose(w.db);
  });

  test('PhotosRepository.stats deduplicates shared content_hash for offloadedBytes and excludedBytes', () => {
    const w = createWorld();
    const empty = w.photos.stats();
    assert.equal(empty.photos, 0);
    assert.equal(empty.bytes, 0);
    assert.equal(empty.offloadedBytes, 0);
    assert.equal(empty.excludedBytes, 0);

    const sharedHash = 'a'.repeat(64);
    w.insert('P1', { bytes: 5000, contentHash: sharedHash });
    const p1 = w.photos.get('P1');
    assert.ok(p1);
    w.variants.duplicate(p1, 'P2', '2026-09-02T00:00:00.000Z');
    w.insert('P3', { bytes: 3000, contentHash: 'b'.repeat(64) });

    for (const id of ['P1', 'P2', 'P3']) {
      w.ledger.setStatus(id, 'syncing');
      w.ledger.markBackedUp(id, '2026-09-02T01:00:00.000Z');
    }

    // Only one variant is offloaded while its sibling remains local on disk:
    // the shared 5000-byte original is still on local disk.
    w.ledger.repairStatus('P1', 'offloaded');
    let stats = w.photos.stats();
    assert.equal(stats.photos, 3);
    assert.equal(stats.bytes, 8000);
    assert.equal(stats.offloadedBytes, 0);

    // Once all live variants sharing the asset are offloaded, offloadedBytes counts 5000 once (never 10000).
    w.ledger.repairStatus('P2', 'offloaded');
    stats = w.photos.stats();
    assert.equal(stats.bytes, 8000);
    assert.equal(stats.offloadedBytes, 5000);
    assert.ok(stats.bytes - stats.offloadedBytes >= 0);

    // Restore local status and verify shared-asset exclusion byte deduplication.
    run(w.db, `UPDATE sync_ledger SET status = 'synced' WHERE photo_id IN ('P1', 'P2')`);
    w.ledger.markExcluding('P1', 'user', '2026-09-02T02:00:00.000Z');
    w.ledger.markExcluded('P1');
    stats = w.photos.stats();
    assert.equal(stats.excludedCount, 1);
    assert.equal(stats.excludedBytes, 0, 'P2 still includes the shared asset in cloud backup');

    w.ledger.markExcluding('P2', 'user', '2026-09-02T02:00:00.000Z');
    w.ledger.markExcluded('P2');
    stats = w.photos.stats();
    assert.equal(stats.excludedCount, 2);
    assert.equal(stats.excludedBytes, 5000, 'shared excluded asset counts bytes once');
    dbClose(w.db);
  });

  test('smartAlbumCounts and albums() batch >50 Smart Albums and match per-predicate smartAlbumCount', () => {
    const w = createWorld();
    w.insert('J1', { fileKind: 'jpeg', camera: 'CamA' });
    w.insert('J2', { fileKind: 'jpeg', camera: 'CamB' });
    w.insert('R1', { fileKind: 'raw', camera: 'CamA' });
    run(w.db, `UPDATE photos SET favorite = 1 WHERE id IN ('J1', 'R1')`);

    const predicates: SmartPredicate[] = [];
    for (let i = 0; i < 55; i += 1) {
      const predicate: SmartPredicate =
        i % 3 === 0
          ? { version: 1, composition: 'and', groups: [{ facet: 'fileType', values: ['jpeg'] }] }
          : i % 3 === 1
            ? {
                version: 1,
                composition: 'and',
                groups: [
                  { facet: 'camera', values: ['CamA'] },
                  { facet: 'favorite', values: ['yes'] },
                ],
              }
            : { version: 1, composition: 'or', groups: [] };
      predicates.push(predicate);
      createSmartAlbum(w.db, {
        id: `SA-${String(i)}`,
        name: `Smart ${String(i)}`,
        parentId: null,
        predicate,
      });
    }
    createSmartAlbum(w.db, {
      id: 'SA-UNSUPPORTED',
      name: 'Future Smart',
      parentId: null,
      predicate: { version: 1, composition: 'and', groups: [] },
    });
    run(w.db, `UPDATE albums SET predicate = ? WHERE id = 'SA-UNSUPPORTED'`, JSON.stringify({ version: 99, groups: [] }));

    const stored = readSmartAlbums(w.db);
    const batched = smartAlbumCounts(w.db, stored);
    const listings = new Map(w.photos.albums().map((album) => [album.id, album]));

    for (let i = 0; i < 55; i += 1) {
      const id = `SA-${String(i)}`;
      const predicate = predicates[i];
      assert.ok(predicate);
      const expected = smartAlbumCount(w.db, predicate);
      assert.equal(batched.get(id), expected, `batched count mismatch for ${id}`);
      assert.equal(listings.get(id)?.count, expected, `album listing count mismatch for ${id}`);
    }
    assert.equal(listings.get('SA-UNSUPPORTED')?.count, 0);
    assert.notEqual(listings.get('SA-UNSUPPORTED')?.unsupported, null);
    dbClose(w.db);
  });
});

function dbClose(db: ReturnType<typeof openLibraryDatabase>): void {
  db.close();
}
