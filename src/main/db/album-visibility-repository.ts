import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { AlbumListing } from '../../shared/library/types.js';
import { readSmartAlbums, smartAlbumCounts } from './smart-album-queries.js';
import { queryAll, queryGet, runNamed } from './sql.js';

// Collection visibility in All Photos (#494, ADR-0030 §2/§6). The per-photo
// `in_all_photos` flag is denormalized composition state: it is written in the
// same transaction as every membership or policy change that can move it, and
// a sweep rebuilds it from the rows it summarizes — the flag is never
// authoritative over them.

/** §2/§6 composition, evaluated for the row aliased `p`. */
export const IN_ALL_PHOTOS_EXPR = `(
  NOT EXISTS (SELECT 1 FROM album_photos m WHERE m.photo_id = p.id)
  OR EXISTS (
    SELECT 1 FROM album_photos m JOIN albums a ON a.id = m.album_id
     WHERE m.photo_id = p.id AND a.show_in_all_photos = 1
  )
)`;

/** Re-derives the flag for the given photos. Call inside the transaction
 * that changed their memberships or a containing album's policy. */
export function refreshInAllPhotos(db: BetterSqlite3.Database, photoIds: Iterable<string>): void {
  for (const photoId of photoIds) {
    runNamed(db, `UPDATE photos AS p SET in_all_photos = ${IN_ALL_PHOTOS_EXPR} WHERE p.id = @photoId`, { photoId });
  }
}

/** Re-derives the flag for every member of one album. */
export function refreshAlbumMembersInAllPhotos(db: BetterSqlite3.Database, albumId: string): void {
  runNamed(
    db,
    `UPDATE photos AS p SET in_all_photos = ${IN_ALL_PHOTOS_EXPR}
      WHERE p.id IN (SELECT photo_id FROM album_photos WHERE album_id = @albumId)`,
    { albumId },
  );
}

export interface AllPhotosFlagVerification {
  /** Rows whose stored flag disagreed with their memberships before the rebuild. */
  readonly mismatched: number;
  readonly rebuilt: boolean;
}

/** Counts rows whose flag disagrees with §2 and rewrites exactly those rows
 * (ADR-0030 §6: a detected mismatch rebuilds the flag rather than being
 * trusted). Runs at startup and after every restore. */
export function verifyInAllPhotos(db: BetterSqlite3.Database): AllPhotosFlagVerification {
  return db.transaction(() => {
    const changes = db
      .prepare(`UPDATE photos AS p SET in_all_photos = ${IN_ALL_PHOTOS_EXPR} WHERE p.in_all_photos != ${IN_ALL_PHOTOS_EXPR}`)
      .run().changes;
    return { mismatched: changes, rebuilt: changes > 0 };
  })();
}

/** Microtask-deferred for StartupMaintenance, which only catches rejections. */
export function verifyInAllPhotosAsync(db: BetterSqlite3.Database): Promise<AllPhotosFlagVerification> {
  return Promise.resolve().then(() => verifyInAllPhotos(db));
}

/** Albums (not folders — those carry their policy in the manifest's folder
 * list) whose effective policy hides them from All Photos. */
export function readHiddenAlbumIds(db: BetterSqlite3.Database): string[] {
  return queryAll<{ id: string }>(db, `SELECT id FROM albums WHERE show_in_all_photos = 0 AND kind = 'album' ORDER BY position, id`).map(
    ({ id }) => id,
  );
}

/** Sets one album's policy and re-derives its members' flags in the same
 * transaction. Returns the members whose All Photos membership changed. */
export function writeAlbumVisibility(db: BetterSqlite3.Database, albumId: string, showInAllPhotos: boolean): string[] {
  return db.transaction(() => {
    const updated = queryGet<{ id: string }>(db, 'UPDATE albums SET show_in_all_photos = @show WHERE id = @albumId RETURNING id', {
      albumId,
      show: showInAllPhotos ? 1 : 0,
    });
    if (updated === undefined) throw new Error(`album ${albumId} does not exist`);
    const before = queryAll<{ id: string; flag: number }>(
      db,
      'SELECT p.id, p.in_all_photos AS flag FROM photos p WHERE p.id IN (SELECT photo_id FROM album_photos WHERE album_id = @albumId)',
      { albumId },
    );
    refreshAlbumMembersInAllPhotos(db, albumId);
    const after = new Map(
      queryAll<{ id: string; flag: number }>(
        db,
        'SELECT p.id, p.in_all_photos AS flag FROM photos p WHERE p.id IN (SELECT photo_id FROM album_photos WHERE album_id = @albumId)',
        { albumId },
      ).map((row) => [row.id, row.flag]),
    );
    return before.filter((row) => after.get(row.id) !== row.flag).map((row) => row.id);
  })();
}

