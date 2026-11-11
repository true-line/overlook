import { useCallback, useEffect, useRef, type Dispatch } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import type { ExportDialogController } from '../export/use-export-dialog.js';
import { duplicatePhotos } from '../grid/duplicate-photos.js';

import type { CommandId, CommandSurface } from '../../../shared/commands/registry.js';
import { VIEW_MODE_BY_COMMAND } from '../../../shared/commands/view-modes.js';
import type { AppAction, AppState } from '../../../shared/library/app-state.js';
import type { SettingsSection } from '../settings/SettingsDialog';
import { getApplicationThemeLayer } from '../theme/user-theme-layer';
import { deletePhoto } from './delete-photo';

const routerMessages = defineMessages({
  undid: { id: 'commands.toast.undid', defaultMessage: 'Undid last action' },
  redid: { id: 'commands.toast.redid', defaultMessage: 'Redid last action' },
  cannotUndo: { id: 'commands.toast.cannotUndo', defaultMessage: 'Cannot undo — {reason}' },
  cannotRedo: { id: 'commands.toast.cannotRedo', defaultMessage: 'Cannot redo — {reason}' },
  trashedCount: {
    id: 'commands.toast.trashedCount',
    defaultMessage: 'Moved {count, plural, one {# photo} other {# photos}} to Trash',
  },
  trashedWithProtected: {
    id: 'commands.toast.trashedWithProtected',
    defaultMessage:
      'Moved {deleted, number} to Trash · preserved {protectedCount, plural, one {# protected Original} other {# protected Originals}}',
  },
  restoredCount: {
    id: 'commands.toast.restoredCount',
    defaultMessage: 'Restored {count, plural, one {# photo} other {# photos}}',
  },
  removedFromAlbum: {
    id: 'commands.toast.removedFromAlbum',
    defaultMessage: 'Removed {count, plural, one {# photo} other {# photos}} from the album',
  },
});

/**
 * Routes a native-menu / shortcut command (delivered over IPC as an
 * incrementing sequence) to its renderer handler (#531 / #689). Extracted from
 * `Shell` so the command surface is a single self-contained unit and Shell stays
 * within the file-size budget. Every handler dispatches the SAME registry command
 * whose handler backs the toolbar / context menu (ADR-0024 parity).
 *
 * Returns the executor as a `runCommand(id)` function so the Windows/Linux
 * titlebar Help menu (#699) — which has no native menu to deliver over IPC —
 * can invoke Help commands through the identical path (parity, ADR-0024 §5 / I1).
 */
export interface NativeCommandRouterDeps {
  readonly nativeCommand: { readonly id: CommandId; readonly sequence: number } | null;
  readonly state: AppState;
  readonly dispatch: Dispatch<AppAction>;
  readonly onSelectAll: () => void;
  readonly setShortcutSurface: (surface: CommandSurface | null) => void;
  readonly setSettingsSection: (section: SettingsSection | undefined) => void;
  readonly exportDialog: Pick<ExportDialogController, 'openPhotos' | 'setPhotoIds' | 'setAllPhotos'>;
  readonly setAlbumPickerIds: (ids: readonly string[] | null) => void;
  readonly setLibrariesCreating: (creating: boolean) => void;
  readonly resetInteropEntry: () => void;
  readonly resetUnlockAlbum: () => void;
  readonly resetDropped: () => void;
  readonly closeOffload: () => void;
  readonly pcloudEnabled: boolean;
  readonly lockConfigured?: boolean | undefined;
}

