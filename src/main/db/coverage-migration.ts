import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// 035 — backup coverage (#506, ADR-0033 §1/§2). A ledger row is `included`
// by default; `excluding` is the durable intermediate ADR-0033 §2 requires
// between "the user decided" and "the provider copy is gone"; `excluded`
// rows are local-only by choice. Automatic backup, pending counts and
// remote-presence reporting read only included rows — an excluded photo is
// not pending, not dirty-counted and not a remote-presence expectation.
// Independent local-custody verification still applies (#1135).
// `coverage_origin` records who decided (the user, the protected domain, or
// a provider that cannot hold the asset) and `coverage_since` when.
export function migrateBackupCoverage(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE sync_ledger ADD COLUMN coverage TEXT NOT NULL DEFAULT 'included'
      CHECK (coverage IN ('included', 'excluding', 'excluded'));
    ALTER TABLE sync_ledger ADD COLUMN coverage_origin TEXT
      CHECK (coverage_origin IS NULL OR coverage_origin IN ('user', 'protected-domain', 'provider-unsupported'));
    ALTER TABLE sync_ledger ADD COLUMN coverage_since TEXT;
    CREATE INDEX idx_sync_ledger_coverage ON sync_ledger (coverage) WHERE coverage <> 'included';
  `);
}
