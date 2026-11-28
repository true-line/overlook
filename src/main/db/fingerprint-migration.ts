import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// 034 — perceptual fingerprints (#650). Recomputable index metadata over the
// photo's own mid derivative, one row per photo: either the four rotation
// hashes or a deferral reason, never both. Freshness is judged against the
// row's derivative key and content hash (a Duplicate's own key, #496) plus
// the algorithm version, so a re-imported or re-keyed photo is re-indexed
// and an algorithm change requeues the library. The row dies with the photo
// (cascade) and is never part of the backup manifest — it is derived data in
// the ADR-0034 §6 sense, rebuilt from photos the manifest already carries.
export function migratePerceptualFingerprints(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE photo_fingerprints (
      photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      derivative_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      algo_version TEXT NOT NULL,
      hash_0 TEXT,
      hash_90 TEXT,
      hash_180 TEXT,
      hash_270 TEXT,
      deferred_reason TEXT CHECK (deferred_reason IN ('derivative-unavailable', 'undecodable')),
      computed_at TEXT NOT NULL,
      CHECK (
        (hash_0 IS NOT NULL AND hash_90 IS NOT NULL AND hash_180 IS NOT NULL AND hash_270 IS NOT NULL AND deferred_reason IS NULL)
        OR (hash_0 IS NULL AND hash_90 IS NULL AND hash_180 IS NULL AND hash_270 IS NULL AND deferred_reason IS NOT NULL)
      )
    ) WITHOUT ROWID;
    CREATE INDEX idx_photo_fingerprints_algo ON photo_fingerprints (algo_version, deferred_reason);
  `);
}

/** #1221: let the batch LIMIT stop an import-ordered index walk instead of
 * scanning/sorting the wide photo table for every 64 pending candidates. */
export function migrateFingerprintCandidateIndex(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE INDEX idx_photos_fingerprint_pending
      ON photos (imported_at, id, derivative_key, content_hash, deleted_at)
      WHERE deleted_at IS NULL;
  `);
}
