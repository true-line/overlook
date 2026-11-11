import type { MenuItemConstructorOptions } from 'electron';

import { commandById, type CommandDescriptor, type CommandId, type CommandPlatform } from '../shared/commands/registry.js';
import { HELP_MENU_ITEMS } from '../shared/commands/help-menu.js';
import { menuMessages } from '../shared/commands/app-menu.js';
import type { CommandMenuContext } from '../shared/commands/menu-contract.js';
import { commandEnabled } from '../shared/commands/menu-enablement.js';

// Enablement is shared with the Windows/Linux titlebar menus (#1293).
export { commandEnabled };

export type CommandDispatch = (id: CommandId) => void;
export interface MessageDescriptor {
  readonly id: string;
  readonly defaultMessage: string;
}
export type MenuTranslate = (message: MessageDescriptor) => string;

const sourceText: MenuTranslate = ({ defaultMessage }) => (typeof defaultMessage === 'string' ? defaultMessage : '');

function accelerator(command: CommandDescriptor, context: CommandMenuContext): string | undefined {
  if (command.key === undefined) return undefined;
  if (command.primaryModifier !== true) {
    if (context.editable) return undefined;
    if (
      command.surfaces.length > 0 &&
      (context.surface === 'locked' || context.surface === 'onboarding' || !command.surfaces.includes(context.surface))
    ) {
      return undefined;
    }
  }
  const parts: string[] = [];
  if (command.primaryModifier === true) parts.push('CommandOrControl');
  if (command.alt === true) parts.push('Alt');
  if (command.shift === true || command.key === '?') parts.push('Shift');
  const key = command.key === '?' ? '/' : command.key === 'Escape' ? 'Esc' : command.key;
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

function commandItem(
  id: CommandId,
  context: CommandMenuContext,
  dispatch: CommandDispatch,
  translate: MenuTranslate,
  options: Pick<MenuItemConstructorOptions, 'type' | 'checked'> = {},
): MenuItemConstructorOptions {
  const command = commandById(id);
  const shortcut = accelerator(command, context);
  return {
    id,
    label: translate(command.label),
    enabled: commandEnabled(id, context),
    ...(shortcut === undefined ? {} : { accelerator: shortcut }),
    ...options,
    click: () => dispatch(id),
  };
}

const separator: MenuItemConstructorOptions = { type: 'separator' };

/** Drop a menu item's accelerator without changing its command dispatch. */
function withoutAccelerator(item: MenuItemConstructorOptions): MenuItemConstructorOptions {
  const { accelerator: _accelerator, ...rest } = item;
  return rest;
}

/** Re-project a command into a second menu slot: distinct item id, no accelerator, same command dispatch. */
function alias(item: MenuItemConstructorOptions, id: string): MenuItemConstructorOptions {
  return { ...withoutAccelerator(item), id };
}

/**
 * Help submenu, projected from the shared HELP_MENU_ITEMS list so the macOS
 * Help menu and the Windows/Linux titlebar Help menu (#699) render the same
 * commands in the same order and cannot drift (ADR-0024 §5, I1). Privacy &
 * Diagnostics is aliased to a distinct id since it also lives in the app menu.
 */
function helpSubmenu(context: CommandMenuContext, dispatch: CommandDispatch, translate: MenuTranslate): MenuItemConstructorOptions[] {
  return HELP_MENU_ITEMS.flatMap((entry) => {
    const base = commandItem(entry.command, context, dispatch, translate);
    const item = entry.menuItemId === undefined ? base : alias(base, entry.menuItemId);
    return entry.separatorBefore === true ? [separator, item] : [item];
  });
}

/**
 * macOS application menu (#689) — projects the design-system `MenuBar` spec:
 * Overlook · File · Edit · View · Photo · Help, in this exact order, every
 * item dispatching a shared-registry command id (ADR-0024 parity). Cut/Copy/
 * Paste and About/Quit are OS roles the design mock cannot render but ADR-0024
 * §1 mandates and text editing requires. The Help → Activity item is owned by
 * #690 (`help.activity`) and is inserted there.
 */
function macApplicationMenuTemplate(
  appName: string,
  context: CommandMenuContext,
  dispatch: CommandDispatch,
  translate: MenuTranslate,
): MenuItemConstructorOptions[] {
  const inTrash = context.source === 'deleted';
  const photoItems: MenuItemConstructorOptions[] = inTrash
    ? [commandItem('photo.restore', context, dispatch, translate)]
    : [
        commandItem('photo.favorite.toggle', context, dispatch, translate),
        commandItem('album.membership.add', context, dispatch, translate),
        ...(context.inAlbum ? [commandItem('album.membership.remove', context, dispatch, translate)] : []),
        // Same `photo.export` command as File → Export Selection…; distinct
        // menu-item id + no accelerator (the ⇧⌘E shortcut lives on the File item).
        alias(commandItem('photo.export', context, dispatch, translate), 'photo.export.photo'),
        separator,
        commandItem('photo.trash', context, dispatch, translate),
      ];

  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        separator,
        commandItem('app.settings.open', context, dispatch, translate),
        commandItem('app.settings.open.storage', context, dispatch, translate),
        ...(context.pcloudEnabled ? [commandItem('app.settings.open.transfer', context, dispatch, translate)] : []),
        commandItem('app.settings.open.privacy', context, dispatch, translate),
        separator,
        commandItem('app.lock.now', context, dispatch, translate),
        separator,
        { role: 'quit' },
      ],
    },
    {
      label: translate(menuMessages.file),
      submenu: [
        commandItem('library.import', context, dispatch, translate),
        commandItem('photo.export', context, dispatch, translate),
        commandItem('library.exportAll', context, dispatch, translate),
        commandItem('library.duplicates', context, dispatch, translate),
        separator,
        commandItem('library.switch', context, dispatch, translate),
        commandItem('library.move', context, dispatch, translate),
        commandItem('library.new', context, dispatch, translate),
      ],
    },
    {
      label: translate(menuMessages.edit),
      submenu: [
        commandItem('history.undo', context, dispatch, translate),
        commandItem('history.redo', context, dispatch, translate),
        separator,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        separator,
        context.editable ? { role: 'selectAll' } : commandItem('selection.selectAll', context, dispatch, translate),
        commandItem('selection.clear', context, dispatch, translate),
      ],
    },
    {
      label: translate(menuMessages.view),
      submenu: [
        commandItem('library.source.all', context, dispatch, translate, { type: 'radio', checked: context.source === 'all' }),
        commandItem('library.source.favorites', context, dispatch, translate, { type: 'radio', checked: context.source === 'favorites' }),
        commandItem('library.source.recent', context, dispatch, translate, { type: 'radio', checked: context.source === 'recent' }),
        commandItem('library.source.trash', context, dispatch, translate, { type: 'radio', checked: context.source === 'deleted' }),
        separator,
        commandItem('view.mode.grid', context, dispatch, translate, { type: 'radio', checked: context.view === 'grid' }),
        commandItem('view.mode.list', context, dispatch, translate, { type: 'radio', checked: context.view === 'list' }),
        commandItem('view.mode.feed', context, dispatch, translate, { type: 'radio', checked: context.view === 'feed' }),
        commandItem('view.mode.moodboard', context, dispatch, translate, { type: 'radio', checked: context.view === 'moodboard' }),
        separator,
        commandItem('view.inspector.toggle', context, dispatch, translate, { type: 'checkbox', checked: context.inspectorOpen }),
        commandItem('view.inspector.detach', context, dispatch, translate),
        commandItem('view.sidebar.toggle', context, dispatch, translate),
        separator,
        commandItem('view.appearance.reset', context, dispatch, translate),
      ],
    },
    {
      label: translate(menuMessages.photo),
      submenu: photoItems,
    },
    {
      role: 'help',
      submenu: helpSubmenu(context, dispatch, translate),
    },
  ];
}

// The native application menu is a macOS-only surface (ADR-0024 §5, amended
// #699). Windows and Linux run frameless with no native menu bar — every
// command is projected onto the toolbar, sidebar, titlebar, or keyboard, with
// the two otherwise menu-only Help commands living in the renderer titlebar
// Help menu — so this returns an empty template there and the controller sets
// no application menu.
export function buildApplicationMenuTemplate(
  platform: CommandPlatform,
  appName: string,
  context: CommandMenuContext,
  dispatch: CommandDispatch,
  translate: MenuTranslate = sourceText,
): MenuItemConstructorOptions[] {
  if (platform !== 'darwin') return [];
  return macApplicationMenuTemplate(appName, context, dispatch, translate);
}
