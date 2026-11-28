import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

import assert from 'node:assert/strict';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EMBEDDING_DIMENSIONS, EmbeddingRepository, type SemanticCandidate } from '../../src/main/db/embedding-repository.js';
import { buildQueryPlan } from '../../src/main/db/photo-query.js';
import { queryAll } from '../../src/main/db/sql.js';
import { EMBEDDING_MODEL_MANIFEST } from '../../src/main/embedding/model-manifest.js';
import { seedSemanticIndex, seedSynthetic } from '../../src/main/library/seed.js';

const SIZE = 200_000;
const LIMIT = 2_000;
const ROUNDS = 5;

interface Measurement {
  readonly coveringIndex: boolean;
  readonly cacheMiB: number;
  readonly join: 'point' | 'scan';
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly plan: readonly { readonly detail: string }[];
}

// Executed as compiled JavaScript in a plain Node child: Playwright applies
// the root declaration-only SQLite path mapping to runtime imports.
function runSqlDiagnostics(): void {
  const directory = mkdtempSync(join(tmpdir(), 'overlook-sql-diagnostic-'));
  const dbKey = randomBytes(32);
  const path = join(directory, 'library.db');
  const setupStarted = performance.now();
  try {
    const seeder = openLibraryDatabase({ path, dbKey });
    try {
      assert.equal(seedSynthetic(seeder, 1, 'sql-diagnostic', SIZE), SIZE);
      assert.equal(seedSemanticIndex(seeder, 0), SIZE);
    } finally {
      seeder.close();
    }
    const setupMs = performance.now() - setupStarted;
    const openStarted = performance.now();
    const db = openLibraryDatabase({ path, dbKey });
    const openMs = performance.now() - openStarted;
    try {
      const repository = new EmbeddingRepository(db);
      assert.equal(repository.status(EMBEDDING_MODEL_MANIFEST.version).completed, SIZE);
      const embedding = new Int8Array(EMBEDDING_DIMENSIONS);
      embedding[0] = 127;
      const request = { source: 'all' } as const;
      const expected = repository.nearest(EMBEDDING_MODEL_MANIFEST.version, embedding, request, LIMIT);
      assert.equal(expected.length, LIMIT);
      const plan = buildQueryPlan(request);
      const params = { ...plan.params, modelVersion: EMBEDDING_MODEL_MANIFEST.version, embedding: Buffer.from(embedding), limit: LIMIT };
      const joins = {
        point: 'photo_embeddings e JOIN photo_embedding_vectors v ON v.embedding_id = e.embedding_id',
        scan: 'photo_embedding_vectors v CROSS JOIN photo_embeddings e ON e.embedding_id = v.embedding_id',
      } as const;
      const measurements: Measurement[] = [];
      const retain = () => {
        mkdirSync('test-results', { recursive: true });
        writeFileSync(
          'test-results/sql-diagnostics-perf-report.json',
          JSON.stringify(
            {
              diagnosticOnly: true,
              librarySize: SIZE,
              setupMs,
              openMs,
              machine: { cpu: cpus()[0]?.model ?? 'unknown', parallelism: availableParallelism(), node: process.version },
              releaseMemoryRequestedBeforeEachVariant: true,
              rounds: ROUNDS,
              measurements,
            },
            null,
            2,
          ),
        );
      };
      retain();
      for (const coveringIndex of [true, false]) {
        if (!coveringIndex) db.exec('DROP INDEX idx_photos_embedding_eligibility');
        for (const cacheMiB of [64, 128, 256, 512]) {
          db.pragma(`cache_size = -${String(cacheMiB * 1024)}`);
          for (const join of ['point', 'scan'] as const) {
            const sql = `SELECT e.photo_id AS photoId,
                vec_distance_cosine(v.embedding, vec_int8(@embedding)) AS distance
              FROM ${joins[join]}
              JOIN ordinary_visible_photos p ON p.id = e.photo_id
              LEFT JOIN sync_ledger l ON l.photo_id = p.id
             WHERE e.model_version = @modelVersion AND e.content_hash = p.content_hash
               AND ${plan.whereClause}
             ORDER BY distance, p.id LIMIT @limit`;
            db.pragma('shrink_memory');
            const samplesMs: number[] = [];
            for (let round = 0; round < ROUNDS; round += 1) {
              const started = performance.now();
              const actual = queryAll<SemanticCandidate>(db, sql, params);
              samplesMs.push(performance.now() - started);
              assert.deepEqual(actual, expected);
            }
            const sorted = [...samplesMs].sort((a, b) => a - b);
            measurements.push({
              coveringIndex,
              cacheMiB,
              join,
              samplesMs,
              medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
              plan: queryAll<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, params),
            });
            retain();
          }
        }
      }
      console.log('[perf] DIAGNOSTIC SQL (not qualification):', JSON.stringify(measurements));
    } finally {
      db.close();
    }
  } finally {
    dbKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.env['OVERLOOK_PERF_PROFILE'] === '1') runSqlDiagnostics();
