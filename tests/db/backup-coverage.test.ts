import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LedgerTransitionError, SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { CoverageRepository } from '../../src/main/db/coverage-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { queryAll, run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #506 / ADR-0033 §1: coverage is a ledger column with its own machine
// (included → excluding → excluded → included), and every backup read —
// dirty rows, the pending count, remote integrity — sees only included rows.
// Excluded local custody has its own verification pass (#1135).

const AT = '2026-09-02T00:00:00.000Z';

function world() {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-coverage-db-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const insert = (id: string, bytes = 10, contentHash = id.repeat(8).slice(0, 64).padEnd(64, '0')): void => {
    repo.insert({
      id,
      fileName: `${id}.JPG`,
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
      importedAt: '2026-07-13T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  };
  const duplicate = (sourceId: string, id: string): void => {
    const source = repo.get(sourceId);
    assert.ok(source);
    new VariantRepository(db).duplicate(source, id, AT);
  };
  return { db, repo, ledger: new SyncLedger(db), coverage: new CoverageRepository(db), insert, duplicate };
}

describe('backup coverage column (#506, migration 35)', () => {
  test('migration 35 adds the column with its default, CHECK and partial index', () => {
    const w = world();
    assert.equal(MIGRATIONS.find((migration) => migration.version === 35)?.name, 'backup-coverage');
    w.insert('P1');
    assert.deepEqual(w.ledger.coverage('P1'), { coverage: 'included', origin: null, since: null });
    assert.equal(w.repo.get('P1')?.coverage, 'included', 'the record carries the column');
    assert.throws(() => run(w.db, `UPDATE sync_ledger SET coverage = 'bogus' WHERE photo_id = 'P1'`), /CHECK/u);
    assert.throws(() => run(w.db, `UPDATE sync_ledger SET coverage_origin = 'bogus' WHERE photo_id = 'P1'`), /CHECK/u);
    const indexes = queryAll<{ name: string }>(w.db, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sync_ledger'`);
    assert.ok(indexes.some((row) => row.name === 'idx_sync_ledger_coverage'));
  });

  test('the coverage machine: excluding only from included, excluded only from excluding, included is a fresh dirty local row', () => {
    const w = world();
    w.insert('P1');
    w.ledger.setStatus('P1', 'syncing');
    w.ledger.markBackedUp('P1', AT);
    assert.throws(() => w.ledger.markExcluded('P1'), LedgerTransitionError);

    w.ledger.markExcluding('P1', 'user', AT);
    assert.deepEqual(w.ledger.coverage('P1'), { coverage: 'excluding', origin: 'user', since: AT });
    assert.throws(() => w.ledger.markExcluding('P1', 'user', AT), LedgerTransitionError);
    assert.equal(w.ledger.status('P1'), 'synced', 'the remote claim stands until the copy is gone');

    w.ledger.markExcluded('P1');
    assert.equal(w.ledger.coverage('P1')?.coverage, 'excluded');
    assert.equal(w.ledger.status('P1'), 'local', 'no provider copy is claimed any more');
    assert.equal(w.ledger.isDirty('P1'), false, 'an excluded row is never backup work');
    assert.equal(w.repo.get('P1')?.coverage, 'excluded');

    w.ledger.markIncluded('P1', '2026-09-03T00:00:00.000Z');
    assert.deepEqual(w.ledger.coverage('P1'), { coverage: 'included', origin: null, since: '2026-09-03T00:00:00.000Z' });
    assert.equal(w.ledger.status('P1'), 'local');
    assert.equal(w.ledger.isDirty('P1'), true, '§5: re-enabling is an ordinary dirty row for the verified upload');
    w.ledger.markIncluded('P1', AT);
    assert.equal(w.ledger.coverage('P1')?.since, '2026-09-03T00:00:00.000Z', 'already included is a no-op');
  });

  test('remote backup reads skip excluded rows: dirty list, pending count, integrity, stats', () => {
    const w = world();
    w.insert('P1', 10);
    w.insert('P2', 20);
    w.insert('P3', 30);
    assert.equal(w.repo.pendingCount(), 3);
    for (const id of ['P1', 'P2', 'P3']) {
      w.ledger.setStatus(id, 'syncing');
      w.ledger.markBackedUp(id, AT);
    }
    w.ledger.markExcluding('P2', 'user', AT);
    w.ledger.markExcluded('P2');
    w.ledger.markExcluding('P3', 'user', AT);
    for (const id of ['P1', 'P2', 'P3']) w.ledger.markDirty(id);
    assert.equal(w.repo.pendingCount(), 1, 'excluding and excluded rows are not pending work');
    assert.deepEqual(
      w.repo.dirtyPhotos().map((row) => row.id),
      ['P1'],
    );
    assert.deepEqual(
      w.repo.integrityItems({ afterId: null, limit: 10 }).map((row) => row.id),
      ['P1'],
      'a still-synced excluding row is not an integrity claim',
    );
    const stats = w.repo.stats();
    assert.equal(stats.excludedCount, 1);
    assert.equal(stats.excludedBytes, 20);
    assert.equal(stats.pendingRemovals, 1);
  });

  test('the coverage repository: request order, the excluding queue, and the §3 shared-bytes gate', () => {
    const w = world();
    const shared = 'c'.repeat(64);
    w.insert('P1', 10, shared);
    w.duplicate('P1', 'P2');
    w.insert('P3', 30);
    assert.deepEqual(
      w.coverage.rows(['P3', 'GHOST', 'P1']).map((row) => row.id),
      ['P3', 'P1'],
    );
    assert.equal(w.coverage.rows(['P1'])[0]?.coverage, 'included');
    assert.equal(w.coverage.includedReferences(shared), 2);
    w.ledger.markExcluding('P1', 'user', AT);
    assert.deepEqual(
      w.coverage.excluding().map((row) => row.id),
      ['P1'],
    );
    assert.equal(w.coverage.includedReferences(shared), 1, 'the sibling still claims the asset');
    w.repo.softDelete(['P2']);
    assert.equal(w.coverage.includedReferences(shared), 1, 'a deleted-but-retained row still keeps its claim');
  });
});
