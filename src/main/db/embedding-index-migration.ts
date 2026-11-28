import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** #1221: eligibility/counts need only these columns, not each wide photo row.
 * Keep deleted_at in the keys as well as the predicate so SQLite recognizes
 * the partial index as covering for the ordinary-photo view. */
export function migrateEmbeddingEligibilityIndex(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE INDEX idx_photos_embedding_eligibility
      ON photos (id, content_hash, in_all_photos, deleted_at)
      WHERE deleted_at IS NULL;
  `);
}
