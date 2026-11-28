import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { FingerprintRepository } from '../../src/main/db/fingerprint-repository.js';
import { migrate, MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll } from '../../src/main/db/sql.js';
import { seedSynthetic } from '../../src/main/library/seed.js';

test('upgrading indexes pending fingerprints without sorting the library (#1221)', (t) => {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-candidate-index-')), 'library.db'),
    dbKey: Buffer.alloc(32, 9),
  });
  t.after(() => db.close());
  seedSynthetic(db, 1, 'candidate-index', 256);
  // Model an existing v50 library, including its already completed candidates.
  db.exec('DROP INDEX IF EXISTS idx_photos_fingerprint_pending; DELETE FROM schema_migrations WHERE version = 51');
  const fingerprints = new FingerprintRepository(db);
  const prepare = db.prepare.bind(db);
  let candidateSql = '';
  t.mock.method(db, 'prepare', (sql: string) => {
    candidateSql = sql;
    return prepare(sql);
  });
  const first = fingerprints.pending('test', 64);
  assert.equal(first.length, 64);
  const sql = candidateSql;
  assert.notEqual(sql, '');
  const plan = () => queryAll<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, { version: 'test', limit: 64 });
  assert.ok(plan().some(({ detail }) => detail.includes('USE TEMP B-TREE FOR ORDER BY')));
  for (const candidate of first.slice(0, 20)) fingerprints.defer(candidate, 'test', 'derivative-unavailable');
  new PhotosRepository(db).softDelete(first.slice(20, 30).map(({ photoId }) => photoId));
  const expected = fingerprints.pending('test', 64);

  assert.equal(
    migrate(
      db,
      MIGRATIONS.filter(({ version }) => version === 51),
    ),
    1,
  );
  assert.equal(
    migrate(
      db,
      MIGRATIONS.filter(({ version }) => version === 51),
    ),
    0,
  );
  const details = plan().map(({ detail }) => detail);
  assert.ok(
    details.some((detail) => detail.includes('COVERING INDEX idx_photos_fingerprint_pending')),
    details.join('\n'),
  );
  assert.ok(
    details.every((detail) => !detail.includes('USE TEMP B-TREE')),
    details.join('\n'),
  );
  assert.deepEqual(fingerprints.pending('test', 64), expected, 'upgrade preserves order and freshness exclusions');
  fingerprints.invalidate(first.slice(0, 20).map(({ photoId }) => photoId));
  assert.deepEqual(fingerprints.pending('test', 20), first.slice(0, 20), 'invalidated rows become pending in the same order');
});