/** Sidebar listing with the §2 disclosure: `visibleElsewhere` is how many of
 * the album's photos another visible album keeps in All Photos, and
 * `visibleVia` names those albums so the toggle can offer to reach them. */
export function readAlbumListings(db: BetterSqlite3.Database): AlbumListing[] {
  const rows = queryAll<{
    id: string;
    name: string;
    show: number;
    n: number;
    elsewhere: number;
    kind: 'album' | 'folder' | 'smart';
    parentId: string | null;
    inherits: number;
  }>(
    db,
    `SELECT a.id, a.name, a.show_in_all_photos AS show, a.kind, a.parent_id AS parentId, a.inherits_visibility AS inherits,
            count(ap.photo_id) AS n,
            count(ap.photo_id) FILTER (WHERE EXISTS (
              SELECT 1 FROM album_photos o JOIN albums oa ON oa.id = o.album_id
               WHERE o.photo_id = ap.photo_id AND o.album_id != a.id AND oa.show_in_all_photos = 1
            )) AS elsewhere
       FROM albums a
       LEFT JOIN album_photos ap
         ON ap.album_id = a.id
        AND ap.photo_id IN (SELECT id FROM ordinary_visible_photos)
       GROUP BY a.id ORDER BY a.position, a.id`,
  );
  // A folder counts the distinct photos of every album beneath it (#505).
  const folderCounts = new Map(
    queryAll<{ id: string; n: number }>(
      db,
      `WITH RECURSIVE tree(root, id) AS (
         SELECT id, id FROM albums WHERE kind = 'folder'
         UNION ALL SELECT tree.root, a.id FROM albums a JOIN tree ON a.parent_id = tree.id
       )
       SELECT tree.root AS id, count(DISTINCT ap.photo_id) AS n
         FROM tree JOIN album_photos ap ON ap.album_id = tree.id
        WHERE ap.photo_id IN (SELECT id FROM ordinary_visible_photos)
        GROUP BY tree.root`,
    ).map((row) => [row.id, row.n]),
  );
  const tags = new Map<string, string[]>();
  for (const row of queryAll<{ albumId: string; name: string }>(
    db,
    `SELECT l.album_id AS albumId, t.name FROM album_tag_links l JOIN album_tags t ON t.id = l.tag_id ORDER BY t.name COLLATE NOCASE`,
  )) {
    tags.set(row.albumId, [...(tags.get(row.albumId) ?? []), row.name]);
  }
  // A Smart Album's count is its predicate evaluated now (#514, §6) — never
  // stored membership; an unsupported one counts 0 and says why.
  const smart = readSmartAlbums(db);
  const smartCounts = smartAlbumCounts(db, smart);
  const via = queryAll<{ albumId: string; id: string; name: string }>(
    db,
    `SELECT DISTINCT ap.album_id AS albumId, oa.id, oa.name, oa.position
       FROM album_photos ap
       JOIN album_photos o ON o.photo_id = ap.photo_id AND o.album_id != ap.album_id
       JOIN albums oa ON oa.id = o.album_id AND oa.show_in_all_photos = 1
       JOIN albums a ON a.id = ap.album_id AND a.show_in_all_photos = 0
      WHERE ap.photo_id IN (SELECT id FROM ordinary_visible_photos)
      ORDER BY oa.position, oa.id`,
  );
  const viaByAlbum = new Map<string, { id: string; name: string }[]>();
  for (const row of via) {
    const list = viaByAlbum.get(row.albumId) ?? [];
    list.push({ id: row.id, name: row.name });
    viaByAlbum.set(row.albumId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    count: row.kind === 'folder' ? (folderCounts.get(row.id) ?? 0) : row.kind === 'smart' ? (smartCounts.get(row.id) ?? 0) : row.n,
    showInAllPhotos: row.show === 1,
    visibleElsewhere: row.elsewhere,
    visibleVia: viaByAlbum.get(row.id) ?? [],
    kind: row.kind,
    parentId: row.parentId,
    inheritsVisibility: row.inherits === 1,
    tags: tags.get(row.id) ?? [],
    predicate: smart.get(row.id)?.predicate ?? null,
    unsupported: smart.get(row.id)?.unsupported ?? null,
  }));
}
