import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** Secondary index on `album_photos(photo_id)` (#1439): `PRIMARY KEY (album_id, photo_id)`
 * cannot serve `WHERE photo_id = ?` membership/disclosure lookups or `ON DELETE CASCADE`
 * checks when deleting photos without scanning `album_photos`. */
export function migrateAlbumPhotosPhotoIndex(db: BetterSqlite3.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_album_photos_photo ON album_photos (photo_id);`);
}
