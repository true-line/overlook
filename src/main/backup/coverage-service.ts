import { ProviderError, type StorageProvider } from './provider.js';
import type { SyncLedger } from './sync-ledger.js';
import { manifestBlobPath } from './backup-manifest-coverage.js';
import type { CoverageRow } from '../db/coverage-repository.js';
import { REMOVE_CLOUD_COPY_AUTHORIZATION } from '../../shared/destructive-actions.js';
import type { SyncStatus } from '../../shared/library/types.js';

// Backup coverage exceptions (#506, ADR-0033). "Keep on this device only"
// takes a row out of automatic backup in the ADR's §2 order: quiesce, prove
// local custody (a cloud-only original is downloaded and verified first),
// record the decision durably as `excluding`, publish a manifest generation
// that already says so, and only then remove the provider copy — through
// the engine, which calls settlePending() once the generation has landed.
// A failed removal leaves the row `excluding` ("removal pending"), audited
// as ORPHAN-REMOTE like a purge leftover, and is retried by later runs (§6).
// Re-enabling (§5) is an ordinary dirty row for the verified upload path.

const REMOTE_ATTEMPTS = 3;
const REMOTE_BACKOFF_MS = 500;

export type CoverageSkipReason =
  | 'not-found'
  | 'deleted'
  | 'already-excluded'
  | 'already-included'
  | 'in-flight'
  | 'provider-disconnected'
  | 'restore-failed'
  | 'local-missing'
  | 'local-corrupt';

export interface CoveragePreflightItem {
  readonly photoId: string;
  readonly bytes: number;
  readonly eligible: boolean;
  readonly reason: CoverageSkipReason | null;
  readonly remoteCopy: boolean;
  readonly download: boolean;
  readonly sharedRetained: boolean;
}

export interface CoveragePreflight {
  readonly tier: 'structural' | 'irreversible';
  readonly eligible: number;
  readonly ineligible: number;
  readonly bytes: number;
  readonly remoteCopies: number;
  readonly remoteBytes: number;
  readonly downloads: number;
  readonly sharedRetained: number;
  readonly provider: string | null;
  readonly account: string | null;
  readonly items: readonly CoveragePreflightItem[];
}

export interface CoverageExcludeResultItem {
  readonly photoId: string;
  readonly outcome: 'excluded' | 'removal-pending' | 'skipped' | 'failed';
  readonly reason: CoverageSkipReason | null;
}

export interface CoverageExcludeSummary {
  readonly excluded: number;
  readonly removalPending: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: readonly CoverageExcludeResultItem[];
}

export interface CoverageIncludeResultItem {
  readonly photoId: string;
  readonly outcome: 'included' | 'skipped' | 'failed';
  readonly reason: CoverageSkipReason | null;
}

export interface CoverageIncludeSummary {
  readonly included: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: readonly CoverageIncludeResultItem[];
}

export class CoverageAuthorizationError extends Error {
  override readonly name = 'CoverageAuthorizationError';
}

export interface CoverageDeps {
  readonly ledger: Pick<SyncLedger, 'coverage' | 'status' | 'markExcluding' | 'markExcluded' | 'markIncluded' | 'repairStatus'>;
  readonly repo: {
    readonly rows: (photoIds: readonly string[]) => readonly CoverageRow[];
    readonly excluding: () => readonly CoverageRow[];
    readonly includedReferences: (contentHash: string) => number;
    /** Companion custody hashes whose remote objects go with the original (#484). */
    readonly sidecarHashesForPhoto: (photoId: string) => readonly string[];
    readonly sidecarPathsForPhoto?: ((photoId: string) => readonly string[]) | undefined;
  };
  /** Keep downloaded / restoreOriginals: the verified download that proves local custody. */
  readonly restoreOriginals: (
    photoIds: readonly string[],
  ) => Promise<{ readonly results: readonly { photoId: string; outcome: string }[] }>;
  readonly hasLocalOriginal: (contentHash: string) => boolean;
  /** The provider holding the row's copy — its custody authority when bound. */
  readonly remoteProvider: (photoId: string) => Promise<StorageProvider>;
  readonly providerConnected: () => boolean;
  readonly providerIdentity: () => Promise<{ readonly provider: string | null; readonly account: string | null }>;
  /** The manifest must record the exclusion before any provider delete. */
  readonly oweManifest: () => void;
  readonly runBackup: () => Promise<unknown>;
  readonly syncStateChanged: (updates: readonly { readonly id: string; readonly syncState: SyncStatus }[]) => void;
  readonly libraryChanged: (photoIds: readonly string[]) => void;
  readonly storageChanged: () => void;
  readonly audit: (line: string) => void;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
}