export function useNativeCommandRouter(deps: NativeCommandRouterDeps): (command: CommandId) => void {
  const {
    nativeCommand,
    state,
    dispatch,
    onSelectAll,
    setShortcutSurface,
    setSettingsSection,
    exportDialog,
    setAlbumPickerIds,
    setLibrariesCreating,
    resetInteropEntry,
    resetUnlockAlbum,
    resetDropped,
    closeOffload,
    pcloudEnabled,
    lockConfigured,
  } = deps;
  const { openPhotos: onExport, setPhotoIds: setExportPhotoIds, setAllPhotos: setExportAllPhotos } = exportDialog;
  const intl = useIntl();
  const handledSequenceRef = useRef(0);

  const runCommand = useCallback(
    (commandId: CommandId): void => {
      // A deterministic photo target: the focused lightbox photo, else the selection.
      const targetIds = state.lightboxId !== null ? [state.lightboxId] : [...state.selection];
      const closeOverlays = (options?: { readonly preserveLightbox?: boolean }): void => {
        setShortcutSurface(null);
        resetInteropEntry();
        resetUnlockAlbum();
        closeOffload();
        resetDropped();
        setExportPhotoIds(null);
        setExportAllPhotos(false);
        if (!options?.preserveLightbox) {
          dispatch({ type: 'lightbox/closed' });
        }
        dispatch({ type: 'dialog/set', dialog: 'import', open: false });
        dispatch({ type: 'dialog/set', dialog: 'export', open: false });
        dispatch({ type: 'dialog/set', dialog: 'settings', open: false });
        dispatch({ type: 'dialog/set', dialog: 'libraries', open: false });
      };
      const openSettings = (section: SettingsSection): void => {
        closeOverlays();
        setSettingsSection(section);
        dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
      };
      if (commandId.startsWith('album.reorder.')) return;
      switch (commandId) {
        case 'view.appearance.reset':
          void window.overlook.themes.reset().then(() => getApplicationThemeLayer().reset());
          return;
        case 'app.settings.open':
          openSettings('general');
          return;
        case 'app.settings.open.storage':
          openSettings('storage');
          return;
        case 'app.settings.open.transfer':
          if (!pcloudEnabled) return;
          openSettings('transfer');
          return;
        case 'app.settings.open.privacy':
          openSettings('privacy');
          return;
        case 'library.switch':
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'libraries', open: true });
          return;
        case 'library.new':
          closeOverlays();
          setLibrariesCreating(true);
          dispatch({ type: 'dialog/set', dialog: 'libraries', open: true });
          return;
        case 'library.move':
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'libraries', open: true });
          return;
        case 'library.import':
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'import', open: true });
          return;
        case 'library.exportAll':
          if (state.protectedAlbum !== null) return;
          closeOverlays();
          setExportAllPhotos(true);
          dispatch({ type: 'dialog/set', dialog: 'export', open: true });
          return;
        case 'library.source.all':
        case 'library.source.favorites':
        case 'library.source.recent':
        case 'library.source.trash':
          closeOverlays();
          dispatch({
            type: 'source/set',
            source:
              commandId === 'library.source.all'
                ? 'all'
                : commandId === 'library.source.favorites'
                  ? 'favorites'
                  : commandId === 'library.source.recent'
                    ? 'recent'
                    : 'deleted',
          });
          return;
        case 'selection.selectAll':
          onSelectAll();
          return;
        case 'selection.clear':
          dispatch({ type: 'selection/cleared' });
          return;
        case 'history.undo':
        case 'history.redo': {
          const operation = commandId === 'history.undo' ? window.overlook.history.undo : window.overlook.history.redo;
          void operation({ requestId: crypto.randomUUID() }).then((result) => {
            dispatch({
              type: 'toast/shown',
              toast: {
                title: result.applied
                  ? intl.formatMessage(commandId === 'history.undo' ? routerMessages.undid : routerMessages.redid)
                  : intl.formatMessage(commandId === 'history.undo' ? routerMessages.cannotUndo : routerMessages.cannotRedo, {
                      reason: result.capability.reason,
                    }),
                tone: result.applied ? 'neutral' : 'red',
              },
            });
          });
          return;
        }
        case 'view.inspector.toggle':
          dispatch({ type: 'inspector/toggled' });
          return;
        case 'view.inspector.detach':
          dispatch({ type: 'inspector/detached' });
          return;
        case 'view.sidebar.toggle':
          dispatch({ type: 'sidebar/toggled' });
          return;
        case 'view.mode.grid':
        case 'view.mode.list':
        case 'view.mode.feed':
        case 'view.mode.moodboard':
          dispatch({ type: 'view/set', view: VIEW_MODE_BY_COMMAND[commandId] });
          return;
        case 'view.lightbox.close':
          dispatch({ type: 'lightbox/closed' });
          return;
        case 'photo.favorite.toggle':
          if (targetIds[0] === undefined) return;
          void (
            targetIds.length === 1
              ? window.overlook.library.toggleFavorite({ id: targetIds[0] })
              : window.overlook.library.toggleFavorites({ photoIds: targetIds })
          ).then(({ pendingCount }) => {
            dispatch({ type: 'pendingCount/set', count: pendingCount });
          });
          return;
        case 'photo.trash': {
          if (state.lightboxId !== null) {
            const target = state.photos.find(({ id }) => id === state.lightboxId);
            if (target?.deletedAt === null) deletePhoto(target.id, dispatch, intl);
            return;
          }
          if (targetIds.length === 0) return;
          void window.overlook.library.delete({ photoIds: targetIds }).then(({ deleted, protected: protectedCount }) => {
            dispatch({
              type: 'toast/shown',
              toast: {
                title:
                  protectedCount === 0
                    ? intl.formatMessage(routerMessages.trashedCount, { count: deleted })
                    : intl.formatMessage(routerMessages.trashedWithProtected, { deleted, protectedCount }),
                tone: protectedCount === 0 ? 'neutral' : 'amber',
              },
            });
          });
          return;
        }
        case 'photo.export':
          onExport(targetIds, 'live');
          return;
        case 'photo.duplicate':
          duplicatePhotos(dispatch, targetIds, intl);
          return;
        case 'photo.restore':
          if (targetIds.length === 0) return;
          void window.overlook.library.restore({ photoIds: targetIds }).then(({ restored }) => {
            dispatch({
              type: 'toast/shown',
              toast: { title: intl.formatMessage(routerMessages.restoredCount, { count: restored }), tone: 'green' },
            });
          });
          return;
        case 'album.membership.add':
          if (targetIds.length > 0) setAlbumPickerIds(targetIds);
          return;
        case 'album.membership.remove': {
          const albumId = state.album;
          if (albumId === null || targetIds.length === 0) return;
          void window.overlook.albums.removePhotos({ albumId, photoIds: targetIds }).then(({ removed }) => {
            dispatch({
              type: 'toast/shown',
              toast: { title: intl.formatMessage(routerMessages.removedFromAlbum, { count: removed }), tone: 'neutral' },
            });
          });
          return;
        }
        case 'help.shortcuts':
          setShortcutSurface(state.lightboxId === null ? 'grid' : 'lightbox');
          return;
        case 'help.activity':
          // Menu-only Activity surface (#690). Clear every open overlay first so
          // Activity never stacks a second focus-trapping Dialog on top of one
          // already mounted.
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'activity', open: true });
          return;
        case 'library.duplicates':
          if (state.protectedAlbum !== null) return;
          closeOverlays({ preserveLightbox: true });
          dispatch({ type: 'dialog/set', dialog: 'duplicates', open: true });
          return;
        case 'help.open':
          // macOS opens this from main (the menu never forwards it to the
          // renderer); the Windows/Linux titlebar Help menu reaches it here.
          void window.overlook.help.open();
          return;
        case 'app.lock.now':
          // macOS dispatches Lock Now in main; the Windows/Linux titlebar ⋯
          // Overlook menu reaches it through runCommand here (#1433).
          if (lockConfigured === false) return;
          void window.overlook.appLock.lockNow();
          return;
        case 'album.rename':
        case 'album.delete':
        case 'album.transfer':
        case 'album.hide':
        case 'album.show':
        case 'album.folder.new':
        case 'album.folder.newInside':
        case 'album.folder.newAlbumInside':
        case 'album.move':
        case 'album.tags':
        case 'album.visibility.inherit':
        case 'album.smart.new':
        case 'album.smart.edit':
        case 'album.duplicate':
        case 'photo.open':
        case 'photo.repair':
        case 'photo.offload':
        case 'photo.restoreOriginal':
        case 'photo.recoverOriginal':
        case 'photo.coverage.exclude':
        case 'photo.coverage.include':
        case 'photo.transfer':
        case 'photo.original.mark':
        case 'photo.original.unmark':
        case 'photo.purge':
        case 'trash.empty':
        case 'app.search.focus':
        case 'view.lightbox.previous':
        case 'view.lightbox.next':
        case 'view.lightbox.zoomIn':
        case 'view.lightbox.zoomOut':
        case 'view.lightbox.zoomReset':
        case 'view.lightbox.rotateLeft':
        case 'view.lightbox.rotateRight':
        case 'view.lightbox.flipHorizontal':
        case 'view.lightbox.flipVertical':
        case 'view.lightbox.orientationReset':
        case 'grid.focus.left':
        case 'grid.focus.right':
        case 'grid.focus.up':
        case 'grid.focus.down':
        case 'grid.focus.home':
        case 'grid.focus.end':
        case 'grid.focus.pageUp':
        case 'grid.focus.pageDown':
          return;
      }
    },
    [
      dispatch,
      intl,
      state,
      onSelectAll,
      setShortcutSurface,
      setSettingsSection,
      onExport,
      setExportPhotoIds,
      setExportAllPhotos,
      setAlbumPickerIds,
      setLibrariesCreating,
      resetInteropEntry,
      resetUnlockAlbum,
      resetDropped,
      closeOffload,
      pcloudEnabled,
      lockConfigured,
    ],
  );

  useEffect(() => {
    if (nativeCommand === null || handledSequenceRef.current === nativeCommand.sequence) return;
    handledSequenceRef.current = nativeCommand.sequence;
    runCommand(nativeCommand.id);
  }, [nativeCommand, runCommand]);

  return runCommand;
}
