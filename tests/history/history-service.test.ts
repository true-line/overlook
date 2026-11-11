import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createActivityFacade, mutateWithActivity } from '../../src/main/activity/activity-publication.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { run } from '../../src/main/db/sql.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { HistoryService } from '../../src/main/history/history-service.js';
import { boardLayoutCommand, favoritesCommand } from '../../src/main/history/command-drafts.js';
import { LibraryService } from '../../src/main/library/library-service.js';
import { serializeBoard, type Board } from '../../src/shared/moodboard/board.js';

function world(onTrash?: () => void) {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-undo-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'w', ?)`, '2026-07-21T00:00:00.000Z');
  const repo = new PhotosRepository(db);
  for (const id of ['photo-one', 'photo-two']) {
    repo.insert({
      id,
      fileName: `${id}.jpg`,
      fileKind: 'jpeg',
      width: 10,
      height: 10,
      bytes: 100,
      contentHash: id.padEnd(64, '0'),
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: null,
      gpsLon: null,
      place: null,
      importedAt: '2026-07-21T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    });
  }
  const service = new LibraryService(db, { libraryChanged: () => undefined, pendingCountChanged: () => undefined });
  const activity = createActivityFacade(db, () => undefined);
  return { db, service, activity, history: new HistoryService(db, service, undefined, onTrash) };
}

describe('HistoryService (#615, ADR-0025)', () => {
  test('undoes and redoes favorites durably and idempotently', async () => {
    const state = world();
    mutateWithActivity(
      () => state.activity,
      () => state.service.toggleFavorite('photo-one'),
      (result) => ({
        eventType: 'photo.favorite-changed',
        entityIds: ['photo-one'],
        outcome: 'succeeded',
        payload: { favorite: result.favorite },
      }),
      (result) => ({
        commandId: 'photo.favorite.toggle',
        classification: 'immediately-reversible',
        inverse: { kind: 'favorite', photoId: 'photo-one', before: !result.favorite, after: result.favorite },
      }),
    );
    assert.equal(state.service.favoriteState('photo-one'), true);
    const undone = await state.history.undo('undo-favorite');
    assert.equal(undone.applied, true);
    assert.equal(state.service.favoriteState('photo-one'), false);
    assert.deepEqual(await new HistoryService(state.db, state.service).undo('undo-favorite'), undone);
    assert.equal((await state.history.redo('redo-favorite')).applied, true);
    assert.equal(state.service.favoriteState('photo-one'), true);
    state.db.close();
  });

  test('undoes and redoes a bulk favorite mutation as one command', async () => {
    const state = world();
    state.service.toggleFavorite('photo-two');
    mutateWithActivity(
      () => state.activity,
      () => state.service.toggleFavorites(['photo-one', 'photo-two']),
      (result) => ({
        eventType: 'photo.favorite-changed',
        entityIds: result.changes.map(({ id }) => id),
        outcome: 'succeeded',
      }),
      (result) => favoritesCommand(result.changes),
    );
    assert.equal(state.service.favoriteState('photo-one'), true);
    assert.equal(state.service.favoriteState('photo-two'), false);
    assert.equal((await state.history.undo('undo-bulk-favorite')).applied, true);
    assert.equal(state.service.favoriteState('photo-one'), false);
    assert.equal(state.service.favoriteState('photo-two'), true);
    assert.equal((await state.history.redo('redo-bulk-favorite')).applied, true);
    assert.equal(state.service.favoriteState('photo-one'), true);
    assert.equal(state.service.favoriteState('photo-two'), false);
    state.db.close();
  });

  test('preserves exact album membership and Trash mutation sets', async () => {
    const state = world();
    state.service.createAlbum('album-one', 'One');
    state.service.addToAlbum('album-one', ['photo-one']);
    mutateWithActivity(
      () => state.activity,
      () => state.service.addToAlbum('album-one', ['photo-one', 'photo-two']),
      (result) => ({ eventType: 'album.membership-added', outcome: 'succeeded', payload: { count: result.added } }),
      (result) => ({
        commandId: 'album.membership.add',
        classification: 'immediately-reversible',
        inverse: {
          kind: 'album-membership',
          albumId: 'album-one',
          photoIds: result.changedPhotoIds,
          before: 'absent',
          after: 'present',
        },
      }),
    );
    await state.history.undo('undo-album');
    assert.equal(state.service.albumMembership('album-one', ['photo-one'])?.get('photo-one'), true, 'preexisting membership remains');
    assert.equal(state.service.albumMembership('album-one', ['photo-two'])?.get('photo-two'), false);

    mutateWithActivity(
      () => state.activity,
      () => state.service.deletePhotos(['photo-one', 'photo-two']),
      (result) => ({ eventType: 'photo.trashed', outcome: 'succeeded', payload: { count: result.deleted } }),
      (result) => ({
        commandId: 'photo.trash',
        classification: 'conditionally-reversible',
        inverse: { kind: 'trash', photoIds: result.changedPhotoIds, before: 'live', after: 'trashed' },
      }),
    );
    await state.history.undo('undo-trash');
    assert.deepEqual([...state.service.trashState(['photo-one', 'photo-two']).values()], ['live', 'live']);
    state.db.close();
  });

  test('undoes and redoes one committed album order and marks manifest debt (#225)', async () => {
    let manifestDebts = 0;
    const state = world(() => {
      manifestDebts += 1;
    });
    state.service.createAlbum('album-one', 'One');
    state.service.createAlbum('album-two', 'Two');
    state.service.createAlbum('album-three', 'Three');
    mutateWithActivity(
      () => state.activity,
      () => state.service.reorderAlbum('album-three', 0),
      () => ({ eventType: 'album.reordered', entityIds: ['album-three'], outcome: 'succeeded' }),
      (result) => ({
        commandId: 'album.reorder.top',
        classification: 'immediately-reversible',
        inverse: {
          kind: 'album-order',
          albumId: 'album-three',
          before: result.before,
          after: result.after,
        },
      }),
    );
    assert.deepEqual(state.service.albumOrder(), ['album-three', 'album-one', 'album-two']);

    assert.equal((await state.history.undo('undo-album-order')).applied, true);
    assert.deepEqual(state.service.albumOrder(), ['album-one', 'album-two', 'album-three']);
    assert.equal((await state.history.redo('redo-album-order')).applied, true);
    assert.deepEqual(state.service.albumOrder(), ['album-three', 'album-one', 'album-two']);
    assert.equal(manifestDebts, 2, 'undo and redo both refresh the manifest, including empty albums');
    state.db.close();
  });

  test('fails closed when a recorded resource disappears', async () => {
    const state = world();
    mutateWithActivity(
      () => state.activity,
      () => state.service.toggleFavorite('photo-one'),
      () => ({ eventType: 'photo.favorite-changed', outcome: 'succeeded' }),
      () => ({
        commandId: 'photo.favorite.toggle',
        classification: 'immediately-reversible',
        inverse: { kind: 'favorite', photoId: 'photo-one', before: false, after: true },
      }),
    );
    run(state.db, 'DELETE FROM photos WHERE id = ?', 'photo-one');
    const result = await state.history.undo('missing-photo');
    assert.equal(result.applied, false);
    assert.equal(result.capability.reason, 'resource-missing');
    state.db.close();
  });

  test('reports a deleted album as missing instead of consuming its command', async () => {
    const state = world();
    state.service.createAlbum('album-one', 'One');
    mutateWithActivity(
      () => state.activity,
      () => state.service.addToAlbum('album-one', ['photo-one']),
      () => ({ eventType: 'album.membership-added', outcome: 'succeeded' }),
      () => ({
        commandId: 'album.membership.add',
        classification: 'immediately-reversible',
        inverse: { kind: 'album-membership', albumId: 'album-one', photoIds: ['photo-one'], before: 'absent', after: 'present' },
      }),
    );
    state.service.deleteAlbum('album-one');
    const result = await state.history.undo('deleted-album');
    assert.equal(result.applied, false);
    assert.equal(result.capability.reason, 'resource-missing');
    state.db.close();
  });

  test('marks manifest debt on Undo/Redo of Trash, favorite, favorites, and album-membership (#1437)', async () => {
    let manifestDebts = 0;
    const state = world(() => {
      manifestDebts += 1;
    });
    mutateWithActivity(
      () => state.activity,
      () => state.service.deletePhotos(['photo-one']),
      () => ({ eventType: 'photo.trashed', outcome: 'succeeded' }),
      (result) => ({
        commandId: 'photo.trash',
        classification: 'conditionally-reversible',
        inverse: { kind: 'trash', photoIds: result.changedPhotoIds, before: 'live', after: 'trashed' },
      }),
    );
    await state.history.undo('restore-photo');
    assert.equal(manifestDebts, 1);
    await state.history.redo('retrash-photo');
    assert.equal(manifestDebts, 2);
    await state.history.undo('restore-photo-again');
    assert.equal(manifestDebts, 3);

    mutateWithActivity(
      () => state.activity,
      () => state.service.toggleFavorite('photo-one'),
      (result) => ({ eventType: 'photo.favorite-changed', outcome: 'succeeded', payload: { favorite: result.favorite } }),
      (result) => ({
        commandId: 'photo.favorite.toggle',
        classification: 'immediately-reversible',
        inverse: { kind: 'favorite', photoId: 'photo-one', before: !result.favorite, after: result.favorite },
      }),
    );
    await state.history.undo('undo-fav-manifest');
    await state.history.redo('redo-fav-manifest');
    assert.equal(manifestDebts, 5);

    mutateWithActivity(
      () => state.activity,
      () => state.service.toggleFavorites(['photo-one', 'photo-two']),
      (result) => ({ eventType: 'photo.favorite-changed', outcome: 'succeeded', payload: { count: result.updated } }),
      (result) => favoritesCommand(result.changes),
    );
    await state.history.undo('undo-favs-manifest');
    await state.history.redo('redo-favs-manifest');
    assert.equal(manifestDebts, 7);

    state.service.createAlbum('album-manifest', 'Manifest');
    mutateWithActivity(
      () => state.activity,
      () => state.service.addToAlbum('album-manifest', ['photo-one']),
      (result) => ({ eventType: 'album.membership-added', outcome: 'succeeded', payload: { count: result.added } }),
      (result) => ({
        commandId: 'album.membership.add',
        classification: 'immediately-reversible',
        inverse: {
          kind: 'album-membership',
          albumId: 'album-manifest',
          photoIds: result.changedPhotoIds,
          before: 'absent',
          after: 'present',
        },
      }),
    );
    await state.history.undo('undo-album-manifest');
    await state.history.redo('redo-album-manifest');
    assert.equal(manifestDebts, 9);
    state.db.close();
  });

  test('enforces activity retention when recording command.undone while holding live redo command (#1437)', async () => {
    const state = world();
    state.activity.record({ eventType: 'import.completed', outcome: 'succeeded', payload: { imported: 1 } });
    state.activity.record({ eventType: 'import.completed', outcome: 'succeeded', payload: { imported: 2 } });
    mutateWithActivity(
      () => state.activity,
      () => state.service.toggleFavorite('photo-one'),
      (result) => ({ eventType: 'photo.favorite-changed', outcome: 'succeeded', payload: { favorite: result.favorite } }),
      (result) => ({
        commandId: 'photo.favorite.toggle',
        classification: 'immediately-reversible',
        inverse: { kind: 'favorite', photoId: 'photo-one', before: !result.favorite, after: result.favorite },
      }),
    );
    const tightHistory = new HistoryService(state.db, state.service, undefined, undefined, undefined, {
      maxEvents: 2,
      maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
      maxPayloadBytes: 64 * 1024 * 1024,
    });
    const undone = await tightHistory.undo('undo-with-retention');
    assert.equal(undone.applied, true);
    const page = state.activity.page(10);
    assert.deepEqual(
      page.events.map((event) => event.eventType),
      ['activity.pruned', 'command.undone', 'photo.favorite-changed'],
    );
    assert.equal((await tightHistory.redo('redo-after-retention')).applied, true);
    state.db.close();
  });
});

describe('HistoryService board layout (#695)', () => {
  const placement = (x: number) => ({
    id: 'p1',
    photoId: 'photo-one',
    x,
    y: 10,
    w: 200,
    h: 150,
    rotation: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    z: 1,
    groupId: null,
  });
  const boardAt = (x: number): Board => ({
    id: 'b1',
    title: 'A',
    notes: '',
    size: { width: 1600, height: 1200 },
    background: 'ink',
    placements: [placement(x)],
  });

  test('undoes and redoes a board layout edit through the shared history', async () => {
    let reloaded: string | null = null;
    let manifestDebts = 0;
    const state = world();
    const history = new HistoryService(
      state.db,
      state.service,
      undefined,
      () => {
        manifestDebts += 1;
      },
      (boardId) => {
        reloaded = boardId;
      },
    );
    state.service.saveBoard(boardAt(10)); // create — no command
    const loaded = state.service.getBoard('b1');
    assert.ok(loaded !== null);
    const before = serializeBoard(loaded);

    mutateWithActivity(
      () => state.activity,
      () => state.service.saveBoard(boardAt(99)),
      () => ({ eventType: 'board.layout-changed', entityIds: ['b1'], outcome: 'succeeded', payload: {} }),
      () => boardLayoutCommand('b1', before, serializeBoard(boardAt(99))),
    );
    assert.equal(state.service.getBoard('b1')?.placements[0]?.x, 99);

    const undone = await history.undo('u1');
    assert.equal(undone.applied, true);
    assert.equal(state.service.getBoard('b1')?.placements[0]?.x, 10, 'undo restores the previous layout');
    assert.equal(reloaded, 'b1', 'undo notifies the renderer to reload');

    const redone = await history.redo('r1');
    assert.equal(redone.applied, true);
    assert.equal(state.service.getBoard('b1')?.placements[0]?.x, 99, 'redo re-applies the layout');
    assert.equal(manifestDebts, 2, 'undo and redo each owe a fresh backup manifest');
  });

  test('a first save or no-op records no undoable command', () => {
    assert.equal(boardLayoutCommand('b1', null, 'after'), undefined);
    assert.equal(boardLayoutCommand('b1', 'same', 'same'), undefined);
  });
});