/** A row the provider holds a copy of: verified, cloud-only, or a clean
 * integrity error whose claim is still remote. */
function claimsRemoteCopy(row: CoverageRow): boolean {
  return row.status === 'synced' || row.status === 'offloaded' || (row.status === 'error' && !row.dirty);
}

export class CoverageService {
  constructor(private readonly deps: CoverageDeps) {}

  async preflight(photoIds: readonly string[]): Promise<CoveragePreflight> {
    const ids = [...new Set(photoIds)];
    const rows = new Map(this.deps.repo.rows(ids).map((row) => [row.id, row]));
    const requested = new Map<string, number>();
    for (const row of rows.values()) requested.set(row.contentHash, (requested.get(row.contentHash) ?? 0) + 1);
    const connected = this.deps.providerConnected();
    const items = ids.map((photoId): CoveragePreflightItem => {
      const row = rows.get(photoId);
      const base = { photoId, bytes: row?.bytes ?? 0, remoteCopy: false, download: false, sharedRetained: false };
      if (row === undefined) return { ...base, eligible: false, reason: 'not-found' };
      if (row.deleted) return { ...base, eligible: false, reason: 'deleted' };
      if (row.coverage !== 'included') return { ...base, eligible: false, reason: 'already-excluded' };
      if (row.status === 'syncing') return { ...base, eligible: false, reason: 'in-flight' };
      const remoteCopy = claimsRemoteCopy(row);
      const download = row.status === 'offloaded';
      // §3: siblings outside this request keep the asset's remote object.
      const sharedRetained = remoteCopy && this.deps.repo.includedReferences(row.contentHash) - (requested.get(row.contentHash) ?? 0) > 0;
      if (remoteCopy && !connected)
        return { ...base, remoteCopy, download, sharedRetained, eligible: false, reason: 'provider-disconnected' };
      return { ...base, remoteCopy, download, sharedRetained, eligible: true, reason: null };
    });
    const eligible = items.filter((item) => item.eligible);
    const removals = eligible.filter((item) => item.remoteCopy && !item.sharedRetained);
    const identity = await this.deps.providerIdentity();
    return {
      // §7: removing any provider copy is Tier D; otherwise the row merely
      // stops being backed up, which is structural (Tier M).
      tier: removals.length > 0 ? 'irreversible' : 'structural',
      eligible: eligible.length,
      ineligible: items.length - eligible.length,
      bytes: eligible.reduce((sum, item) => sum + item.bytes, 0),
      remoteCopies: removals.length,
      remoteBytes: removals.reduce((sum, item) => sum + item.bytes, 0),
      downloads: eligible.filter((item) => item.download).length,
      sharedRetained: eligible.filter((item) => item.sharedRetained).length,
      provider: identity.provider,
      account: identity.account,
      items,
    };
  }

