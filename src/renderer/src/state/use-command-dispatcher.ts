import { useLayoutEffect } from 'react';
import { useIntl } from 'react-intl';

import { resolveCommand, type CommandId, type CommandPlatform, type CommandSurface } from '../../../shared/commands/registry.js';
import { directionOf } from '../../../shared/i18n/locales.js';
import { anyDialogOpen } from '../../../shared/library/app-state.js';
import { useAppDispatch, useAppState } from './app-state-context';
import { lightboxStepForKey } from './lightbox-direction';
import { getApplicationThemeLayer } from '../theme/user-theme-layer';
import { deletePhoto } from '../shell/delete-photo';

function commandPlatform(platform: string): CommandPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return 'linux';
}

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

export function useCommandDispatcher(
  platform: string,
  onHelp: (surface: CommandSurface) => void,
  helpOpen: boolean,
  onSelectAll: () => void,
  onCommand?: (id: CommandId) => void,
): void {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const direction = directionOf(useIntl().locale);

  // A layout effect, not a passive one (#1279): the listener must match the
  // committed state before the browser can deliver another key. A passive
  // effect runs after paint, so a key pressed as a dialog closes or the
  // Lightbox opens was judged by the previous render and could be dropped.
  useLayoutEffect(() => {
    const dialogOpen = helpOpen || anyDialogOpen(state);
    const surface: CommandSurface = state.lightboxId === null ? 'grid' : 'lightbox';
    const execute = (id: CommandId, event: KeyboardEvent): boolean => {
      switch (id) {
        case 'view.appearance.reset':
          void window.overlook.themes.reset().then(() => getApplicationThemeLayer().reset());
          return true;
        case 'library.duplicates':
          if (platform === 'darwin' || state.protectedAlbum !== null || onCommand === undefined) return false;
          onCommand(id);
          return true;
        case 'app.settings.open':
        case 'app.settings.open.storage':
        case 'app.settings.open.transfer':
        case 'app.settings.open.privacy':
        case 'app.lock.now':
        case 'library.switch':
        case 'library.move':
        case 'library.new':
        case 'library.import':
        case 'library.exportAll':
        case 'view.sidebar.toggle':
        case 'view.mode.feed':
        case 'library.source.all':
        case 'library.source.favorites':
        case 'library.source.recent':
        case 'library.source.trash':
        case 'view.mode.grid':
        case 'view.mode.list':
        case 'view.mode.moodboard':
        case 'board.layout':
        case 'help.open':
        case 'help.activity':
        case 'album.membership.add':
        case 'album.membership.remove':
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
        case 'album.reorder.up':
        case 'album.reorder.down':
        case 'album.reorder.top':
        case 'album.reorder.bottom':
        case 'photo.open':
        case 'photo.export':
        case 'photo.duplicate':
        case 'photo.repair':
        case 'photo.offload':
        case 'photo.restoreOriginal':
        case 'photo.recoverOriginal':
        case 'photo.coverage.exclude':
        case 'photo.coverage.include':
        case 'photo.original.mark':
        case 'photo.original.unmark':
        case 'photo.transfer':
        case 'photo.restore':
        case 'photo.purge':
        case 'trash.empty':
          return false;
        case 'history.undo':
        case 'history.redo': {
          const operation = id === 'history.undo' ? window.overlook.history.undo : window.overlook.history.redo;
          void operation({ requestId: crypto.randomUUID() }).then((result) => {
            dispatch({
              type: 'toast/shown',
              toast: {
                title: result.applied
                  ? id === 'history.undo'
                    ? 'Undid last action'
                    : 'Redid last action'
                  : `Cannot ${id === 'history.undo' ? 'undo' : 'redo'} — ${result.capability.reason}`,
                tone: result.applied ? 'neutral' : 'red',
              },
            });
          });
          return true;
        }
        case 'app.search.focus':
          document.querySelector<HTMLInputElement>('[role="searchbox"]')?.focus();
          return true;
        case 'selection.selectAll':
          onSelectAll();
          return true;
        case 'selection.clear':
          dispatch({ type: 'selection/cleared' });
          return true;
        case 'view.inspector.toggle':
          dispatch({ type: 'inspector/toggled' });
          return true;
        case 'view.inspector.detach':
          dispatch({ type: 'inspector/detached' });
          return true;
        case 'view.lightbox.close':
          dispatch({ type: 'lightbox/closed' });
          return true;
        case 'view.lightbox.previous':
        case 'view.lightbox.next': {
          if (event.defaultPrevented) return false;
          const key = id === 'view.lightbox.previous' ? 'ArrowLeft' : 'ArrowRight';
          dispatch({ type: 'lightbox/stepped', delta: lightboxStepForKey(key, direction) });
          return true;
        }
        case 'photo.favorite.toggle': {
          const photo = state.photos.find(({ id: photoId }) => photoId === state.lightboxId);
          if (photo === undefined || photo.deletedAt !== null) return false;
          void window.overlook.library.toggleFavorite({ id: photo.id }).then(({ pendingCount }) => {
            dispatch({ type: 'pendingCount/set', count: pendingCount });
          });
          return true;
        }
        case 'photo.trash': {
          const photo = state.photos.find(({ id: photoId }) => photoId === state.lightboxId);
          if (photo === undefined || photo.deletedAt !== null) return false;
          deletePhoto(photo.id, dispatch);
          return true;
        }
        case 'view.lightbox.zoomIn':
        case 'view.lightbox.zoomOut':
        case 'view.lightbox.zoomReset':
        case 'view.lightbox.rotateLeft':
        case 'view.lightbox.rotateRight':
        case 'view.lightbox.flipHorizontal':
        case 'view.lightbox.flipVertical':
        case 'view.lightbox.orientationReset':
        case 'photo.edit.save':
        case 'photo.edit.reset':
        case 'photo.edit.crop':
        case 'photo.edit.revert':
          // Owned by the lightbox viewport (#493); it intercepts them in capture phase.
          return false;
        case 'help.shortcuts':
          onHelp(surface);
          return true;
        case 'grid.focus.left':
        case 'grid.focus.right':
        case 'grid.focus.up':
        case 'grid.focus.down':
        case 'grid.focus.home':
        case 'grid.focus.end':
        case 'grid.focus.pageUp':
        case 'grid.focus.pageDown':
          return false;
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = resolveCommand(event, {
        surface,
        dialogOpen,
        editable: editableTarget(event.target),
        platform: commandPlatform(platform),
      });
      if (command !== null && execute(command.id, event)) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [direction, dispatch, helpOpen, onCommand, onHelp, onSelectAll, platform, state]);
}

export { commandPlatform };
