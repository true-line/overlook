import { repairPhotoWithToast } from '../inspector/photo-repair-action.js';
import { quickActionMessages } from './quick-action-messages.js';
import { LOCKED_PHOTO_COMMAND_REASON } from '../../../shared/commands/photo-availability.js';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';
import { useIntl } from 'react-intl';
import { libraryGridMessages as messages } from './library-grid-messages.js';

import type { AlbumSummary, PhotoRecord } from '../../../shared/library/types.js';
import { useFormats } from '../i18n/use-formats.js';
import { thumbUrl } from '../../../shared/library/thumb-url.js';
import { videoTileProps } from '../media/device-capabilities.js';
import { Icon } from '../components/Icon';
import { PhotoTile } from '../components/PhotoTile';
import { activePredicate, anyDialogOpen } from '../../../shared/library/app-state.js';
import { useAppState, useAppDispatch } from '../state/app-state-context';
import { gridTotal } from './grid-total';
import { recentSinceIso, useLibraryPhotos } from '../state/use-library-photos';
import { FeedCard } from './FeedCard';
import { ListRow } from './ListRow';
import { PhotoContextMenu } from './PhotoContextMenu';
import { recoverOriginalWithToast } from '../inspector/original-recovery-action.js';
import { glyphStateOf } from '../components/StatusGlyph';
import { duplicatePhotos } from './duplicate-photos.js';
import { AlbumPicker } from './AlbumPicker';
import { PurgeConfirm } from './PurgeConfirm';
import { useSelectionExportAvailability } from '../commands/use-photo-key-selection.js';
import { SelectionPill } from './SelectionPill';
import { OriginalDeleteDialog } from './OriginalDeleteDialog';
import { VirtualGrid, type VirtualGridItemKeyboard } from './VirtualGrid';
import { beginPhotoDrag, endPhotoDrag } from './photo-drag-session';
import { DEFAULT_TRASH_RETENTION, trashRetentionDays, trashRetentionLabel, type TrashRetention } from '../../../shared/library/trash.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import {
  configuredQuickActions,
  initialQuickActionVisibility,
  quickActionAvailability,
  quickActionExportTarget,
  quickActionTargetIds,
  reduceQuickActionVisibility,
} from '../../../shared/commands/quick-actions.js';
import { type CommandPlatform, type QuickActionCommandId } from '../../../shared/commands/registry.js';
import { DEFAULT_QUICK_ACTIONS } from '../../../shared/settings/settings.js';
import { QuickActions, type QuickActionItem } from './QuickActions';
import { handlePurgeShortcut } from './purge-shortcut.js';
import { useFavoriteMutations } from '../state/use-favorite-mutations';

