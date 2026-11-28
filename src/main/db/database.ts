import Database from 'better-sqlite3-multiple-ciphers';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { migrate } from './migrations.js';
import { configureEmbeddingVectorSchema, loadVectorExtension, vectorExtensionSupported } from './vector-extension.js';

// Library database per ADR-0004 (whole-DB SQLCipher) + ADR-0005 (#69). The
// DB key arrives as bytes (wrapped/unwrapped by #68's KeyStore at
// integration) — hex-encoded into SQLCipher's raw-key pragma form.

export interface OpenLibraryOptions {
  readonly path: string;
  /** 32-byte DB key; the module never sees the master key. */
  readonly dbKey: Buffer;
}

export class LibraryDatabaseError extends Error {
  override readonly name = 'LibraryDatabaseError';
}

export function openLibraryDatabase(options: OpenLibraryOptions): BetterSqlite3.Database {
  if (options.dbKey.length !== 32) {
    throw new LibraryDatabaseError(`DB key must be 32 bytes, got ${String(options.dbKey.length)}`);
  }
  const db = new Database(options.path);
  try {
    db.pragma(`cipher='sqlcipher'`);
    // SQLCipher raw-key form skips its internal KDF — the key is already
    // high-entropy material from the key hierarchy, not a password.
    db.pragma(`key="x'${options.dbKey.toString('hex')}'"`);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // 256 MiB page cache (negative = KiB), allocated on demand. The hosted
    // 200K SQL probe (#1221) found repeated AES/HMAC work below this size;
    // 512 MiB gave no further benefit. Connection close still releases it.
    db.pragma('cache_size = -262144');
    // Fails here (not on first query) when the key is wrong.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    // ADR-0018: vec0 tables share the SQLCipher connection and therefore the
    // library's page-level encryption, WAL, and lifecycle boundary. The pinned
    // upstream package has no Windows ARM64 binary; that target keeps ordinary
    // library access while the semantic feature reports unavailable.
    const embeddingVectorsAvailable = vectorExtensionSupported();
    if (embeddingVectorsAvailable) loadVectorExtension(db);
    migrate(db);
    configureEmbeddingVectorSchema(db, embeddingVectorsAvailable);
    return db;
  } catch (error) {
    db.close();
    if (error instanceof Error && /file is not a database/i.test(error.message)) {
      throw new LibraryDatabaseError('the library database could not be unlocked with this key');
    }
    throw error;
  }
}
