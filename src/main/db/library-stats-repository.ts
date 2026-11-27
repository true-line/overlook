import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { LibraryStats } from '../../shared/library/types.js';
import { queryAll } from './sql.js';

/** Logical coverage totals and observed device-local custody are separate facts. */
export function readLibraryStats(db: BetterSqlite3.Database, pending: number): LibraryStats {
  // Variants share one original (#496): asset byte totals count each content_hash once,
  // and offloaded/excluded bytes count only when every live row on that asset is offloaded/excluded (#1439).
  const sql = `WITH by_asset AS (
      SELECT max(p.bytes) AS bytes, count(*) AS rows,
             sum(CASE WHEN l.status = 'offloaded' THEN 1 ELSE 0 END) AS offloaded_rows,
             sum(CASE WHEN l.coverage = 'excluded' THEN 1 ELSE 0 END) AS excluded_rows,
             sum(CASE WHEN l.coverage = 'excluding' THEN 1 ELSE 0 END) AS excluding_rows,
             sum(CASE WHEN l.coverage = 'excluded' AND p.local_custody_failure = 'local-missing' THEN 1 ELSE 0 END) AS missing_rows,
             sum(CASE WHEN l.coverage = 'excluded' AND p.local_custody_failure = 'local-corrupt' THEN 1 ELSE 0 END) AS corrupt_rows
        FROM ordinary_visible_photos p LEFT JOIN sync_ledger l ON l.photo_id = p.id
       WHERE p.deleted_at IS NULL GROUP BY p.content_hash
    ) SELECT sum(rows) AS photos, sum(bytes) AS bytes,
             sum(CASE WHEN offloaded_rows = rows THEN bytes ELSE 0 END) AS offloadedBytes,
             sum(excluded_rows) AS excludedCount,
             sum(CASE WHEN excluded_rows = rows THEN bytes ELSE 0 END) AS excludedBytes,
             sum(excluding_rows) AS pendingRemovals,
             sum(missing_rows) AS localMissingCount, sum(corrupt_rows) AS localCorruptCount,
             sum(CASE WHEN missing_rows > 0 THEN bytes ELSE 0 END) AS localMissingBytes FROM by_asset`;
  const row = queryAll<{
    photos: number | null;
    bytes: number | null;
    offloadedBytes: number | null;
    excludedCount: number | null;
    excludedBytes: number | null;
    pendingRemovals: number | null;
    localMissingCount: number | null;
    localCorruptCount: number | null;
    localMissingBytes: number | null;
  }>(db, sql)[0];
  const lastBackupAt =
    queryAll<{ at: string | null }>(
      db,
      `SELECT max(l.last_backup_at) AS at FROM sync_ledger l JOIN ordinary_visible_photos p ON p.id = l.photo_id`,
    )[0]?.at ?? null;
  return {
    photos: row?.photos ?? 0,
    bytes: row?.bytes ?? 0,
    pending,
    lastBackupAt,
    offloadedBytes: row?.offloadedBytes ?? 0,
    excludedCount: row?.excludedCount ?? 0,
    excludedBytes: row?.excludedBytes ?? 0,
    pendingRemovals: row?.pendingRemovals ?? 0,
    localMissingCount: row?.localMissingCount ?? 0,
    localCorruptCount: row?.localCorruptCount ?? 0,
    localMissingBytes: row?.localMissingBytes ?? 0,
  };
}
