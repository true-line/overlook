import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';

import { buildApplicationMenuTemplate, commandEnabled } from '../../src/main/application-menu-model.js';
import { HELP_URL } from '../../src/shared/commands/help-menu.js';
import { EMPTY_COMMAND_MENU_CONTEXT, type CommandMenuContext } from '../../src/shared/commands/menu-contract.js';
import type { CommandId } from '../../src/shared/commands/registry.js';

function find(items: readonly MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    if (Array.isArray(item.submenu)) {
      const nested = find(item.submenu, id);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function ids(items: readonly MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [...(item.id === undefined ? [] : [item.id]), ...(Array.isArray(item.submenu) ? ids(item.submenu) : [])]);
}

function submenuLabels(items: readonly MenuItemConstructorOptions[], menu: string): (string | undefined)[] {
  const owner = items.find((item) => (item.label ?? item.role) === menu);
  return Array.isArray(owner?.submenu) ? owner.submenu.map((item) => (item.type === 'separator' ? '—' : (item.label ?? item.role))) : [];
}

const grid: CommandMenuContext = {
  ...EMPTY_COMMAND_MENU_CONTEXT,
  surface: 'grid',
  hasLibrary: true,
  hasPhotos: true,
  hasPhotoKeyTarget: true,
  appLockConfigured: true,
  pcloudEnabled: true,
};

test('macOS menu is the six-menu design-system hierarchy in order (#689)', () => {
  const template = buildApplicationMenuTemplate('darwin', 'Overlook', grid, () => {});
  assert.deepEqual(
    template.map(({ label, role }) => label ?? role),
    ['Overlook', 'File', 'Edit', 'View', 'Photo', 'help'],
  );
  // No Window menu; the lightbox-exit command is not a menu item on mac.
  assert.equal(
    template.some(({ label }) => label === 'Window'),
    false,
  );
  assert.equal(find(template, 'view.lightbox.close'), undefined);
});

test('pCloud-disabled menu hides the Transfer & Sync route', () => {
  const disabled = { ...grid, pcloudEnabled: false };
  const template = buildApplicationMenuTemplate('darwin', 'Overlook', disabled, () => {});
  assert.equal(find(template, 'app.settings.open.transfer'), undefined);
  assert.equal(commandEnabled('app.settings.open.transfer', disabled), false);
});

test('macOS menu items are the exact per-menu spec order (#689)', () => {
  const template = buildApplicationMenuTemplate('darwin', 'Overlook', grid, () => {});
  // About/Quit are OS roles — their visible labels ("About Overlook" /
  // "Quit Overlook") are supplied by macOS at runtime, so the template only
  // carries the role name.
  assert.deepEqual(submenuLabels(template, 'Overlook'), [
    'about',
    '—',
    'Settings…',
    'Storage & Backup',
    'Transfer & Sync',
    'Privacy & Diagnostics',
    '—',
    'Lock Now',
    '—',
    'quit',
  ]);
  assert.deepEqual(submenuLabels(template, 'File'), [
    'Import Photos…',
    'Export…',
    'Export All Unencrypted…',
    'Review Duplicates…',
    '—',
    'Switch Library…',
    'Move Library…',
    'New Library…',
  ]);
  assert.deepEqual(submenuLabels(template, 'View'), [
    'All Photos',
    'Favorites',
    'Recent Imports',
    'Trash',
    '—',
    'Grid',
    'List',
    'Feed',
    'Moodboard',
    '—',
    'Show or hide Inspector',
    'Open Inspector in Separate Window',
    'Toggle Sidebar',
    '—',
    'Reset Appearance',
  ]);
});

test('macOS accelerators are generated from registry bindings (#689)', () => {
  const template = buildApplicationMenuTemplate('darwin', 'Overlook', grid, () => {});
  assert.equal(find(template, 'app.settings.open')?.accelerator, 'CommandOrControl+,');
  assert.equal(find(template, 'library.import')?.accelerator, 'CommandOrControl+I');
  assert.equal(find(template, 'photo.export')?.accelerator, 'CommandOrControl+Shift+E');
  assert.equal(find(template, 'library.move')?.accelerator, 'CommandOrControl+Shift+M');
  assert.equal(find(template, 'view.inspector.detach')?.accelerator, 'CommandOrControl+Shift+I');
  assert.equal(find(template, 'view.appearance.reset')?.accelerator, 'CommandOrControl+Alt+Shift+R');
  assert.equal(find(template, 'selection.selectAll')?.accelerator, 'CommandOrControl+A');
  // Menu-item ids stay unique even though Export projects into File + Photo.
  assert.equal(new Set(ids(template)).size, ids(template).length);
});

test('dispatch fires the registry command id (#689)', () => {
  const invoked: CommandId[] = [];
  const template = buildApplicationMenuTemplate('darwin', 'Overlook', grid, (id) => invoked.push(id));
  const privacy = find(template, 'app.settings.open.privacy');
  if (privacy?.click !== undefined) Reflect.apply(privacy.click, privacy, [{}, {}, {}]);
  const exportPhoto = find(template, 'photo.export.photo');
  if (exportPhoto?.click !== undefined) Reflect.apply(exportPhoto.click, exportPhoto, [{}, {}, {}]);
  assert.deepEqual(invoked, ['app.settings.open.privacy', 'photo.export']);
});

test('Lock Now is always shown on mac and disabled without an app password (#689)', () => {
  const unconfigured = buildApplicationMenuTemplate('darwin', 'Overlook', { ...grid, appLockConfigured: false }, () => {});
  assert.equal(find(unconfigured, 'app.lock.now')?.enabled, false);
  const configured = buildApplicationMenuTemplate('darwin', 'Overlook', grid, () => {});
  assert.equal(find(configured, 'app.lock.now')?.enabled, true);
});

test('Photo menu is target-aware: Restore in Trash, membership otherwise (#689)', () => {
  const inTrash = buildApplicationMenuTemplate('darwin', 'Overlook', { ...grid, source: 'deleted' }, () => {});
  assert.deepEqual(submenuLabels(inTrash, 'Photo'), ['Restore photo']);

  const inAlbum = buildApplicationMenuTemplate('darwin', 'Overlook', { ...grid, inAlbum: true }, () => {});
  assert.deepEqual(submenuLabels(inAlbum, 'Photo'), [
    'Toggle favorite',
    'Add to album',
    'Remove from album',
    'Export…',
    '—',
    'Move photo to Trash',
  ]);

  const plain = buildApplicationMenuTemplate('darwin', 'Overlook', grid, () => {});
  assert.equal(find(plain, 'album.membership.remove'), undefined);
});

test('menu enablement fails closed for lock, modal, target, and active-work state (#689)', () => {
  assert.equal(commandEnabled('app.settings.open.privacy', { ...grid, surface: 'locked' }), true);
  assert.equal(commandEnabled('view.appearance.reset', { ...grid, surface: 'locked' }), true);
  assert.equal(commandEnabled('library.import', { ...grid, surface: 'locked' }), false);
  assert.equal(commandEnabled('library.import', { ...grid, providerBusy: true }), false);
  assert.equal(commandEnabled('photo.trash', { ...grid, surface: 'lightbox', hasTarget: true, targetTrashable: true }), true);
  assert.equal(commandEnabled('photo.trash', { ...grid, surface: 'lightbox', hasTarget: true, targetTrashable: false }), false);
  assert.equal(commandEnabled('photo.trash', { ...grid, surface: 'lightbox', targetTrashable: true, dialog: 'settings' }), false);
});

test('Activity is a Help-menu command, not a sidebar/library surface (#690)', () => {
  const invoked: CommandId[] = [];
  const template = buildApplicationMenuTemplate('darwin', 'Overlook', grid, (id) => invoked.push(id));
  // Sits in the Help menu, directly after Keyboard Shortcuts (DS order).
  assert.deepEqual(
    ids(template).filter((id) => id === 'help.shortcuts' || id === 'help.activity' || id === 'help.open'),
    ['help.shortcuts', 'help.activity', 'help.open'],
  );
  const activity = find(template, 'help.activity');
  assert.ok(activity !== undefined);
  // Menu-only: the design system gives Activity no accelerator.
  assert.equal(activity.accelerator, undefined);
  assert.equal(activity.enabled, true);
  if (activity.click !== undefined) Reflect.apply(activity.click, activity, [{}, {}, {}]);
  assert.deepEqual(invoked, ['help.activity']);

  // Per-library and lock-gated: disabled without a library or while locked.
  assert.equal(commandEnabled('help.activity', grid), true);
  assert.equal(commandEnabled('help.activity', { ...grid, hasLibrary: false }), false);
  assert.equal(commandEnabled('help.activity', { ...grid, surface: 'locked' }), false);
});

test('File/Edit/View additions are target-aware and enabled with a library (#689)', () => {
  assert.equal(commandEnabled('library.move', grid), true);
  assert.equal(commandEnabled('library.move', { ...grid, hasLibrary: false }), false);
  assert.equal(commandEnabled('library.new', grid), true);
  assert.equal(commandEnabled('view.sidebar.toggle', grid), true);
  assert.equal(commandEnabled('view.sidebar.toggle', { ...grid, dialog: 'settings' }), false);
  // Clear Selection needs a non-empty selection outside an editable field.
  assert.equal(commandEnabled('selection.clear', { ...grid, selectionCount: 2 }), true);
  assert.equal(commandEnabled('selection.clear', grid), false);
  assert.equal(commandEnabled('selection.clear', { ...grid, selectionCount: 2, editable: true }), false);
  // Feed is a real view (#516): enabled with the grid, off behind a dialog.
  assert.equal(commandEnabled('view.mode.feed', grid), true);
  assert.equal(commandEnabled('view.mode.feed', { ...grid, dialog: 'settings' }), false);
  assert.equal(commandEnabled('library.exportAll', grid), true);
  assert.equal(commandEnabled('library.exportAll', { ...grid, protectedAlbumOpen: true }), false);
});

test('Photo menu commands resolve the lightbox target or the selection (#689)', () => {
  const lightbox: CommandMenuContext = { ...grid, surface: 'lightbox', hasTarget: true, targetTrashable: true };
  const selection: CommandMenuContext = { ...grid, selectionCount: 3 };
  const empty = grid;
  for (const id of ['photo.favorite.toggle', 'photo.export', 'photo.trash', 'album.membership.add'] as const) {
    assert.equal(commandEnabled(id, lightbox), true);
    assert.equal(commandEnabled(id, selection), true);
    assert.equal(commandEnabled(id, empty), false);
  }
  // Move to Trash refuses an already-trashed lightbox target.
  assert.equal(commandEnabled('photo.trash', { ...lightbox, targetTrashable: false }), false);
  // Add to Album is unavailable on Trash rows; Remove from Album needs an album.
  assert.equal(commandEnabled('album.membership.add', { ...selection, source: 'deleted' }), false);
  assert.equal(commandEnabled('album.membership.remove', selection), false);
  assert.equal(commandEnabled('album.membership.remove', { ...selection, inAlbum: true }), true);
  // Restore is Trash-only.
  assert.equal(commandEnabled('photo.restore', { ...selection, source: 'deleted' }), true);
  assert.equal(commandEnabled('photo.restore', selection), false);
});

test('checked state follows only the focused window context (#689)', () => {
  const template = buildApplicationMenuTemplate(
    'darwin',
    'Overlook',
    { ...grid, source: 'favorites', view: 'list', inspectorOpen: true },
    () => {},
  );
  assert.equal(find(template, 'library.source.favorites')?.checked, true);
  assert.equal(find(template, 'view.mode.list')?.checked, true);
  assert.equal(find(template, 'view.inspector.toggle')?.checked, true);
});

test('the moodboard view radio checks only when the board view is active (#515)', () => {
  const onBoard = buildApplicationMenuTemplate('darwin', 'Overlook', { ...grid, view: 'moodboard' }, () => {});
  assert.equal(find(onBoard, 'view.mode.moodboard')?.checked, true);
  assert.equal(find(onBoard, 'view.mode.grid')?.checked, false);
  const onGrid = buildApplicationMenuTemplate('darwin', 'Overlook', { ...grid, view: 'grid' }, () => {});
  assert.equal(find(onGrid, 'view.mode.moodboard')?.checked, false);
});

test('Windows and Linux draw no native application menu (#699)', () => {
  // The native menu is a macOS-only surface; win/linux commands live on the
  // toolbar/sidebar/titlebar/keyboard and the renderer titlebar Help menu.
  assert.deepEqual(
    buildApplicationMenuTemplate('win32', 'Overlook', grid, () => {}),
    [],
  );
  assert.deepEqual(
    buildApplicationMenuTemplate('linux', 'Overlook', grid, () => {}),
    [],
  );
});

test('macOS Help menu mirrors the shared HELP_MENU_ITEMS list with a separator (#699)', () => {
  const template = buildApplicationMenuTemplate('darwin', 'Overlook', grid, () => {});
  const help = template.find((menu) => menu.role === 'help');
  assert.ok(help !== undefined && Array.isArray(help.submenu));
  const shape = help.submenu.map((item) => (item.type === 'separator' ? '—' : item.id));
  assert.deepEqual(shape, ['help.shortcuts', 'help.activity', '—', 'help.privacy', 'help.open']);
  // Privacy keeps its distinct Help id so it does not collide with the app-menu
  // Privacy item — native ids stay unique.
  assert.equal(new Set(ids(template)).size, ids(template).length);
});

test('native pixel commands require an authoritative key target; metadata remains available (#1235)', () => {
  for (const context of [
    { ...grid, selectionCount: 1 },
    { ...grid, surface: 'lightbox' as const, hasTarget: true, targetTrashable: true },
  ]) {
    const locked = { ...context, hasPhotoKeyTarget: false };
    assert.equal(commandEnabled('photo.export', locked), false);
    assert.equal(commandEnabled('photo.duplicate', locked), false);
    assert.equal(commandEnabled('photo.favorite.toggle', locked), true);
    assert.equal(commandEnabled('album.membership.add', locked), true);
    assert.equal(commandEnabled('photo.export', { ...locked, hasPhotoKeyTarget: true }), true);
  }
});

test('bare-key menu accelerators scope to non-editable matching surfaces and Help points to true-line/overlook (#1434)', () => {
  assert.equal(HELP_URL, 'https://github.com/true-line/overlook#readme');

  const gridSelected = buildApplicationMenuTemplate('darwin', 'Overlook', { ...grid, selectionCount: 2 }, () => {});
  assert.equal(find(gridSelected, 'photo.favorite.toggle')?.enabled, true);
  assert.equal(find(gridSelected, 'photo.trash')?.enabled, true);
  assert.equal(find(gridSelected, 'photo.favorite.toggle')?.accelerator, undefined);
  assert.equal(find(gridSelected, 'photo.trash')?.accelerator, undefined);
  assert.equal(find(gridSelected, 'view.inspector.toggle')?.accelerator, 'I');

  const gridEditable = buildApplicationMenuTemplate('darwin', 'Overlook', { ...grid, selectionCount: 2, editable: true }, () => {});
  assert.equal(find(gridEditable, 'view.inspector.toggle')?.accelerator, undefined);
  assert.equal(find(gridEditable, 'selection.clear')?.accelerator, undefined);
  assert.equal(find(gridEditable, 'help.shortcuts')?.accelerator, undefined);

  const lightbox = buildApplicationMenuTemplate(
    'darwin',
    'Overlook',
    { ...grid, surface: 'lightbox', hasTarget: true, targetTrashable: true },
    () => {},
  );
  assert.equal(find(lightbox, 'photo.favorite.toggle')?.accelerator, 'F');
  assert.equal(find(lightbox, 'photo.trash')?.accelerator, 'Delete');
});
