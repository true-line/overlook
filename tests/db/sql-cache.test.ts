import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3-multiple-ciphers';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { queryAll, queryGet, run, STATEMENT_CACHE_MAX } from '../../src/main/db/sql.js';

// The 113K-import freeze (2026-07-28): statement re-preparation was ~25% of
// profiled CPU, and SQLCipher's default ~2MB page cache re-decrypted pages
// on nearly every B-tree seek. These tests pin the two db-layer fixes.

const DB_KEY = randomBytes(32);

function openDb(): Database.Database {
  return openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-sqlcache-')), 'library.db'), dbKey: DB_KEY });
}

function countingDb(): { db: Database.Database; prepares: () => number } {
  const db = openDb();
  const original = db.prepare.bind(db);
  let prepares = 0;
  db.prepare = (source: string) => {
    prepares += 1;
    return original(source);
  };
  return { db, prepares: () => prepares };
}

describe('library database page cache (113K-import freeze; 200K qualification)', () => {
  test('the page cache is sized for SQLCipher (256 MiB)', () => {
    const db = openDb();
    assert.equal(db.pragma('cache_size', { simple: true }), -262144);
    db.close();
  });
});

describe('sql statement cache (113K-import freeze)', () => {
  test('helpers reuse prepared statements per connection', () => {
    const { db, prepares } = countingDb();
    assert.equal(queryGet<{ n: number }>(db, 'SELECT count(*) AS n FROM photos')?.n, 0);
    assert.equal(queryGet<{ n: number }>(db, 'SELECT count(*) AS n FROM photos')?.n, 0);
    queryAll<{ n: number }>(db, 'SELECT count(*) AS n FROM photos');
    assert.equal(prepares(), 1, 'identical SQL prepares once');
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'k', '2026-07-28T00:00:00.000Z')`);
    run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'k', '2026-07-28T00:00:00.000Z')`);
    assert.equal(prepares(), 3, 'distinct SQL prepares separately');
    db.close();
  });

  test('the LRU cap evicts the least recently used statement', () => {
    const { db, prepares } = countingDb();
    for (let i = 0; i <= STATEMENT_CACHE_MAX; i += 1) {
      queryGet<{ n: number }>(db, `SELECT ${String(i)} AS n`);
    }
    const filled = prepares();
    queryGet<{ n: number }>(db, `SELECT ${String(STATEMENT_CACHE_MAX)} AS n`);
    assert.equal(prepares(), filled, 'a recent statement is still cached');
    assert.equal(queryGet<{ n: number }>(db, 'SELECT 0 AS n')?.n, 0, 'an evicted statement still works');
    assert.equal(prepares(), filled + 1, 'the oldest statement was evicted and re-prepared');
    db.close();
  });
});
