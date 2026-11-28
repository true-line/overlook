import { PHOTO_HAS_ABSENT_KEY_SQL } from '../db/backup-key-availability.js';
import { queryAll, run } from '../db/sql.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import type { BackupCoverage, BackupCoverageOrigin, SyncStatus } from '../../shared/library/types.js';

// Sync-ledger bookkeeping (#104): the dirtiness the whole backup UX rides
// on. ONE choke-point dirties (every library edit routes here), the status
// machine validates transitions (illegal ones throw — a bug, not a state),
// and completed backups clear dirty + stamp last_backup_at.

const TRANSITIONS: Record<SyncStatus, readonly SyncStatus[]> = {
  local: ['syncing'],
  syncing: ['synced', 'error', 'local'],
  synced: ['syncing', 'offloaded'],
  offloaded: ['synced'],
  error: ['syncing'],
};

export class LedgerTransitionError extends Error {
  override readonly name = 'LedgerTransitionError';
}

export interface LedgerCoverage {
  readonly coverage: BackupCoverage;
  readonly origin: BackupCoverageOrigin | null;
  readonly since: string | null;
}

export function assertTransition(from: SyncStatus, to: SyncStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new LedgerTransitionError(`illegal ledger transition ${from} → ${to}`);
  }
}

/** THE dirty choke-point: every library edit (favorite, album change,
 * import metadata) marks its photo here — never inline SQL at call sites. */
export function markDirty(db: BetterSqlite3.Database, photoId: string): void {
  run(db, 'UPDATE sync_ledger SET dirty = 1 WHERE photo_id = ?', photoId);
}

export class SyncLedger {
  constructor(private readonly db: BetterSqlite3.Database) {}

  status(photoId: string): SyncStatus | undefined {
    return queryAll<{ status: SyncStatus }>(this.db, 'SELECT status FROM sync_ledger WHERE photo_id = @id', { id: photoId })[0]?.status;
  }

  /** Machine-validated transition; the engine (#105) drives these. */
  setStatus(photoId: string, to: SyncStatus): void {
    const from = this.status(photoId);
    if (from === undefined) {
      throw new LedgerTransitionError(`no ledger row for ${photoId}`);
    }
    assertTransition(from, to);
    // Durable local bytes regain authority only on offloaded → synced. The
    // binding is provenance for a sole-remote original and must disappear in
    // this same transaction, never after a crash window.
    if (from === 'offloaded' && to === 'synced') {
      run(this.db, 'UPDATE sync_ledger SET status = ?, custody_authority_id = NULL WHERE photo_id = ?', to, photoId);
      return;
    }
    run(this.db, 'UPDATE sync_ledger SET status = ? WHERE photo_id = ?', to, photoId);
  }

  /** Enter sole-remote custody only with a verified named authority. The
   * account-identity slice supplies the authority; callers cannot silently
   * create a new bound row from whichever provider is selected. */
  markOffloaded(photoId: string, custodyAuthorityId: number): void {
    const from = this.status(photoId);
    if (from === undefined) throw new LedgerTransitionError(`no ledger row for ${photoId}`);
    assertTransition(from, 'offloaded');
    const authority = queryAll<{ state: 'bound' | 'provider-required' }>(this.db, 'SELECT state FROM custody_authorities WHERE id = @id', {
      id: custodyAuthorityId,
    })[0];
    if (authority?.state !== 'bound') {
      throw new LedgerTransitionError(`custody authority ${String(custodyAuthorityId)} is not bound`);
    }
    this.db.transaction(() => {
      run(
        this.db,
        'UPDATE sync_ledger SET status = ?, custody_authority_id = ? WHERE photo_id = ?',
        'offloaded',
        custodyAuthorityId,
        photoId,
      );
    })();
  }

  markDirty(photoId: string): void {
    markDirty(this.db, photoId);
  }

  /** The consistency tool's escape hatch (#125): repair writes a status
   * OUTSIDE the machine — repair exists precisely because a crash broke
   * the machine's assumptions. Never used by normal flows. */
  repairStatus(photoId: string, to: 'offloaded' | 'error'): void {
    run(this.db, 'UPDATE sync_ledger SET status = ? WHERE photo_id = ?', to, photoId);
  }

  /** A verified remote-only integrity error re-enters its custody state. */
  healIntegrityError(photoId: string): boolean {
    if (this.status(photoId) !== 'error') return false;
    this.repairStatus(photoId, 'offloaded');
    return true;
  }

  /** Completed, VERIFIED backup: syncing → synced, dirty clears, stamp set
   * (feeds "ALL BACKED UP · 2H AGO" / "JUST NOW"). */
  markBackedUp(photoId: string, at: string): void {
    this.setStatus(photoId, 'synced');
    run(this.db, 'UPDATE sync_ledger SET dirty = 0, last_backup_at = ? WHERE photo_id = ?', at, photoId);
  }