  async exclude(photoIds: readonly string[], authorization?: string): Promise<CoverageExcludeSummary> {
    const plan = await this.preflight(photoIds);
    if (plan.tier === 'irreversible' && authorization !== REMOVE_CLOUD_COPY_AUTHORIZATION) {
      throw new CoverageAuthorizationError('removing a cloud copy requires the Remove cloud copy authorization');
    }
    const results: CoverageExcludeResultItem[] = [];
    const eligible: CoveragePreflightItem[] = [];
    for (const item of plan.items) {
      if (item.eligible) eligible.push(item);
      else results.push({ photoId: item.photoId, outcome: 'skipped', reason: item.reason });
    }
    // §2 local custody first: a cloud-only original is downloaded, verified
    // and promoted before the decision is recorded; a failed download
    // leaves the row exactly as it was.
    const failedDownloads = new Set<string>();
    const downloads = eligible.filter((item) => item.download).map((item) => item.photoId);
    if (downloads.length > 0) {
      const restored = await this.deps.restoreOriginals(downloads);
      for (const result of restored.results) {
        if (result.outcome !== 'restored') failedDownloads.add(result.photoId);
      }
    }
    const marked: CoveragePreflightItem[] = [];
    const at = this.deps.now();
    for (const item of eligible) {
      if (failedDownloads.has(item.photoId)) {
        results.push({ photoId: item.photoId, outcome: 'failed', reason: 'restore-failed' });
        continue;
      }
      const row = this.deps.repo.rows([item.photoId])[0];
      if (row === undefined || !this.deps.hasLocalOriginal(row.contentHash)) {
        results.push({ photoId: item.photoId, outcome: 'failed', reason: 'local-missing' });
        continue;
      }
      // Manifest debt is durable BEFORE the first row is marked: a process
      // that dies between the two would otherwise leave an `excluding` row
      // with no debt, and the next run would settle it — deleting the
      // provider object the newest manifest still describes (PR #1124
      // review). A spare generation is the harmless failure.
      if (marked.length === 0) this.deps.oweManifest();
      this.deps.ledger.markExcluding(item.photoId, 'user', at);
      this.deps.audit(`COVERAGE-EXCLUDING photo=${item.photoId} hash=${row.contentHash} remote=${item.remoteCopy ? 'yes' : 'no'}`);
      marked.push(item);
    }
    if (marked.length > 0) {
      // Rows without a provider copy settle here; the manifest is still
      // owed a generation because their records changed shape.
      for (const item of marked) {
        if (!item.remoteCopy) this.deps.ledger.markExcluded(item.photoId);
      }
      if (marked.some((item) => item.remoteCopy)) {
        // The engine publishes the recording generation and then calls
        // settlePending() — the only path that touches the provider.
        await this.deps.runBackup().catch(() => undefined);
      } else {
        void this.deps.runBackup().catch(() => undefined);
      }
    }
    let excluded = 0;
    let removalPending = 0;
    for (const item of marked) {
      const coverage = this.deps.ledger.coverage(item.photoId)?.coverage;
      if (coverage === 'excluded') {
        excluded += 1;
        results.push({ photoId: item.photoId, outcome: 'excluded', reason: null });
      } else {
        removalPending += 1;
        results.push({ photoId: item.photoId, outcome: 'removal-pending', reason: null });
      }
    }
    this.notify(marked.map((item) => item.photoId));
    return {
      excluded,
      removalPending,
      skipped: results.filter((result) => result.outcome === 'skipped').length,
      failed: results.filter((result) => result.outcome === 'failed').length,
      results,
    };
  }

  /** Called by the engine after a manifest generation recording the
   * exclusions has landed. Removes each pending row's provider objects —
   * not-found is success, transient failures retry with backoff — and
   * retains the object when an included sibling still needs it (§3). */
  async settlePending(): Promise<{ readonly settled: number; readonly pending: number }> {
    let settled = 0;
    let pending = 0;
    for (const row of this.deps.repo.excluding()) {
      if (!claimsRemoteCopy(row)) {
        this.deps.ledger.markExcluded(row.id);
        settled += 1;
        continue;
      }
      const references = this.deps.repo.includedReferences(row.contentHash);
      if (references > 0) {
        this.deps.audit(`COVERAGE-SHARED-RETAINED photo=${row.id} hash=${row.contentHash} references=${String(references)}`);
        this.deps.ledger.markExcluded(row.id);
        settled += 1;
        continue;
      }
      const paths = [
        manifestBlobPath(row.contentHash),
        ...(this.deps.repo.sidecarPathsForPhoto?.(row.id) ??
          this.deps.repo.sidecarHashesForPhoto(row.id).map((hash) => `sidecars/${row.id}/${hash}`)),
      ];
      let failures = 0;
      for (const path of paths) {
        if (!(await this.deleteRemote(row.id, row.contentHash, path))) failures += 1;
      }
      if (failures === 0) {
        this.deps.ledger.markExcluded(row.id);
        this.deps.audit(`COVERAGE-EXCLUDED photo=${row.id} hash=${row.contentHash}`);
        settled += 1;
      } else {
        pending += 1;
      }
    }
    if (settled > 0) this.deps.storageChanged();
    return { settled, pending };
  }

