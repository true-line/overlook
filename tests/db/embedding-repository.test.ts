import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import Database from 'better-sqlite3-multiple-ciphers';

import { EmbeddingRepository, EMBEDDING_DIMENSIONS } from '../../src/main/db/embedding-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll, queryGet, run } from '../../src/main/db/sql.js';
import { migrate, MIGRATIONS } from '../../src/main/db/migrations.js';
import { configureEmbeddingVectorSchema, vectorExtensionPath, vectorExtensionSupported } from '../../src/main/db/vector-extension.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const DB_KEY = randomBytes(32);
const MODEL_VERSION = 'mobileclip-s2-test-v1';

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'overlook-embeddings-')), 'library.db');
}

function photo(id: string, contentHash: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 640,
    height: 480,
    bytes: 1024,
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
    importedAt: '2026-07-25T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  };
}

function vector(fill: number): Int8Array {
  return new Int8Array(EMBEDDING_DIMENSIONS).fill(fill);
}

function basis(dimension: number): Int8Array {
  const result = new Int8Array(EMBEDDING_DIMENSIONS);
  result[dimension] = 127;
  return result;
}

function openSeeded(path = tempDbPath()): {
  readonly path: string;
  readonly db: ReturnType<typeof openLibraryDatabase>;
  readonly photos: PhotosRepository;
  readonly embeddings: EmbeddingRepository;
} {
  const db = openLibraryDatabase({ path, dbKey: DB_KEY });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test-key', ?)`, new Date().toISOString());
  return { path, db, photos: new PhotosRepository(db), embeddings: new EmbeddingRepository(db) };
}

