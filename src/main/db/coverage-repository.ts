import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll } from './sql.js';
import type { BackupCoverage, LocalCustodyFailure, SyncStatus } from '../../shared/library/types.js';

// Backup-coverage reads (#506, ADR-0033). Split from photos-repository.ts so
// that file stays under the cap; every query joins the ledger through the
// ordinary view, so protected-domain rows never appear here.

export interface CoverageRow {
  readonly id: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly fileName: string;
  readonly status: SyncStatus;
  readonly dirty: boolean;
  readonly coverage: BackupCoverage;
  readonly deleted: boolean;
  readonly localCustodyFailure?: LocalCustodyFailure | null | undefined;
}

interface RawRow {
  id: string;
  content_hash: string;
  bytes: number;
  file_name: string;
  status: SyncStatus;
  dirty: number;
  coverage: BackupCoverage;
  deleted_at: string | null;
  local_custody_failure: LocalCustodyFailure | null;
}

const COLUMNS = `p.id, p.content_hash, p.bytes, p.file_name, l.status, l.dirty, l.coverage, p.deleted_at, p.local_custody_failure
     FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id`;

function toRow(row: RawRow): CoverageRow {
  return {
    id: row.id,
    contentHash: row.content_hash,
    bytes: row.bytes,
    fileName: row.file_name,
    status: row.status,
    dirty: row.dirty === 1,
    coverage: row.coverage,
    deleted: row.deleted_at !== null,
    localCustodyFailure: row.local_custody_failure,
  };
}

export class CoverageRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** The requested rows in request order; unknown ids are simply absent. */
  rows(photoIds: readonly string[]): readonly CoverageRow[] {
    const byId = new Map<string, CoverageRow>();
    for (let start = 0; start < photoIds.length; start += 500) {
      const chunk = photoIds.slice(start, start + 500);
      const params: Record<string, unknown> = {};
      const names = chunk.map((id, index) => {
        params[`id${String(index)}`] = id;
        return `@id${String(index)}`;
      });
      for (const row of queryAll<RawRow>(this.db, `SELECT ${COLUMNS} WHERE p.id IN (${names.join(', ')})`, params)) {
        byId.set(row.id, toRow(row));
      }
    }
    return photoIds.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
  }

  /** Rows whose removal is still owed to the provider (ADR-0033 §2/§6). */
  excluding(): readonly CoverageRow[] {
    return queryAll<RawRow>(this.db, `SELECT ${COLUMNS} WHERE l.coverage = 'excluding' ORDER BY p.imported_at, p.id`).map(toRow);
  }

  /** ADR-0033 §3 shared-bytes gate: every row — deleted-but-retained
   * included, since recovery still promises its original — that keeps a
   * backup claim on this asset. The remote object may only go when this
   * reaches zero. */
  includedReferences(contentHash: string): number {
    return (
      queryAll<{ n: number }>(
        this.db,
        `SELECT count(*) AS n FROM photos p JOIN sync_ledger l ON l.photo_id = p.id
          WHERE p.content_hash = @hash AND l.coverage = 'included'`,
        { hash: contentHash },
      )[0]?.n ?? 0
    );
  }
}