  include(photoIds: readonly string[]): Promise<CoverageIncludeSummary> {
    const ids = [...new Set(photoIds)];
    const rows = new Map(this.deps.repo.rows(ids).map((row) => [row.id, row]));
    const results: CoverageIncludeResultItem[] = [];
    const changed: string[] = [];
    const at = this.deps.now();
    for (const photoId of ids) {
      const row = rows.get(photoId);
      if (row === undefined) {
        results.push({ photoId, outcome: 'skipped', reason: 'not-found' });
      } else if (row.deleted) {
        results.push({ photoId, outcome: 'skipped', reason: 'deleted' });
      } else if (row.coverage === 'included') {
        results.push({ photoId, outcome: 'skipped', reason: 'already-included' });
      } else if (row.coverage === 'excluding') {
        // The removal is still owed; re-enabling would race it (§6).
        results.push({ photoId, outcome: 'skipped', reason: 'in-flight' });
      } else if (row.localCustodyFailure != null) {
        // A known failed original cannot become an upload merely because its
        // file exists. Keep the exclusion until an authenticated recheck heals it.
        this.deps.audit(`COVERAGE-INCLUDE-FAILED photo=${photoId} reason=${row.localCustodyFailure}`);
        results.push({ photoId, outcome: 'failed', reason: row.localCustodyFailure });
      } else if (!this.deps.hasLocalOriginal(row.contentHash)) {
        // §5 fail closed: without a local original there is nothing to
        // upload, and the row must not pretend otherwise.
        this.deps.ledger.markIncluded(photoId, at);
        this.deps.ledger.repairStatus(photoId, 'error');
        this.deps.audit(`COVERAGE-INCLUDE-FAILED photo=${photoId} hash=${row.contentHash} reason=local-missing`);
        changed.push(photoId);
        results.push({ photoId, outcome: 'failed', reason: 'local-missing' });
      } else {
        this.deps.ledger.markIncluded(photoId, at);
        this.deps.audit(`COVERAGE-INCLUDED photo=${photoId} hash=${row.contentHash}`);
        changed.push(photoId);
        results.push({ photoId, outcome: 'included', reason: null });
      }
    }
    if (changed.length > 0) {
      this.notify(changed);
      // The ordinary verified upload does the rest; the run reports itself.
      void this.deps.runBackup().catch(() => undefined);
    }
    return Promise.resolve({
      included: results.filter((result) => result.outcome === 'included').length,
      skipped: results.filter((result) => result.outcome === 'skipped').length,
      failed: results.filter((result) => result.outcome === 'failed').length,
      results,
    });
  }

  private notify(photoIds: readonly string[]): void {
    if (photoIds.length === 0) return;
    this.deps.syncStateChanged(photoIds.map((id) => ({ id, syncState: this.deps.ledger.status(id) ?? 'local' })));
    this.deps.libraryChanged(photoIds);
    this.deps.storageChanged();
  }

  private async deleteRemote(photoId: string, contentHash: string, remotePath: string): Promise<boolean> {
    let provider: StorageProvider;
    try {
      provider = await this.deps.remoteProvider(photoId);
    } catch (error) {
      this.deps.audit(
        `ORPHAN-REMOTE photo=${photoId} hash=${contentHash} path=${remotePath} reason=${error instanceof Error ? error.message : 'custody-unavailable'}`,
      );
      return false;
    }
    for (let attempt = 1; attempt <= REMOTE_ATTEMPTS; attempt += 1) {
      try {
        await provider.delete(remotePath);
        return true;
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'not-found') return true;
        if (attempt === REMOTE_ATTEMPTS) {
          const reason = error instanceof Error ? error.message : String(error);
          this.deps.audit(`ORPHAN-REMOTE photo=${photoId} hash=${contentHash} path=${remotePath} reason=${reason}`);
          return false;
        }
        await this.deps.sleep(REMOTE_BACKOFF_MS * attempt);
      }
    }
    return false;
  }
}