  /** Upload/verify failure: syncing → error; the row STAYS dirty. */
  markError(photoId: string): void {
    this.setStatus(photoId, 'error');
  }

  /** An OFFLOADED row's edit is manifest-only debt (PR #274 review): the
   * blob is already remote, so a fresh manifest generation settles the
   * dirt without a status transition (offloaded stays offloaded) and
   * without a backup stamp (no blob traveled). */
  settleManifestOnly(photoId: string): void {
    run(this.db, 'UPDATE sync_ledger SET dirty = 0 WHERE photo_id = ?', photoId);
  }

  isDirty(photoId: string): boolean {
    return queryAll<{ dirty: number }>(this.db, 'SELECT dirty FROM sync_ledger WHERE photo_id = @id', { id: photoId })[0]?.dirty === 1;
  }

  /** Included offloaded/clean integrity errors keep their recorded remote
   * custody. An excluded local failure never borrows a provider as its source. */
  requiresRemoteCustody(photoId: string): boolean {
    return (
      queryAll<{ found: number }>(
        this.db,
        `SELECT 1 AS found FROM sync_ledger
          WHERE photo_id = @id AND coverage = 'included'
            AND (status = 'offloaded' OR (status = 'error' AND dirty = 0))`,
        { id: photoId },
      )[0] !== undefined
    );
  }

  pendingCount(): number {
    return (
      queryAll<{ n: number }>(
        this.db,
        `SELECT count(*) AS n FROM sync_ledger l JOIN photos p ON p.id = l.photo_id
      WHERE l.dirty = 1 AND l.coverage = 'included'
        AND NOT (${PHOTO_HAS_ABSENT_KEY_SQL})`,
      )[0]?.n ?? 0
    );
  }

  // ---- Backup coverage (ADR-0033). Coverage is orthogonal to the upload
  // machine: it says whether automatic backup may touch the row at all.

  coverage(photoId: string): LedgerCoverage | undefined {
    const row = queryAll<{ coverage: BackupCoverage; origin: BackupCoverageOrigin | null; since: string | null }>(
      this.db,
      'SELECT coverage, coverage_origin AS origin, coverage_since AS since FROM sync_ledger WHERE photo_id = @id',
      { id: photoId },
    )[0];
    return row === undefined ? undefined : { coverage: row.coverage, origin: row.origin, since: row.since };
  }

  /** ADR-0033 §2's durable intermediate: the decision is recorded before
   * any provider write, so a crash leaves "removal pending", never a row
   * that silently re-enters automatic backup. Only an included row can
   * begin excluding. */
  markExcluding(photoId: string, origin: BackupCoverageOrigin, at: string): void {
    const current = this.coverage(photoId);
    if (current === undefined) throw new LedgerTransitionError(`no ledger row for ${photoId}`);
    if (current.coverage !== 'included') throw new LedgerTransitionError(`illegal coverage transition ${current.coverage} → excluding`);
    run(
      this.db,
      'UPDATE sync_ledger SET coverage = ?, coverage_origin = ?, coverage_since = ? WHERE photo_id = ?',
      'excluding',
      origin,
      at,
      photoId,
    );
  }

  /** The provider copy is gone (or was never there, or is retained for a
   * sibling per §3): the row is local-only by choice. Custody follows —
   * the row claims no remote copy, so its status and any sole-remote
   * authority binding clear in the same transaction. Outside the upload
   * machine on purpose, like repairStatus: exclusion is a custody event,
   * not an upload outcome. */
  markExcluded(photoId: string): void {
    const current = this.coverage(photoId);
    if (current === undefined) throw new LedgerTransitionError(`no ledger row for ${photoId}`);
    if (current.coverage !== 'excluding') throw new LedgerTransitionError(`illegal coverage transition ${current.coverage} → excluded`);
    run(
      this.db,
      "UPDATE sync_ledger SET coverage = 'excluded', status = 'local', custody_authority_id = NULL, dirty = 0, last_backup_at = NULL WHERE photo_id = ?",
      photoId,
    );
  }

  /** ADR-0033 §5: re-enabling is an ordinary dirty row — the engine's
   * verified upload does the rest. The status write is the machine's own
   * `local` (an excluded row never keeps a remote claim). */
  markIncluded(photoId: string, at: string): void {
    const current = this.coverage(photoId);
    if (current === undefined) throw new LedgerTransitionError(`no ledger row for ${photoId}`);
    if (current.coverage === 'included') return;
    run(
      this.db,
      "UPDATE sync_ledger SET coverage = 'included', coverage_origin = NULL, coverage_since = ?, status = 'local', dirty = 1 WHERE photo_id = ?",
      at,
      photoId,
    );
  }

  /** Latest stamp across the library — null before the first backup. */
  lastBackupAt(): string | null {
    return queryAll<{ at: string | null }>(this.db, 'SELECT max(last_backup_at) AS at FROM sync_ledger')[0]?.at ?? null;
  }
}