test('eligibility index upgrade preserves cosine ranking, ties and filtering before LIMIT (#1221)', (t) => {
  const { db, photos, embeddings } = openSeeded();
  t.after(() => db.close());
  db.exec('DROP INDEX idx_photos_embedding_eligibility; DELETE FROM schema_migrations WHERE version = 52');
  const indexPhoto = (id: string, embedding: Int8Array, version = MODEL_VERSION): void => {
    const contentHash = createHash('sha256').update(id).digest('hex');
    photos.insert(photo(id, contentHash));
    embeddings.put({ photoId: id, contentHash }, version, embedding);
  };
  // Insertion/embedding IDs and Euclidean distance disagree with the accepted
  // cosine + photo-ID tie order, including more tied rows than the limit.
  for (const [id, magnitude] of [
    ['Z', 8],
    ['B', 127],
    ['A', 2],
  ] as const) {
    const embedding = new Int8Array(EMBEDDING_DIMENSIONS);
    embedding[0] = magnitude;
    indexPhoto(id, embedding);
  }
  indexPhoto('ORTHOGONAL', basis(1));
  indexPhoto('OLD-MODEL', basis(0), 'other-model');
  const prepare = db.prepare.bind(db);
  let capturedSql = '';
  t.mock.method(db, 'prepare', (sql: string) => {
    capturedSql = sql;
    return prepare(sql);
  });
  const query = basis(0);
  const before = embeddings.nearest(MODEL_VERSION, query, { source: 'all' }, 2);
  const nearestSql = capturedSql;
  assert.deepEqual(
    before.map(({ photoId }) => photoId),
    ['A', 'B'],
  );
  const status = embeddings.status(MODEL_VERSION);

  assert.equal(
    migrate(
      db,
      MIGRATIONS.filter(({ version }) => version === 52),
    ),
    1,
  );
  assert.equal(
    migrate(
      db,
      MIGRATIONS.filter(({ version }) => version === 52),
    ),
    0,
  );
  assert.deepEqual(embeddings.nearest(MODEL_VERSION, query, { source: 'all' }, 2), before);
  assert.deepEqual(embeddings.status(MODEL_VERSION), status, 'public counts remain accurate');
  const plan = queryAll<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${nearestSql}`, {
    modelVersion: MODEL_VERSION,
    embedding: Buffer.from(query),
    limit: 2,
  });
  assert.ok(
    plan.some(({ detail }) => detail.includes('COVERING INDEX idx_photos_embedding_eligibility')),
    JSON.stringify(plan),
  );

  photos.toggleFavorite('B');
  assert.deepEqual(
    embeddings.nearest(MODEL_VERSION, query, { source: 'favorites' }, 1).map(({ photoId }) => photoId),
    ['B'],
  );
  run(db, "UPDATE photos SET in_all_photos = 0 WHERE id = 'A'");
  assert.deepEqual(
    embeddings.nearest(MODEL_VERSION, query, { source: 'all' }, 2).map(({ photoId }) => photoId),
    ['B', 'Z'],
  );
  photos.softDelete(['B']);
  run(db, "UPDATE photos SET content_hash = ? WHERE id = 'Z'", 'b'.repeat(64));
  assert.deepEqual(
    embeddings.nearest(MODEL_VERSION, query, { source: 'all' }, 2).map(({ photoId }) => photoId),
    ['ORTHOGONAL'],
  );
});

describe('sqlite-vec SQLCipher composition (#391)', () => {
  test('loads vec0 before migration and rewrites packaged extension paths', () => {
    const { db } = openSeeded();
    assert.equal(queryGet<{ version: string }>(db, 'SELECT vec_version() AS version')?.version, 'v0.1.9');
    assert.deepEqual(
      queryGet<{ sql: string }>(db, `SELECT sql FROM sqlite_master WHERE name = 'photo_embedding_vectors'`)?.sql.includes('vec0'),
      true,
    );
    assert.equal(
      vectorExtensionPath('/Applications/Overlook.app/Contents/Resources/app.asar/node_modules/sqlite-vec/vec0.dylib'),
      '/Applications/Overlook.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec/vec0.dylib',
    );
    db.close();
  });

  test('keeps unsupported targets usable and repairs dormant vector rows later', () => {
    assert.equal(vectorExtensionSupported('win32', 'arm64'), false);
    assert.equal(vectorExtensionSupported('win32', 'x64'), true);

    const { path, db, photos, embeddings } = openSeeded();
    const contentHash = 'f'.repeat(64);
    photos.insert(photo('P-DORMANT', contentHash));
    embeddings.put({ photoId: 'P-DORMANT', contentHash }, MODEL_VERSION, vector(2));
    db.close();

    const unsupported = new Database(path);
    unsupported.pragma(`cipher='sqlcipher'`);
    unsupported.pragma(`key="x'${DB_KEY.toString('hex')}'"`);
    unsupported.pragma('foreign_keys = ON');
    unsupported.prepare('SELECT count(*) FROM sqlite_master').get();
    configureEmbeddingVectorSchema(unsupported, false);
    run(unsupported, 'DELETE FROM photo_embeddings WHERE photo_id = ?', 'P-DORMANT');
    unsupported.close();

    const reopened = openLibraryDatabase({ path, dbKey: DB_KEY });
    const repaired = new EmbeddingRepository(reopened);
    assert.equal(repaired.vectorCount(), 0, 'supported target prunes the dormant orphan before restoring cleanup');
    assert.equal(
      queryGet<{ name: string }>(reopened, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'photo_embeddings_ad'`)?.name,
      'photo_embeddings_ad',
    );
    reopened.close();
  });

  test('stores vectors in the encrypted library and rejects raw inspection', () => {
    const { path, db, photos, embeddings } = openSeeded();
    const contentHash = 'a'.repeat(64);
    photos.insert(photo('P-ENCRYPTED', contentHash));
    embeddings.put({ photoId: 'P-ENCRYPTED', contentHash }, MODEL_VERSION, vector(7));
    db.close();

    const raw = readFileSync(path);
    assert.equal(raw.includes(Buffer.from('SQLite format 3')), false);
    assert.equal(raw.includes(Buffer.from(contentHash)), false);
    assert.equal(raw.includes(Buffer.from(MODEL_VERSION)), false);
  });
});

