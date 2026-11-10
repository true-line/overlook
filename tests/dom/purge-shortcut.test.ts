import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handlePurgeShortcut } from '../../src/renderer/src/grid/purge-shortcut.js';

function shiftDeleteEvent(target?: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Delete',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  if (target !== undefined) {
    Object.defineProperty(event, 'target', { configurable: true, value: target });
  }
  return event;
}

test('Shift+Delete in Trash opens PurgeConfirm for ordinary loaded photos and never outside Trash (#1434)', () => {
  const purged: string[][] = [];
  const originalDeletes: string[][] = [];

  const inTrashEvent = shiftDeleteEvent();
  handlePurgeShortcut({
    event: inTrashEvent,
    inTrash: true,
    lightboxId: null,
    selection: new Set(['p1', 'p2']),
    photos: [
      { id: 'p1', isOriginal: false },
      { id: 'p2', isOriginal: false },
    ],
    dialogOpen: false,
    originalDeleteOpen: false,
    platform: 'darwin',
    onPurge: (ids) => purged.push(ids),
    onOriginalDelete: (ids) => originalDeletes.push(ids),
    originalDeletePreflight: () => Promise.reject(new Error('unexpected preflight')),
    originalDeleteCancel: () => Promise.resolve(),
  });
  assert.equal(inTrashEvent.defaultPrevented, true);
  assert.deepEqual(purged, [['p1', 'p2']]);
  assert.deepEqual<string[][]>(originalDeletes, []);

  const allPhotosEvent = shiftDeleteEvent();
  handlePurgeShortcut({
    event: allPhotosEvent,
    inTrash: false,
    lightboxId: null,
    selection: new Set(['p1']),
    photos: [{ id: 'p1', isOriginal: false }],
    dialogOpen: false,
    originalDeleteOpen: false,
    platform: 'win32',
    onPurge: (ids) => purged.push(ids),
    onOriginalDelete: (ids) => originalDeletes.push(ids),
    originalDeletePreflight: () => Promise.reject(new Error('unexpected preflight')),
    originalDeleteCancel: () => Promise.resolve(),
  });
  assert.equal(allPhotosEvent.defaultPrevented, false);
  assert.deepEqual(purged, [['p1', 'p2']]);
  assert.deepEqual(originalDeletes, []);
});

test('Shift+Delete preserves OriginalDeleteDialog for protected Originals and unloaded Trash pages (#1434)', async () => {
  const purged: string[][] = [];
  const originalDeletes: string[][] = [];
  const cancelled: string[] = [];

  const originalEvent = shiftDeleteEvent();
  handlePurgeShortcut({
    event: originalEvent,
    inTrash: false,
    lightboxId: 'orig-1',
    selection: new Set(['other-selected']),
    photos: [{ id: 'orig-1', isOriginal: true }],
    dialogOpen: false,
    originalDeleteOpen: false,
    platform: 'darwin',
    onPurge: (ids) => purged.push(ids),
    onOriginalDelete: (ids) => originalDeletes.push(ids),
    originalDeletePreflight: () => Promise.reject(new Error('unexpected preflight')),
    originalDeleteCancel: () => Promise.resolve(),
  });
  assert.equal(originalEvent.defaultPrevented, true);
  assert.deepEqual(originalDeletes, [['orig-1']]);

  handlePurgeShortcut({
    event: shiftDeleteEvent(),
    inTrash: true,
    lightboxId: null,
    selection: new Set(['loaded-1', 'unloaded-2']),
    photos: [{ id: 'loaded-1', isOriginal: false }],
    dialogOpen: false,
    originalDeleteOpen: false,
    platform: 'linux',
    onPurge: (ids) => purged.push(ids),
    onOriginalDelete: (ids) => originalDeletes.push(ids),
    originalDeletePreflight: () => Promise.reject(new Error('no protected originals')),
    originalDeleteCancel: ({ challengeId }) => {
      cancelled.push(challengeId);
      return Promise.resolve();
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(purged, [['loaded-1', 'unloaded-2']]);
  assert.deepEqual(cancelled, []);
});
