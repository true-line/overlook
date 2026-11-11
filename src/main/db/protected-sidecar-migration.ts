import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** Protected companions (#1429): widens protected_remote_objects.kind to
 * opaque `sidecar.<hmac>` entries and records precomputed target sidecar
 * refs in migration items while the target album key is open. */
export function migrateProtectedSidecarCustody(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE protected_remote_objects_v48 (
      photo_id TEXT NOT NULL REFERENCES protected_photo_records (photo_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('original', 'thumb', 'mid') OR
        (length(kind) = 72 AND substr(kind, 1, 8) = 'sidecar.' AND substr(kind, 9) NOT GLOB '*[^0-9a-f]*')
      ),
      status TEXT NOT NULL DEFAULT 'local' CHECK (status IN ('local', 'synced', 'offloaded', 'error')),
      dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
      ciphertext_sha256 TEXT CHECK (
        ciphertext_sha256 IS NULL OR
        (length(ciphertext_sha256) = 64 AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*')
      ),
      ciphertext_bytes INTEGER CHECK (ciphertext_bytes IS NULL OR ciphertext_bytes >= 0),
      last_backup_at TEXT,
      PRIMARY KEY (photo_id, kind),
      CHECK (
        (ciphertext_sha256 IS NULL AND ciphertext_bytes IS NULL) OR
        (ciphertext_sha256 IS NOT NULL AND ciphertext_bytes IS NOT NULL)
      )
    ) WITHOUT ROWID;

    INSERT INTO protected_remote_objects_v48 (
      photo_id, kind, status, dirty, ciphertext_sha256, ciphertext_bytes, last_backup_at
    )
    SELECT photo_id, kind, status, dirty, ciphertext_sha256, ciphertext_bytes, last_backup_at
      FROM protected_remote_objects;

    DROP TABLE protected_remote_objects;
    ALTER TABLE protected_remote_objects_v48 RENAME TO protected_remote_objects;
    CREATE INDEX idx_protected_remote_status ON protected_remote_objects (status, dirty, photo_id, kind);

    ALTER TABLE protected_photo_migration_items
      ADD COLUMN target_sidecar_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_sidecar_refs_json));
  `);
}