describe('EmbeddingRepository', () => {
  test('ranks cosine neighbors while preserving ordinary library filters', () => {
    const { db, photos, embeddings } = openSeeded();
    const closest = { ...photo('P-CLOSEST', 'c'.repeat(64)), favorite: false };
    const favorite = { ...photo('P-FAVORITE', 'd'.repeat(64)), favorite: true };
    photos.insert(closest);
    photos.insert(favorite);
    embeddings.put({ photoId: closest.id, contentHash: closest.contentHash }, MODEL_VERSION, basis(0));
    embeddings.put({ photoId: favorite.id, contentHash: favorite.contentHash }, MODEL_VERSION, basis(1));

    assert.deepEqual(
      embeddings.nearest(MODEL_VERSION, basis(0), { source: 'all' }, 10).map(({ photoId }) => photoId),
      ['P-CLOSEST', 'P-FAVORITE'],
    );
    assert.deepEqual(
      embeddings.nearest(MODEL_VERSION, basis(0), { source: 'favorites' }, 10).map(({ photoId }) => photoId),
      ['P-FAVORITE'],
      'semantic candidates use the same source predicate as keyword queries',
    );
    db.close();
  });

  test('the database is the resumable queue and completed rows are not repeated', () => {
    const { db, photos, embeddings } = openSeeded();
    const first = photo('P-FIRST', '1'.repeat(64));
    const second = photo('P-SECOND', '2'.repeat(64));
    photos.insert(first);
    photos.insert(second);

    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 2, completed: 0, pending: 2 });
    assert.deepEqual(
      embeddings.pending(MODEL_VERSION, 1),
      [{ photoId: first.id, contentHash: first.contentHash, derivativeKey: first.contentHash }],
      'candidate order is stable and bounded',
    );

    embeddings.put({ photoId: first.id, contentHash: first.contentHash }, MODEL_VERSION, vector(1), '2026-07-25T01:00:00.000Z');
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 2, completed: 1, pending: 1 });
    assert.deepEqual(embeddings.pending(MODEL_VERSION, 10), [
      { photoId: second.id, contentHash: second.contentHash, derivativeKey: second.contentHash },
    ]);
    assert.equal(embeddings.vectorCount(), 1);
    db.close();
  });

  test('per-photo derivative deferrals persist, do not block later candidates, and clear on repair', () => {
    const { path, db, photos, embeddings } = openSeeded();
    const first = photo('P-DEFERRED', '7'.repeat(64));
    const second = photo('P-RUNNABLE', '8'.repeat(64));
    photos.insert(first);
    photos.insert(second);

    embeddings.defer({ photoId: first.id, contentHash: first.contentHash }, MODEL_VERSION, 'derivative-unavailable');
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 1, completed: 0, pending: 1 });
    assert.deepEqual(embeddings.pending(MODEL_VERSION, 10), [
      { photoId: second.id, contentHash: second.contentHash, derivativeKey: second.contentHash },
    ]);
    db.close();

    const reopened = openLibraryDatabase({ path, dbKey: DB_KEY });
    const resumed = new EmbeddingRepository(reopened);
    assert.deepEqual(resumed.pending(MODEL_VERSION, 10), [
      { photoId: second.id, contentHash: second.contentHash, derivativeKey: second.contentHash },
    ]);
    assert.equal(resumed.clearDeferred(MODEL_VERSION, [first.id]), 1);
    assert.deepEqual(resumed.status(MODEL_VERSION), { total: 2, completed: 0, pending: 2 });
    reopened.close();
  });

  test('model completion removes superseded vectors and deferrals but retains the current version', () => {
    const { db, photos, embeddings } = openSeeded();
    const indexed = photo('P-MODEL', '9'.repeat(64));
    const deferred = photo('P-MODEL-DEFERRED', 'b'.repeat(64));
    photos.insert(indexed);
    photos.insert(deferred);
    embeddings.put({ photoId: indexed.id, contentHash: indexed.contentHash }, 'old-model', vector(1));
    embeddings.put({ photoId: indexed.id, contentHash: indexed.contentHash }, MODEL_VERSION, vector(2));
    embeddings.defer({ photoId: deferred.id, contentHash: deferred.contentHash }, 'old-model', 'derivative-unavailable');
    embeddings.defer({ photoId: deferred.id, contentHash: deferred.contentHash }, MODEL_VERSION, 'derivative-unavailable');

    assert.equal(embeddings.deleteOtherModels(MODEL_VERSION), 1);
    assert.equal(embeddings.vectorCount(), 1);
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 1, completed: 1, pending: 0 });
    assert.deepEqual(embeddings.pending('old-model', 10), [
      { photoId: indexed.id, contentHash: indexed.contentHash, derivativeKey: indexed.contentHash },
      { photoId: deferred.id, contentHash: deferred.contentHash, derivativeKey: deferred.contentHash },
    ]);
    db.close();
  });

  test('content changes requeue, replace atomically, and enforce 512 int8 dimensions', () => {
    const { db, photos, embeddings } = openSeeded();
    const originalHash = '3'.repeat(64);
    const changedHash = '4'.repeat(64);
    photos.insert(photo('P-EDITED', originalHash));
    embeddings.put({ photoId: 'P-EDITED', contentHash: originalHash }, MODEL_VERSION, vector(-2));

    run(db, 'UPDATE photos SET content_hash = ?, derivative_key = ? WHERE id = ?', changedHash, changedHash, 'P-EDITED');
    assert.deepEqual(embeddings.pending(MODEL_VERSION, 10), [
      { photoId: 'P-EDITED', contentHash: changedHash, derivativeKey: changedHash },
    ]);
    assert.equal(embeddings.deleteStale(MODEL_VERSION), 1);
    assert.equal(embeddings.vectorCount(), 0);

    assert.throws(
      () => embeddings.put({ photoId: 'P-EDITED', contentHash: changedHash }, MODEL_VERSION, new Int8Array(8)),
      /512 dimensions/,
    );
    embeddings.put({ photoId: 'P-EDITED', contentHash: changedHash }, MODEL_VERSION, vector(4));
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 1, completed: 1, pending: 0 });
    db.close();
  });

  test('soft delete requeues nothing and permanent purge cascades vector removal', () => {
    const { db, photos, embeddings } = openSeeded();
    const contentHash = '5'.repeat(64);
    photos.insert(photo('P-PURGED', contentHash));
    embeddings.put({ photoId: 'P-PURGED', contentHash }, MODEL_VERSION, vector(5));

    photos.softDelete(['P-PURGED']);
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 0, completed: 0, pending: 0 });
    assert.equal(embeddings.deleteStale(MODEL_VERSION), 1);
    assert.equal(embeddings.vectorCount(), 0);

    photos.restore(['P-PURGED']);
    embeddings.put({ photoId: 'P-PURGED', contentHash }, MODEL_VERSION, vector(6));
    photos.softDelete(['P-PURGED']);
    photos.purgeRow('P-PURGED');
    assert.equal(embeddings.vectorCount(), 0, 'photo FK cascade fires the vec0 cleanup trigger');
    db.close();
  });

  test('protected/ineligible photos cannot be written through a stale candidate', () => {
    const { db, photos, embeddings } = openSeeded();
    const contentHash = '6'.repeat(64);
    photos.insert(photo('P-HIDDEN', contentHash));
    photos.softDelete(['P-HIDDEN']);

    assert.throws(() => embeddings.put({ photoId: 'P-HIDDEN', contentHash }, MODEL_VERSION, vector(1)), /not eligible/);
    assert.equal(embeddings.vectorCount(), 0);
    db.close();
  });
});