// Library view (#76/#77): PhotoTile or ListRow over the #74 engine, thumbs
// via the #75 protocol, empty state per the mock. Totals: sidebar counts
// size the plane for unfiltered sets; under query/chips the plane tracks the
// loaded count (+1 while pages remain) until an exact filtered count lands
// with #79.
export function LibraryGridView({
  knownTotal,
  activeAlbum,
  platform,
  onExport,
  onOffload,
  onKeepOnDevice,
  onBackUpAgain,
  onTransfer,
}: {
  readonly knownTotal: number | null;
  readonly activeAlbum: AlbumSummary | null;
  readonly platform: CommandPlatform;
  readonly onExport: (photoIds: readonly string[], target?: 'snapshot' | 'live') => void;
  readonly onOffload: (photoIds: readonly string[], clearSelection?: boolean) => void;
  readonly onKeepOnDevice: (photoIds: readonly string[]) => void;
  readonly onBackUpAgain: (photoIds: readonly string[]) => void;
  readonly onTransfer?: ((entry: 'selection' | 'lightbox', photoIds: readonly string[]) => void) | undefined;
}): ReactElement {
  const intl = useIntl();
  const { formatCalendarDate, formatCount } = useFormats();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const exportAvailability = useSelectionExportAvailability(state.selection);
  const { announce } = useAnnouncer();
  const { loadMore, exhausted, pageFailed } = useLibraryPhotos();
  const facetsActive = activePredicate(state) !== undefined;
  const projectionKey = `${state.source}|${state.query}|${state.searchMode}|${state.search.appliedMode}|${JSON.stringify(state.chips)}|${state.sortOrder}|${state.album ?? ''}|${facetsActive ? JSON.stringify(state.facets) : ''}`;
  const selectionAnchorRef = useRef<string | null>(null);
  const rangeRequestRef = useRef(0);
  const projectionKeyRef = useRef(projectionKey);
  useEffect(() => {
    projectionKeyRef.current = projectionKey;
    selectionAnchorRef.current = null;
    rangeRequestRef.current += 1;
  }, [projectionKey]);
  const selectPhoto = useCallback(
    (photoId: string, extend: boolean): void => {
      const anchorId = selectionAnchorRef.current;
      if (!extend || anchorId === null || projectionKeyRef.current !== projectionKey) {
        rangeRequestRef.current += 1;
        dispatch({ type: 'selection/toggled', photoId });
        selectionAnchorRef.current = photoId;
        return;
      }
      const requestId = (rangeRequestRef.current += 1);
      void window.overlook.library
        .selectionRange({
          source: state.source,
          anchorId,
          targetId: photoId,
          ...(state.source === 'recent' ? { recentSince: recentSinceIso() } : {}),
          ...(state.query === '' ? {} : { query: state.query }),
          searchMode: state.searchMode,
          ...(state.query === '' ? {} : { searchProjection: state.search.appliedMode }),
          ...(Object.values(state.chips).some(Boolean) ? { chips: state.chips } : {}),
          ...(state.sortOrder === 'date' ? {} : { order: state.sortOrder }),
          ...(state.album === null ? {} : { albumId: state.album }),
          ...(facetsActive ? { predicate: state.facets } : {}),
        })
        .then(({ photoIds }) => {
          if (requestId !== rangeRequestRef.current || projectionKeyRef.current !== projectionKey) return;
          if (photoIds.length === 0) {
            dispatch({ type: 'selection/toggled', photoId });
            selectionAnchorRef.current = photoId;
            return;
          }
          dispatch({ type: 'selection/replaced', photoIds });
        });
    },
    [
      dispatch,
      facetsActive,
      projectionKey,
      state.album,
      state.chips,
      state.facets,
      state.query,
      state.search.appliedMode,
      state.searchMode,
      state.sortOrder,
      state.source,
    ],
  );
  // Purge ceremony (#121): the Trash pill's permanent-delete action opens the confirm over
  // a SNAPSHOT of the selection — global shortcuts (⌘A) stay live while
  // the modal is open, and the destructive set must be exactly what the
  // user confirmed (PR #220 review).
  const [purgeIds, setPurgeIds] = useState<readonly string[] | null>(null);
  const [originalDeleteIds, setOriginalDeleteIds] = useState<readonly string[] | null>(null);
  const [contextPhoto, setContextPhoto] = useState<{
    readonly photo: PhotoRecord;
    readonly targetIds: readonly string[];
    readonly selectionBeforeOpen: readonly string[];
    readonly x: number;
    readonly y: number;
    readonly origin: HTMLButtonElement;
  } | null>(null);
  const [albumPicker, setAlbumPicker] = useState<{
    readonly targetIds: readonly string[];
    readonly x: number;
    readonly y: number;
    readonly origin: HTMLButtonElement;
  } | null>(null);
  const { pending: favoritePending, toggleFavorite, toggleFavorites } = useFavoriteMutations();
  const [retentionNow] = useState(() => Date.now());
  const [trashRetention, setTrashRetention] = useState<TrashRetention>(DEFAULT_TRASH_RETENTION);
  const [quickActionIds, setQuickActionIds] = useState<readonly QuickActionCommandId[]>(DEFAULT_QUICK_ACTIONS);
  const [quickActionVisibility, dispatchQuickActionVisibility] = useReducer(reduceQuickActionVisibility, initialQuickActionVisibility);
  const [quickAlbumIds, setQuickAlbumIds] = useState<readonly string[] | null>(null);
  const [nativeDragAvailable, setNativeDragAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    void window.overlook.nativeDrag
      .status()
      .then(({ available }) => {
        if (active) setNativeDragAvailable(available);
      })
      .catch(() => {
        if (active) setNativeDragAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = window.overlook.settings.onChanged(({ settings }) => {
      changed = true;
      setTrashRetention(settings.trashRetention);
      setQuickActionIds(settings.quickActions);
    });
    void window.overlook.settings.get().then(({ settings }) => {
      if (active && !changed) {
        setTrashRetention(settings.trashRetention);
        setQuickActionIds(settings.quickActions);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const openContextMenu = (
    photo: PhotoRecord,
    point: { readonly x: number; readonly y: number; readonly origin: HTMLButtonElement },
  ): void => {
    const selectionBeforeOpen = [...state.selection];
    const targetIds = state.selection.has(photo.id) ? selectionBeforeOpen : [photo.id];
    if (!state.selection.has(photo.id)) dispatch({ type: 'selection/replaced', photoIds: targetIds });
    setContextPhoto({ photo, targetIds, selectionBeforeOpen, ...point });
  };

  const restoreContextFocus = (origin: HTMLButtonElement): void => {
    requestAnimationFrame(() => {
      if (origin.isConnected) origin.focus();
    });
  };

  // An active album narrows like query/chips do (#117): the sidebar count
  // sized for the source no longer applies — track the loaded set instead.
  const filtersActive = state.query !== '' || state.album !== null || facetsActive || Object.values(state.chips).some(Boolean);
  const total = gridTotal({
    filtersActive,
    knownTotal,
    loaded: state.photos.length,
    exhausted,
    pageFailed,
  });
  const inTrash = state.source === 'deleted';
  const modalOpen =
    anyDialogOpen(state) ||
    state.lightboxId !== null ||
    purgeIds !== null ||
    originalDeleteIds !== null ||
    quickAlbumIds !== null ||
    contextPhoto !== null;
  const retentionDays = trashRetentionDays(trashRetention);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      handlePurgeShortcut({
        event,
        inTrash,
        lightboxId: state.lightboxId,
        selection: state.selection,
        photos: state.photos,
        dialogOpen: anyDialogOpen(state) || purgeIds !== null || quickAlbumIds !== null,
        originalDeleteOpen: originalDeleteIds !== null,
        platform,
        onPurge: setPurgeIds,
        onOriginalDelete: setOriginalDeleteIds,
        originalDeletePreflight: (request) => window.overlook.library.originalDeletePreflight(request),
        originalDeleteCancel: (request) => window.overlook.library.originalDeleteCancel(request),
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [inTrash, originalDeleteIds, platform, purgeIds, quickAlbumIds, state]);
  const trashPolicy = intl.formatMessage(retentionDays === null ? messages.trashPolicyOff : messages.trashPolicyDays, {
    days: retentionDays,
  });

  useEffect(() => {
    if (modalOpen) dispatchQuickActionVisibility({ type: 'dismiss' });
  }, [modalOpen]);

  useEffect(() => {
    if (platform !== 'darwin') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Meta' || modalOpen) return;
      const hovered = document.querySelector<HTMLElement>('[data-quick-action-photo-id]:hover');
      const focused =
        document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-quick-action-photo-id]') : null;
      const targetId = hovered?.dataset['quickActionPhotoId'] ?? focused?.dataset['quickActionPhotoId'];
      if (targetId !== undefined) dispatchQuickActionVisibility({ type: 'target', id: targetId });
      dispatchQuickActionVisibility({ type: 'modifier', held: true });
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Meta') dispatchQuickActionVisibility({ type: 'modifier', held: false });
    };
    const dismiss = (): void => dispatchQuickActionVisibility({ type: 'dismiss' });
    const deactivate = (): void => dispatchQuickActionVisibility({ type: 'modifier', held: false });
    const onVisibility = (): void => {
      if (document.hidden) deactivate();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', deactivate);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('wheel', dismiss, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', deactivate);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('wheel', dismiss, true);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [modalOpen, platform]);

  const quickActionItems = (photo: PhotoRecord): readonly QuickActionItem[] => {
    const selection = [...state.selection];
    return configuredQuickActions(quickActionIds).map((command) => {
      const targetIds = quickActionTargetIds(command.id, photo.id, selection);
      const availability = quickActionAvailability(command.id, inTrash ? 'trash' : 'library', targetIds.length === 1 && photo.locked);
      const busy = command.id === 'photo.favorite.toggle' && favoritePending.has(photo.id);
      return {
        id: command.id,
        label:
          command.id === 'photo.favorite.toggle'
            ? intl.formatMessage(photo.favorite ? quickActionMessages.favoriteRemove : quickActionMessages.favoriteAdd)
            : intl.formatMessage(command.label),
        icon: command.quickAction.icon,
        enabled: availability.enabled && !busy,
        reason: busy
          ? intl.formatMessage(quickActionMessages.favoriteBusy)
          : availability.reason === 'library-only'
            ? intl.formatMessage(quickActionMessages.unavailableInTrash)
            : availability.reason === 'trash-only'
              ? intl.formatMessage(quickActionMessages.availableOnlyInTrash)
              : availability.reason === 'locked'
                ? intl.formatMessage(LOCKED_PHOTO_COMMAND_REASON, { id: String(photo.missingKeyId ?? photo.keyId) })
                : null,
        targetLabel:
          targetIds.length === 1
            ? intl.formatMessage(quickActionMessages.targetPhoto)
            : intl.formatMessage(quickActionMessages.targetSelection, { count: targetIds.length }),
      };
    });
  };

  const invokeQuickAction = (commandId: QuickActionCommandId, photo: PhotoRecord, origin: 'hover' | 'context' = 'hover'): void => {
    const photoIds = quickActionTargetIds(commandId, photo.id, [...state.selection]);
    if (!quickActionAvailability(commandId, inTrash ? 'trash' : 'library', photoIds.length === 1 && photo.locked).enabled) return;
    dispatchQuickActionVisibility({ type: 'dismiss' });
    switch (commandId) {
      case 'photo.favorite.toggle':
        if (photoIds.length === 1) toggleFavorite(photo);
        else toggleFavorites(photoIds);
        return;
      case 'photo.export':
        onExport(photoIds, quickActionExportTarget(photo.id, state.selection, origin));
        return;
      case 'album.membership.add':
        setQuickAlbumIds(photoIds);
        return;
      case 'photo.trash':
        void window.overlook.library.delete({ photoIds: [...photoIds] }).then(({ deleted, protected: protectedCount }) => {
          dispatch({
            type: 'toast/shown',
            toast: {
              title:
                protectedCount === 0
                  ? `Moved ${formatCount(deleted)} ${deleted === 1 ? 'photo' : 'photos'} to Trash`
                  : `Moved ${formatCount(deleted)} to Trash · preserved ${formatCount(protectedCount)} protected ${protectedCount === 1 ? 'Original' : 'Originals'}`,
              tone: protectedCount === 0 ? 'neutral' : 'amber',
            },
          });
        });
        return;
      case 'photo.restore':
        void window.overlook.library.restore({ photoIds: [...photoIds] }).then(({ restored }) => {
          dispatch({
            type: 'toast/shown',
            toast: { title: `Restored ${formatCount(restored)} ${restored === 1 ? 'photo' : 'photos'}`, tone: 'green' },
          });
        });
    }
  };

  useEffect(() => {
    if (total === 0) announce('Nothing matches. Try clearing search or filters.', 'polite', 'empty-state');
  }, [announce, total]);

  if (total === 0) {
    return (
      <>
        {inTrash ? <div className="ovl-trash-policy">{trashPolicy}</div> : null}
        <div className={`ovl-empty${inTrash ? ' ovl-empty--inset' : ''}`} data-testid="empty-state">
          <Icon name="image-off" size={28} color="var(--text-faint)" />
          <div className="ovl-empty__title">Nothing matches</div>
          <div className="ovl-empty__hint">Try clearing search or filters.</div>
        </div>
      </>
    );
  }

  const renderTile = (photo: PhotoRecord, _size: number, keyboard: VirtualGridItemKeyboard): ReactElement => {
    const accessibleName = `Open ${[photo.fileName, formatCalendarDate(photo.takenAt ?? photo.importedAt), photo.place].filter((part) => part !== null).join(', ')}`;
    const retentionLabel =
      state.source === 'deleted' && photo.deletedAt !== null
        ? trashRetentionLabel(photo.deletedAt, trashRetention, retentionNow)
        : undefined;
    const onDragStart =
      state.source === 'deleted'
        ? undefined
        : (event: DragEvent<HTMLButtonElement>): void => {
            const payload = {
              version: 1,
              photoIds: state.selection.has(photo.id) ? [...state.selection] : [photo.id],
              sourceAlbumId: state.album,
            } as const;
            beginPhotoDrag(event.dataTransfer, payload);
            if (nativeDragAvailable && payload.photoIds.length <= 100) {
              void window.overlook.nativeDrag
                .start({ photoIds: payload.photoIds, sourceAlbumId: payload.sourceAlbumId })
                .then(({ started }) => {
                  if (started) endPhotoDrag();
                });
            }
          };
    const onDragEnd = onDragStart === undefined ? undefined : endPhotoDrag;
    const items = quickActionItems(photo);
    const quickActions =
      platform === 'darwin' &&
      quickActionVisibility.modifierHeld &&
      quickActionVisibility.targetId === photo.id &&
      !modalOpen &&
      items.length > 0 ? (
        <QuickActions photoName={photo.fileName} items={items} onInvoke={(id) => invokeQuickAction(id, photo)} />
      ) : null;
    const onQuickActionTargetChange =
      platform === 'darwin'
        ? (active: boolean): void => {
            dispatchQuickActionVisibility({ type: 'target', id: active ? photo.id : null });
          }
        : undefined;
    const tileMedia = videoTileProps(photo);
    // Cache-bust the thumb/poster URL once a derivative is (re)generated in
    // place, so the tile reloads without a navigation (thumbEpoch, #548 §6).
    const epoch = state.thumbEpoch[photo.id];
    const bust = (url: string): string => (epoch === undefined ? url : `${url}&v=${String(epoch)}`);
    const tileSrc = bust(thumbUrl(photo.id));
    if (state.view === 'list' || state.view === 'feed') {
      // ListRow and FeedCard (#516) share one contract; only the layout differs.
      const rowProps = {
        photo,
        src: tileSrc,
        accessibleName,
        selected: state.selection.has(photo.id),
        onOpen: () => {
          dispatch({ type: 'lightbox/opened', photoId: photo.id });
        },
        onToggleSelect: (extend: boolean) => selectPhoto(photo.id, extend),
        onToggleFavorite: () => toggleFavorite(photo),
        favoritePending: favoritePending.has(photo.id),
        retentionLabel,
        onContextAction: (point: Parameters<typeof openContextMenu>[1]) => openContextMenu(photo, point),
        quickActions,
        onQuickActionTargetChange,
        onDragStart,
        onDragEnd,
        ...keyboard,
      };
      return state.view === 'feed' ? (
        <FeedCard {...rowProps} media={tileMedia} fullSrc={bust(thumbUrl(photo.id, 'mid'))} />
      ) : (
        <ListRow {...rowProps} />
      );
    }
    return (
      <PhotoTile
        src={tileSrc}
        alt={photo.fileName}
        accessibleName={accessibleName}
        favorite={photo.favorite}
        isOriginal={photo.isOriginal}
        status={glyphStateOf(photo)}
        previewFailure={photo.previewFailure}
        unknownDimensions={photo.dimensionStatus === 'unavailable' || photo.width <= 0 || photo.height <= 0}
        duration={tileMedia?.duration}
        preserved={tileMedia?.preserved ?? false}
        placeholder={tileMedia?.placeholder}
        locked={photo.locked}
        selected={state.selection.has(photo.id)}
        onClick={() => {
          dispatch({ type: 'lightbox/opened', photoId: photo.id });
        }}
        onToggleSelect={(extend) => selectPhoto(photo.id, extend)}
        onToggleFavorite={() => toggleFavorite(photo)}
        favoritePending={favoritePending.has(photo.id)}
        retentionLabel={retentionLabel}
        onContextAction={(point) => openContextMenu(photo, point)}
        quickActions={quickActions}
        quickActionPhotoId={photo.id}
        onQuickActionTargetChange={onQuickActionTargetChange}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        {...keyboard}
      />
    );
  };

  return (
    <>
      {inTrash ? <div className="ovl-trash-policy">{trashPolicy}</div> : null}
      <VirtualGrid
        photos={state.photos}
        total={total}
        zoom={state.zoom}
        mode={state.view === 'list' || state.view === 'feed' ? state.view : 'grid'}
        topInset={inTrash}
        onNeedMore={loadMore}
        renderTile={renderTile}
        onKeyboardOpen={(photo) => dispatch({ type: 'lightbox/opened', photoId: photo.id })}
        onKeyboardSelection={selectPhoto}
        onSelectionAnchorChange={(photoId) => {
          selectionAnchorRef.current = photoId;
        }}
      />
      {state.selection.size > 0 ? (
        <SelectionPill
          count={state.selection.size}
          exportDisabledReason={exportAvailability.disabledReason}
          onRetryExport={exportAvailability.retry}
          onClear={() => {
            dispatch({ type: 'selection/cleared' });
          }}
          onExport={() => {
            onExport([...state.selection], 'live');
          }}
          onOffload={() => onOffload([...state.selection], true)}
          onTransfer={onTransfer === undefined ? undefined : () => onTransfer('selection', [...state.selection])}
          onMarkOriginal={
            state.selectionMode === 'all' || state.photos.some((photo) => state.selection.has(photo.id) && !photo.isOriginal)
              ? () => {
                  const photoIds =
                    state.selectionMode === 'all'
                      ? [...state.selection]
                      : state.photos.filter((photo) => state.selection.has(photo.id) && !photo.isOriginal).map(({ id }) => id);
                  void window.overlook.library.setOriginal({ photoIds, isOriginal: true });
                }
              : undefined
          }
          onUnmarkOriginal={
            state.selectionMode === 'all' || state.photos.some((photo) => state.selection.has(photo.id) && photo.isOriginal)
              ? () => {
                  const photoIds =
                    state.selectionMode === 'all'
                      ? [...state.selection]
                      : state.photos.filter((photo) => state.selection.has(photo.id) && photo.isOriginal).map(({ id }) => id);
                  void window.overlook.library.setOriginal({ photoIds, isOriginal: false });
                }
              : undefined
          }
          // Soft delete / restore (#120): the visible page refreshes off
          // the change push; the reducer intersects the selection away.
          {...(state.source === 'deleted'
            ? {
                onRestore: () => {
                  const photoIds = [...state.selection];
                  void window.overlook.library.restore({ photoIds }).then(({ restored }) => {
                    dispatch({
                      type: 'toast/shown',
                      toast: { title: `Restored ${formatCount(restored)} ${restored === 1 ? 'photo' : 'photos'}`, tone: 'green' },
                    });
                  });
                },
                onPurge: () => {
                  setPurgeIds([...state.selection]);
                },
              }
            : {
                ...(state.album === null
                  ? {}
                  : {
                      onRemoveFromAlbum: () => {
                        const photoIds = [...state.selection];
                        const albumId = state.album;
                        if (albumId === null) return;
                        void window.overlook.albums.removePhotos({ albumId, photoIds }).then(({ removed }) => {
                          dispatch({
                            type: 'toast/shown',
                            toast: {
                              title: `Removed ${formatCount(removed)} ${removed === 1 ? 'photo' : 'photos'} from ${activeAlbum?.name ?? 'album'}`,
                              tone: 'neutral',
                            },
                          });
                        });
                      },
                    }),
                onDelete: () => {
                  const photoIds = [...state.selection];
                  void window.overlook.library.delete({ photoIds }).then(({ deleted, protected: protectedCount }) => {
                    dispatch({
                      type: 'toast/shown',
                      toast: {
                        title:
                          protectedCount === 0
                            ? `Moved ${formatCount(deleted)} ${deleted === 1 ? 'photo' : 'photos'} to Trash`
                            : `Moved ${formatCount(deleted)} to Trash · preserved ${formatCount(protectedCount)} protected ${protectedCount === 1 ? 'Original' : 'Originals'}`,
                        tone: protectedCount === 0 ? 'neutral' : 'amber',
                      },
                    });
                  });
                },
                // Add to album (#118): exact counts in the mock's voice —
                // "Added 12 photos to Big Sur". The sidebar count rides
                // the change push.
                onAddToAlbum: (album) => {
                  const photoIds = [...state.selection];
                  void window.overlook.albums.addPhotos({ albumId: album.id, photoIds }).then(({ added }) => {
                    dispatch({
                      type: 'toast/shown',
                      toast: { title: `Added ${formatCount(added)} ${added === 1 ? 'photo' : 'photos'} to ${album.name}`, tone: 'green' },
                    });
                  });
                },
              })}
        />
      ) : null}
      {contextPhoto === null ? null : (
        <PhotoContextMenu
          {...{ photo: contextPhoto.photo, targetCount: contextPhoto.targetIds.length }}
          inAlbum={state.album !== null}
          {...{ x: contextPhoto.x, y: contextPhoto.y }}
          onClose={() => {
            setContextPhoto(null);
            restoreContextFocus(contextPhoto.origin);
          }}
          onOpen={() => dispatch({ type: 'lightbox/opened', photoId: contextPhoto.photo.id })}
          onRepair={() => repairPhotoWithToast(dispatch, contextPhoto.photo, intl)}
          onToggleFavorite={() => {
            if (contextPhoto.targetIds.length === 1) toggleFavorite(contextPhoto.photo);
            else toggleFavorites(contextPhoto.targetIds);
          }}
          onSetOriginal={(isOriginal) => {
            void window.overlook.library.setOriginal({ photoIds: [...contextPhoto.targetIds], isOriginal });
          }}
          onExport={() => {
            onExport(contextPhoto.targetIds);
            dispatch({ type: 'selection/replaced', photoIds: contextPhoto.selectionBeforeOpen });
          }}
          onAddToAlbum={() => {
            setAlbumPicker({ targetIds: contextPhoto.targetIds, x: contextPhoto.x, y: contextPhoto.y, origin: contextPhoto.origin });
          }}
          onRemoveFromAlbum={() => {
            const albumId = state.album;
            if (albumId === null) return;
            void window.overlook.albums.removePhotos({ albumId, photoIds: [...contextPhoto.targetIds] }).then(({ removed }) => {
              dispatch({
                type: 'toast/shown',
                toast: {
                  title: `Removed ${formatCount(removed)} ${removed === 1 ? 'photo' : 'photos'} from ${activeAlbum?.name ?? 'album'}`,
                  tone: 'neutral',
                },
              });
            });
          }}
          onOffload={() => onOffload(contextPhoto.targetIds)}
          onRecoverOriginal={() => recoverOriginalWithToast(contextPhoto.photo, intl, dispatch)}
          onKeepOnDevice={() => onKeepOnDevice(contextPhoto.targetIds)}
          onBackUpAgain={() => onBackUpAgain(contextPhoto.targetIds)}
          onRestoreOriginal={() => {
            void window.overlook.backup.restoreOriginals({ photoIds: [...contextPhoto.targetIds] }).then(({ restored, failed }) => {
              dispatch({
                type: 'toast/shown',
                toast: {
                  title:
                    failed === 0
                      ? `Restored ${formatCount(restored)} ${restored === 1 ? 'original' : 'originals'}`
                      : `Restored ${formatCount(restored)} · ${formatCount(failed)} failed`,
                  tone: failed === 0 ? 'green' : 'red',
                },
              });
            });
          }}
          onDuplicate={() => duplicatePhotos(dispatch, contextPhoto.targetIds, intl)}
          onTransfer={
            onTransfer === undefined
              ? undefined
              : () => onTransfer(contextPhoto.targetIds.length === 1 ? 'lightbox' : 'selection', contextPhoto.targetIds)
          }
          onTrash={() => {
            void window.overlook.library
              .delete({ photoIds: [...contextPhoto.targetIds] })
              .then(({ deleted, protected: protectedCount }) => {
                dispatch({
                  type: 'toast/shown',
                  toast: {
                    title:
                      protectedCount === 0
                        ? `Moved ${formatCount(deleted)} ${deleted === 1 ? 'photo' : 'photos'} to Trash`
                        : `Moved ${formatCount(deleted)} to Trash · preserved ${formatCount(protectedCount)} protected ${protectedCount === 1 ? 'Original' : 'Originals'}`,
                    tone: protectedCount === 0 ? 'neutral' : 'amber',
                  },
                });
              });
          }}
          onRestore={() => {
            void window.overlook.library.restore({ photoIds: [...contextPhoto.targetIds] }).then(({ restored }) => {
              dispatch({
                type: 'toast/shown',
                toast: { title: `Restored ${formatCount(restored)} ${restored === 1 ? 'photo' : 'photos'}`, tone: 'green' },
              });
            });
          }}
          onPurge={() => setPurgeIds(contextPhoto.targetIds)}
          quickActions={quickActionItems(contextPhoto.photo)}
          onQuickAction={(id) => {
            if (id === 'album.membership.add') {
              setAlbumPicker({
                targetIds: contextPhoto.targetIds,
                x: contextPhoto.x,
                y: contextPhoto.y,
                origin: contextPhoto.origin,
              });
              return;
            }
            invokeQuickAction(id, contextPhoto.photo, 'context');
            if (id === 'photo.export') {
              dispatch({ type: 'selection/replaced', photoIds: contextPhoto.selectionBeforeOpen });
            }
          }}
        />
      )}
      {albumPicker === null ? null : (
        <AlbumPicker
          position={{ x: albumPicker.x, y: albumPicker.y }}
          onClose={() => {
            setAlbumPicker(null);
            restoreContextFocus(albumPicker.origin);
          }}
          onPick={(album) => {
            const targetIds = albumPicker.targetIds;
            setAlbumPicker(null);
            void window.overlook.albums.addPhotos({ albumId: album.id, photoIds: [...targetIds] }).then(({ added }) => {
              dispatch({
                type: 'toast/shown',
                toast: { title: `Added ${formatCount(added)} ${added === 1 ? 'photo' : 'photos'} to ${album.name}`, tone: 'green' },
              });
              restoreContextFocus(albumPicker.origin);
            });
          }}
        />
      )}
      {quickAlbumIds === null ? null : (
        <div className="ovl-quick-action-picker">
          <AlbumPicker
            onPick={(album) => {
              const photoIds = quickAlbumIds;
              setQuickAlbumIds(null);
              void window.overlook.albums.addPhotos({ albumId: album.id, photoIds: [...photoIds] }).then(({ added }) => {
                dispatch({
                  type: 'toast/shown',
                  toast: {
                    title: `Added ${formatCount(added)} ${added === 1 ? 'photo' : 'photos'} to ${album.name}`,
                    tone: 'green',
                  },
                });
              });
            }}
            onClose={() => setQuickAlbumIds(null)}
          />
        </div>
      )}
      {purgeIds !== null && purgeIds.length > 0 ? (
        <PurgeConfirm
          count={purgeIds.length}
          excludedCount={purgeIds.filter((id) => state.photos.find((photo) => photo.id === id)?.coverage === 'excluded').length}
          excludingCount={purgeIds.filter((id) => state.photos.find((photo) => photo.id === id)?.coverage === 'excluding').length}
          onCancel={() => {
            setPurgeIds(null);
          }}
          onConfirm={() => {
            const photoIds = [...purgeIds];
            setPurgeIds(null);
            void window.overlook.library.purge({ photoIds }).then((outcome) => {
              if (outcome.status === 'cancelled') return;
              const { purged, protected: protectedCount, remoteFailures } = outcome.result;
              dispatch({
                type: 'toast/shown',
                toast:
                  protectedCount > 0
                    ? {
                        title: `Deleted ${formatCount(purged)} permanently · preserved ${formatCount(protectedCount)} protected ${protectedCount === 1 ? 'Original' : 'Originals'}`,
                        tone: 'amber',
                      }
                    : remoteFailures > 0
                      ? // Honest partial result: local copies are gone, some
                        // remote copies are orphaned (audited for retry).
                        {
                          title: intl.formatMessage(messages.purgedWithCloudRetry, {
                            purged: formatCount(purged),
                            remoteFailures: formatCount(remoteFailures),
                          }),
                          tone: 'amber',
                        }
                      : { title: intl.formatMessage(messages.purged, { count: purged }), tone: 'neutral' },
              });
            });
          }}
        />
      ) : null}
      {originalDeleteIds === null ? null : (
        <OriginalDeleteDialog
          photoIds={originalDeleteIds}
          onClose={() => setOriginalDeleteIds(null)}
          onDeleted={({ purged, remoteFailures }) => {
            setOriginalDeleteIds(null);
            dispatch({
              type: 'toast/shown',
              toast: {
                title:
                  remoteFailures === 0
                    ? `Deleted ${formatCount(purged)} ${purged === 1 ? 'photo' : 'photos'} permanently`
                    : `Deleted ${formatCount(purged)} locally · ${formatCount(remoteFailures)} cloud pending retry`,
                tone: remoteFailures === 0 ? 'neutral' : 'amber',
              },
            });
          }}
        />
      )}
    </>
  );
}
