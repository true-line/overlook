import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';

import './shell.css';
import { useFormats } from '../i18n/use-formats.js';
import type { AlbumListing, LibraryStats, SourceCounts } from '../../../shared/library/types.js';
import { Icon } from '../components/Icon';
import { TitleBar } from '../components/TitleBar';
import { TitlebarAppMenu, TitlebarHelpMenu } from '../components/TitlebarMenu';
import { ToastHost, type ToastItem } from '../components/Toast';
import { PrimaryLibraryView } from './PrimaryLibraryView';
import { fullUrl } from '../../../shared/library/full-url.js';
import { useExportDialog } from '../export/use-export-dialog';
import { SettingsDialog, type SettingsSection } from '../settings/SettingsDialog';
import { Dialog } from '../components/Dialog';
import { RestoreWorkflow } from '../restore/RestoreWorkflow';
import { useRestoreChrome } from '../restore/use-restore-chrome.js';
import { ImportDialog } from '../import/ImportDialog';
import { Inspector } from '../inspector/Inspector';
import { Lightbox } from '../lightbox/Lightbox';
import { useAppState, useAppDispatch } from '../state/app-state-context';
import { commandPlatform, useCommandDispatcher } from '../state/use-command-dispatcher';
import { useSelectAll } from '../state/use-select-all';
import { commandMenuDialogClass } from '../state/command-menu-dialog';
import { usePhotoKeyTarget } from '../commands/use-photo-key-selection.js';
import { useNativeCommandRouter } from './use-native-command-router';
import { AlbumPicker } from '../grid/AlbumPicker';
import { RECENT_WINDOW_MS } from '../state/use-library-photos';
import { LibrarySwitcher } from './LibrarySwitcher';
import { MoveResumeBanner } from './MoveResumeBanner';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { ToastAction } from './ToastAction';
import { rehydrateFailedToast } from '../offload/offload-summary';
import { useOffloadWorkflow } from '../offload/use-offload-workflow';
import { useCoverageWorkflow } from '../backup-coverage/use-coverage-workflow';
import { Toolbar } from './Toolbar';
import { InteropEntryDialog } from '../interop/InboundMoveDialog';
import type { InteropEntryContext } from '../interop/visible-workflow.js';
import { ProtectedAlbumUnlockDialog } from '../protected/ProtectedAlbumUnlockDialog';
import { ProtectedAlbumView } from '../protected/ProtectedAlbumView';
import { createBoundedExternalDropReporter, installExternalFileDropBoundary } from './external-file-drop';
import { ShortcutHelp } from '../commands/ShortcutHelp';
import type { CommandId, CommandSurface } from '../../../shared/commands/registry.js';
import type { CommandMenuContext } from '../../../shared/commands/menu-contract.js';
import { ActivityDialog } from '../activity/ActivityDialog';
import { DuplicatesDialog } from '../duplicates/DuplicatesDialog';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { SelectionAnnouncer } from '../components/SelectionAnnouncer';
import { useEmptyTrash } from '../grid/use-empty-trash';
import { useDetachedInspector } from '../inspector/use-detached-inspector';
import { deletePhoto } from './delete-photo';

const viewMessages = defineMessages({
  all: { id: 'shell.view.all', defaultMessage: 'All Photos' },
  favorites: { id: 'shell.view.favorites', defaultMessage: 'Favorites' },
  recent: { id: 'shell.view.recent', defaultMessage: 'Recent imports' },
  raw: { id: 'shell.view.raw', defaultMessage: 'RAW' },
  offloaded: { id: 'shell.view.offloaded', defaultMessage: 'Offloaded' },
  unavailable: { id: 'shell.view.unavailable', defaultMessage: 'Unavailable' },
  deleted: { id: 'shell.view.deleted', defaultMessage: 'Trash' },
  album: { id: 'shell.view.album', defaultMessage: 'Album' },
  protected: { id: 'shell.view.protected', defaultMessage: 'Protected album' },
  results: { id: 'shell.results.count', defaultMessage: '{count, plural, one {# result} other {# results}}' },
  restoreTitle: { id: 'settings.restore.title', defaultMessage: 'Restore from cloud backup' },
  switchLibrarySuffix: { id: 'shell.switchLibrarySuffix', defaultMessage: ' — Switch library' },
});

function mergeDropPaths(current: readonly string[] | null, incoming: readonly string[]): readonly string[] {
  return [...new Set([...(current ?? []), ...incoming])];
}

type RestorableDialog = 'export' | 'settings' | 'libraries';

// Composition shell (#73): fixed chrome per README §1. The toolbar, grid,
// sidebar internals, and status bar semantics land with #74–#81 — this keeps
// their regions real (token dims, live counts) so each issue fills in place.
export function Shell({
  platform,
  lockConfigured,
  nativeCommand,
}: {
  readonly platform: string;
  readonly lockConfigured: boolean;
  readonly nativeCommand: { readonly id: CommandId; readonly sequence: number } | null;
}): ReactElement {
  const intl = useIntl();
  const { formatCount, formatRelativeTime } = useFormats();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { announce } = useAnnouncer();
  const offload = useOffloadWorkflow();
  const coverage = useCoverageWorkflow();
  const emptyTrash = useEmptyTrash();
  const restore = useRestoreChrome();
  const [shortcutSurface, setShortcutSurface] = useState<CommandSurface | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const providerStatusRequestRef = useRef(0);
  const exportDialog = useExportDialog();
  // Menu → Photo → Add to Album… opens the picker centered (no cursor anchor).
  const [menuAlbumPickerIds, setMenuAlbumPickerIds] = useState<readonly string[] | null>(null);
  // Menu → File → New Library… opens the switcher straight into create mode.
  const [librariesCreating, setLibrariesCreating] = useState(false);
  const [editableFocus, setEditableFocus] = useState(false);
  const selectAll = useSelectAll();

  useEffect(() => {
    const update = (): void => {
      setEditableFocus(
        document.activeElement instanceof HTMLElement &&
          document.activeElement.closest('input, textarea, select, [contenteditable="true"]') !== null,
      );
    };
    update();
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);

  const [counts, setCounts] = useState<SourceCounts | null>(null);
  // Window drag-and-drop (#237): dropped photo paths pre-seed the dialog's
  // Dropped source; `dragging` shows the full-window overlay.
  const [dropped, setDropped] = useState<readonly string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const dialogStateRef = useRef(state);
  useEffect(() => {
    dialogStateRef.current = state;
  }, [state]);
  const displacedDialogRef = useRef<RestorableDialog | null>(null);
  const openDroppedPaths = useCallback(
    (paths: readonly string[]): void => {
      const current = dialogStateRef.current;
      if (!current.importOpen) {
        displacedDialogRef.current = current.exportOpen
          ? 'export'
          : current.settingsOpen
            ? 'settings'
            : current.librariesOpen
              ? 'libraries'
              : null;
      }
      setDropped((existing) => mergeDropPaths(existing, paths));
      dispatch({ type: 'dialog/set', dialog: 'import', open: true });
    },
    [dispatch],
  );
  const rejectExternalDrop = useCallback((): void => {
    setDropped(null);
    dispatch({ type: 'dialog/set', dialog: 'import', open: false });
    const displacedDialog = displacedDialogRef.current;
    displacedDialogRef.current = null;
    if (displacedDialog !== null) {
      dispatch({ type: 'dialog/set', dialog: displacedDialog, open: true });
    }
    dispatch({ type: 'toast/shown', toast: { title: 'Nothing to import — drop photo files', tone: 'amber' } });
  }, [dispatch]);

  useEffect(() => {
    const boundary = installExternalFileDropBoundary(window, {
      pathForFile: window.overlook.import.pathForFile,
      onDraggingChange: setDragging,
      onPaths: openDroppedPaths,
      onUnsupported: rejectExternalDrop,
      report: createBoundedExternalDropReporter(),
    });
    const offFocus = window.overlook.onFocusChanged(({ focused }) => {
      if (!focused) boundary.reset('window-focus-lost');
    });
    return () => {
      offFocus();
      boundary.dispose();
    };
  }, [openDroppedPaths, rejectExternalDrop]);

  useEffect(() => {
    const unsubscribe = window.overlook.import.onExternalPaths(({ paths }) => openDroppedPaths(paths));
    void window.overlook.import.externalReady();
    return unsubscribe;
  }, [openDroppedPaths]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [albums, setAlbums] = useState<readonly AlbumListing[]>([]);
  // Current library name for the titlebar trigger (#386). Registry reads
  // never require content access, so this works while locked too.
  const [libraryName, setLibraryName] = useState<string | null>(null);
  useEffect(() => {
    void window.overlook.libraries
      .current()
      .then(({ library }) => setLibraryName(library.name))
      .catch(() => setLibraryName(null));
  }, []);
  const [interopEntry, setInteropEntry] = useState<{ readonly context: InteropEntryContext; readonly total: number } | null>(null);
  const [pcloudEnabled, setPcloudEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void window.overlook.backup
      .providers()
      .then(({ providers }) => {
        if (active) setPcloudEnabled(providers.some(({ id }) => id === 'pcloud'));
      })
      .catch(() => {
        if (active) setPcloudEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const openInterop = (context: InteropEntryContext, records: readonly string[] | number): void => {
    if (!pcloudEnabled) return;
    setInteropEntry({ context, total: typeof records === 'number' ? records : records.length });
  };
  const [protectedAlbums, setProtectedAlbums] = useState<
    readonly {
      readonly id: string;
      readonly label: string;
      readonly locked: boolean;
      readonly name?: string | undefined;
      readonly count?: number | undefined;
    }[]
  >([]);
  const [unlockAlbumId, setUnlockAlbumId] = useState<string | null>(null);
  const unlockOriginRef = useRef<HTMLButtonElement | null>(null);

  const runNativeCommand = useNativeCommandRouter({
    nativeCommand,
    state,
    dispatch,
    onSelectAll: selectAll,
    setShortcutSurface,
    setSettingsSection,
    exportDialog,
    setAlbumPickerIds: setMenuAlbumPickerIds,
    setLibrariesCreating,
    resetInteropEntry: () => setInteropEntry(null),
    resetUnlockAlbum: () => setUnlockAlbumId(null),
    resetDropped: () => setDropped(null),
    closeOffload: offload.close,
    pcloudEnabled,
    lockConfigured,
  });
  useCommandDispatcher(platform, setShortcutSurface, shortcutSurface !== null, selectAll, runNativeCommand);

  const hasKey = usePhotoKeyTarget(state);
  const inspectorSelectionPosition = useDetachedInspector(state, dispatch);
  const inspectorPhotoIds = useMemo(() => (state.selection.size === 0 ? [] : [...state.selection]), [state.selection]);

  // One menu context feeds the macOS native menu (through main) and the
  // Windows/Linux ⋯ Overlook menu, so both enable the same commands (#1293).
  const menuContext = useMemo((): CommandMenuContext => {
    const target = state.photos.find(({ id }) => id === state.lightboxId);
    return {
      surface: state.lightboxId === null ? 'grid' : 'lightbox',
      dialog: commandMenuDialogClass(state, {
        shortcut: shortcutSurface !== null,
        interop: interopEntry !== null,
        unlock: unlockAlbumId !== null,
        offload: offload.activePhotoIds !== null,
      }),
      editable: editableFocus,
      hasLibrary: true,
      hasPhotos: state.photos.length > 0,
      hasTarget: target !== undefined,
      targetTrashable: target?.deletedAt === null,
      inAlbum: state.album !== null,
      protectedAlbumOpen: state.protectedAlbum !== null,
      hasPhotoKeyTarget: hasKey,
      selectionCount: state.selection.size,
      appLockConfigured: lockConfigured,
      providerBusy: false,
      pcloudEnabled,
      inspectorOpen: state.inspectorOpen,
      view: state.view,
      source: state.source,
    };
  }, [hasKey, editableFocus, interopEntry, lockConfigured, offload.activePhotoIds, pcloudEnabled, shortcutSurface, state, unlockAlbumId]);

  useEffect(() => {
    void window.overlook.commands.updateContext(menuContext);
  }, [menuContext]);

  const refreshProtected = useCallback((): void => {
    void window.overlook.protectedAlbums.list().then(async ({ albums: opaque }) => {
      const visible = await Promise.all(
        opaque.map(async (album) => {
          if (album.locked) return album;
          try {
            const summary = await window.overlook.protectedAlbums.summary({ albumId: album.id });
            return { ...album, name: summary.name, count: summary.count };
          } catch {
            return { ...album, locked: true };
          }
        }),
      );
      setProtectedAlbums(visible);
    });
  }, []);

  useEffect(() => {
    const refreshStats = (): void => {
      void window.overlook.library.stats().then((loaded) => {
        setStats(loaded);
        // Seed the backup state (#79); pushes keep it live afterwards.
        dispatch({ type: 'pendingCount/set', count: loaded.pending });
        // Real stamp (#104): locale-aware relative time from the ledger, or "Never"
        // before the first verified backup.
        dispatch({
          type: 'backupLabel/set',
          label: loaded.lastBackupAt === null ? 'Never' : formatRelativeTime(loaded.lastBackupAt, Date.now()),
        });
      });
    };
    const refresh = (): void => {
      const recentSince = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
      void window.overlook.library.counts({ recentSince }).then(setCounts);
      refreshStats();
      void window.overlook.library.albums().then(({ albums: loaded }) => {
        setAlbums(loaded);
      });
    };
    refresh();
    refreshProtected();
    // Counts/stats live-update on library mutations (#80 exit criteria) —
    // targeted pushes, never refetch-the-world from the renderer's loops.
    // Per-item pending pushes already update AppStateProvider. Refreshing all
    // summaries for each upload caused 1,500 redundant IPC bursts; completion
    // reconciles stats and the verified-backup stamp once instead.
    const offChanged = window.overlook.library.onChanged(refresh);
    const offStorageChanged = window.overlook.library.onStorageChanged(refresh);
    const offCompleted = window.overlook.backup.onCompleted(refresh);
    const offProtectedChanged = window.overlook.protectedAlbums.onChanged(() => {
      refresh();
      refreshProtected();
    });
    return () => {
      offChanged();
      offStorageChanged();
      offCompleted();
      offProtectedChanged();
    };
  }, [dispatch, formatRelativeTime, refreshProtected]);

  // Settings truth (#113): seed the reducer's sortOrder from the store and
  // follow changed pushes — a sort change in the dialog re-orders the grid
  // live via the query hook's refetch.
  useEffect(() => {
    const effectRequest = providerStatusRequestRef.current + 1;
    providerStatusRequestRef.current = effectRequest;
    const syncProvider = (selectedId: string | null): void => {
      const request = providerStatusRequestRef.current + 1;
      providerStatusRequestRef.current = request;
      void window.overlook.backup.providers().then(({ providers, defaultProviderId }) => {
        if (providerStatusRequestRef.current !== request) return;
        const preferred = providers.find((provider) => provider.id === selectedProviderId);
        const persisted = providers.find((provider) => provider.id === selectedId);
        const fallback = providers.find((provider) => provider.id === defaultProviderId);
        const publish = (descriptor: (typeof providers)[number] | undefined): void => {
          if (descriptor === undefined) {
            dispatch({ type: 'provider/set', connected: false, label: 'Cloud' });
            return;
          }
          void window.overlook.backup
            .providerStatus({ providerId: descriptor.id })
            .then(({ connected, provider }) => {
              if (providerStatusRequestRef.current !== request) return;
              dispatch({ type: 'provider/set', connected, label: provider.label });
            })
            .catch(() => {
              if (providerStatusRequestRef.current !== request) return;
              dispatch({ type: 'provider/set', connected: false, label: descriptor.label });
            });
        };
        if (preferred !== undefined && persisted !== undefined && preferred.id !== persisted.id) {
          void window.overlook.backup
            .providerStatus({ providerId: persisted.id })
            .then(({ connected, provider }) => {
              if (providerStatusRequestRef.current !== request) return;
              if (connected) {
                setSelectedProviderId(null);
                dispatch({ type: 'provider/set', connected: true, label: provider.label });
                return;
              }
              publish(preferred);
            })
            .catch(() => {
              if (providerStatusRequestRef.current !== request) return;
              publish(preferred);
            });
          return;
        }
        publish(preferred ?? persisted ?? fallback);
      });
    };
    void window.overlook.settings.get().then(({ settings }) => {
      if (providerStatusRequestRef.current !== effectRequest) return;
      dispatch({ type: 'sortOrder/set', order: settings.sortOrder });
      syncProvider(settings.providerId);
    });
    const unsubscribe = window.overlook.settings.onChanged(({ settings }) => {
      dispatch({ type: 'sortOrder/set', order: settings.sortOrder });
      syncProvider(settings.providerId);
    });
    return () => {
      providerStatusRequestRef.current += 1;
      unsubscribe();
    };
  }, [dispatch, selectedProviderId]);

  // Backup completion (#106): failures surface as the red toast with a
  // Retry action; the pending/count refresh rides the existing pushes.
  useEffect(() => {
    return window.overlook.backup.onCompleted(({ uploaded, failed, manifestUploaded, auto, integrity }) => {
      if (failed > 0) {
        dispatch({
          type: 'toast/shown',
          toast: { title: `Backup: ${formatCount(failed)} failed — will retry`, tone: 'red', action: 'retry-backup' },
        });
      } else if (integrity.unrecoverable > 0) {
        // Confirmed loss blocks the manifest generation too (#741), so this
        // truth must outrank the generic index-pending message.
        dispatch({
          type: 'toast/shown',
          toast: { title: `Backup damaged: ${formatCount(integrity.unrecoverable)} originals missing`, tone: 'red' },
        });
      } else if (!manifestUploaded) {
        // Blobs verified but the remote is owed its manifest generation —
        // without it the backup is not restorable (PR #204 review).
        dispatch({
          type: 'toast/shown',
          toast: { title: 'Backup index pending — will retry', tone: 'red', action: 'retry-backup' },
        });
      } else if (integrity.failed) {
        dispatch({
          type: 'toast/shown',
          toast: { title: 'Backup check incomplete — will retry', tone: 'red', action: 'retry-backup' },
        });
      } else if (uploaded > 0 && !auto) {
        const detail = integrity.recoveryRepaired
          ? ' · recovery index repaired'
          : integrity.repaired > 0
            ? ` · ${formatCount(integrity.repaired)} cloud copies repaired`
            : '';
        dispatch({ type: 'toast/shown', toast: { title: `Backup complete${detail}`, tone: 'green' } });
      } else if (integrity.recoveryRepaired) {
        dispatch({ type: 'toast/shown', toast: { title: 'Backup recovery index repaired', tone: 'green' } });
      } else if (integrity.repaired > 0) {
        dispatch({
          type: 'toast/shown',
          toast: { title: `Backup repaired: ${formatCount(integrity.repaired)} cloud copies`, tone: 'green' },
        });
      }
    });
  }, [dispatch, formatCount]);

  // Neighbor prefetch (#91/#93): whenever the lightbox photo changes, warm
  // both adjacent frames so ←/→ (clicks OR keys) never stall.
  const lightboxId = state.lightboxId;
  const photos = state.photos;
  useEffect(() => {
    if (lightboxId === null || photos.length < 2) {
      return;
    }
    const index = photos.findIndex((photo) => photo.id === lightboxId);
    if (index === -1) {
      return;
    }
    for (const hop of [-1, 1]) {
      const neighbor = photos[(index + hop + photos.length) % photos.length];
      if (neighbor !== undefined && neighbor.id !== lightboxId) {
        void fetch(fullUrl(neighbor.id, { prefetch: true })).catch(() => undefined);
      }
    }
  }, [lightboxId, photos]);

  const toast = state.toast;
  const toastItems = useMemo<readonly ToastItem[]>(
    () => [
      ...restore.restoreToasts,
      ...(toast === null
        ? []
        : [
            {
              id: 'shell-toast',
              tone: toast.tone,
              title: toast.title,
              ...(toast.announce === false ? { announce: false } : {}),
              ...(toast.action === undefined ? {} : { action: <ToastAction toast={toast} /> }),
            } satisfies ToastItem,
          ]),
    ],
    [restore.restoreToasts, toast],
  );
  const activeAlbum = albums.find((album) => album.id === state.album);
  const activeSmartAlbum = albums.find((album) => album.id === state.smartAlbum) ?? null;
  const activeProtectedAlbum = protectedAlbums.find((album) => album.id === state.protectedAlbum);
  const viewTitle =
    state.protectedAlbum !== null
      ? (activeProtectedAlbum?.name ?? activeProtectedAlbum?.label ?? intl.formatMessage(viewMessages.protected))
      : state.album !== null || state.smartAlbum !== null
        ? (activeAlbum?.name ?? activeSmartAlbum?.name ?? intl.formatMessage(viewMessages.album))
        : intl.formatMessage(viewMessages[state.source]);
  const previousPhotos = useRef(state.photos);
  useEffect(() => {
    if (previousPhotos.current === state.photos) return;
    previousPhotos.current = state.photos;
    if (state.query !== '' || Object.values(state.chips).some(Boolean)) {
      announce(intl.formatMessage(viewMessages.results, { count: state.photos.length }), 'polite', 'search-results');
    }
  }, [announce, intl, state.chips, state.photos, state.query]);

  return (
    // OS file drops are owned by the capture-boundary effect above, including
    // portals outside this subtree. The toolbar Import button remains the
    // non-drag equivalent required by SC 2.5.7.
    <div className="ovl-shell">
      <SelectionAnnouncer count={state.selection.size} />
      <a className="ovl-skip-link" href="#photo-grid">
        <FormattedMessage id="shell.skipToPhotos" defaultMessage="Skip to photos" />
      </a>
      {dragging ? (
        <div className="ovl-shell__dropOverlay">
          <div className="ovl-shell__dropCard">
            <Icon name="image-down" size={40} color="var(--accent-cyan)" />
            <div className="ovl-shell__dropTitle">Drop photos to import</div>
            <div className="ovl-shell__dropHint prose-note">Encrypted on this device · RAW, JPEG, PNG, HEIC</div>
          </div>
        </div>
      ) : null}
      <TitleBar
        platform={platform}
        center={
          <button
            type="button"
            className="ovl-library-trigger"
            data-testid="library-trigger"
            onClick={() => dispatch({ type: 'dialog/set', dialog: 'libraries', open: true })}
          >
            <Icon name="images" size={13} />
            <span>{libraryName ?? 'Overlook'}</span>
            <span className="ovl-sr-only">{intl.formatMessage(viewMessages.switchLibrarySuffix)}</span>
            <Icon name="chevrons-up-down" size={12} color="var(--text-faint)" />
          </button>
        }
        appMenu={<TitlebarAppMenu platform={platform} context={menuContext} onCommand={runNativeCommand} />}
        help={<TitlebarHelpMenu platform={platform} onCommand={runNativeCommand} />}
        onMinimize={() => {
          void window.overlook.minimizeWindow();
        }}
        onToggleMaximize={() => {
          void window.overlook.toggleMaximizeWindow();
        }}
        onClose={() => {
          void window.overlook.closeWindow();
        }}
      />
      <MoveResumeBanner />
      <Toolbar
        platform={commandPlatform(platform)}
        albums={albums}
        onLock={lockConfigured ? () => void window.overlook.appLock.lockNow() : undefined}
        onImport={() => {
          // #237: the dialog owns source discovery (SD scan, folder picker,
          // no-card empty state) — the toolbar just opens it.
          setDropped(null);
          dispatch({ type: 'dialog/set', dialog: 'import', open: true });
        }}
      />
      {state.importOpen ? (
        <ImportDialog
          open
          dropped={dropped}
          onClose={() => {
            setDropped(null);
            displacedDialogRef.current = null;
            dispatch({ type: 'dialog/set', dialog: 'import', open: false });
          }}
          onDone={() => {
            // "Show in library" jumps to Recent imports (#88).
            dispatch({ type: 'source/set', source: 'recent' });
          }}
          onRejectedDrop={rejectExternalDrop}
          onComplete={(imported) => {
            // Green completion toast with exact counts + Show action (#89).
            dispatch({
              type: 'toast/shown',
              toast: { title: `Imported ${formatCount(imported)} photos`, tone: 'green', action: 'show-recent' },
            });
          }}
        />
      ) : null}
      {exportDialog.dialog}
      {offload.dialog}
      {coverage.dialog}
      {state.librariesOpen ? (
        <LibrarySwitcher
          startInCreate={librariesCreating}
          onCurrentNameChange={setLibraryName}
          onClose={() => {
            setLibrariesCreating(false);
            dispatch({ type: 'dialog/set', dialog: 'libraries', open: false });
          }}
        />
      ) : null}
      {menuAlbumPickerIds === null ? null : (
        <div className="ovl-menu-album-picker">
          <AlbumPicker
            onPick={(album) => {
              const photoIds = menuAlbumPickerIds;
              setMenuAlbumPickerIds(null);
              void window.overlook.albums.addPhotos({ albumId: album.id, photoIds: [...photoIds] }).then(({ added }) => {
                dispatch({
                  type: 'toast/shown',
                  toast: { title: `Added ${formatCount(added)} ${added === 1 ? 'photo' : 'photos'} to ${album.name}`, tone: 'green' },
                });
              });
            }}
            onClose={() => setMenuAlbumPickerIds(null)}
          />
        </div>
      )}
      {state.settingsOpen ? (
        <SettingsDialog
          open
          requestedSection={settingsSection}
          selectedPhotoIds={[...state.selection]}
          transferEnabled={pcloudEnabled}
          onTransfer={pcloudEnabled ? () => openInterop('settings', [...state.selection]) : undefined}
          preferredProviderId={selectedProviderId}
          onProviderSelection={(provider) => {
            setSelectedProviderId(provider.id);
            dispatch({ type: 'provider/set', connected: false, label: provider.label });
          }}
          onRestore={restore.openRestore}
          onClose={() => {
            setSettingsSection(undefined);
            dispatch({ type: 'dialog/set', dialog: 'settings', open: false });
          }}
        />
      ) : null}
      {restore.restoreOpen ? (
        <Dialog open title={intl.formatMessage(viewMessages.restoreTitle)} icon="cloud-download" width={640} onClose={restore.closeRestore}>
          <RestoreWorkflow context="settings" />
        </Dialog>
      ) : null}
      {state.activityOpen ? (
        <ActivityDialog
          open
          onClose={() => {
            dispatch({ type: 'dialog/set', dialog: 'activity', open: false });
          }}
        />
      ) : null}
      {state.duplicatesOpen ? (
        <DuplicatesDialog
          open
          dispatch={dispatch}
          onClose={() => {
            dispatch({ type: 'dialog/set', dialog: 'duplicates', open: false });
          }}
        />
      ) : null}
      {shortcutSurface === null ? null : (
        <ShortcutHelp
          context={{ surface: shortcutSurface, dialogOpen: false, editable: false, platform: commandPlatform(platform) }}
          platform={commandPlatform(platform)}
          onClose={() => setShortcutSurface(null)}
        />
      )}
      {unlockAlbumId === null ? null : (
        <ProtectedAlbumUnlockDialog
          key={unlockAlbumId}
          albumId={unlockAlbumId}
          onClose={() => {
            setUnlockAlbumId(null);
            const origin = unlockOriginRef.current;
            unlockOriginRef.current = null;
            requestAnimationFrame(() => origin?.isConnected === true && origin.focus());
          }}
          onDone={(outcome) => {
            const albumId = unlockAlbumId;
            setUnlockAlbumId(null);
            unlockOriginRef.current = null;
            refreshProtected();
            if (outcome === 'opened') {
              dispatch({ type: 'protectedAlbum/set', albumId });
              return;
            }
            dispatch({
              type: 'toast/shown',
              toast: {
                title: outcome === 'protection-completed' ? 'Protection completed — unlock again to open' : 'Protection removed safely',
                tone: 'green',
              },
            });
          }}
        />
      )}
      {(() => {
        // Lightbox (#92): overlay above the shell, driven by reducer state.
        // Arrows and keys (#93) share the reducer's lightbox/stepped
        // wraparound; the effect above prefetches neighbors on every change.
        const index = state.photos.findIndex((photo) => photo.id === state.lightboxId);
        const current = index === -1 ? null : (state.photos[index] ?? null);
        if (current === null) {
          return null;
        }
        return (
          <Lightbox
            platform={platform}
            photo={current}
            onClose={() => {
              dispatch({ type: 'lightbox/closed' });
            }}
            onPrev={() => {
              dispatch({ type: 'lightbox/stepped', delta: -1 });
            }}
            onNext={() => {
              dispatch({ type: 'lightbox/stepped', delta: 1 });
            }}
            onToggleFavorite={() => {
              void window.overlook.library.toggleFavorite({ id: current.id }).then(({ pendingCount }) => {
                dispatch({ type: 'pendingCount/set', count: pendingCount });
              });
            }}
            inspectorOpen={state.inspectorOpen}
            onToggleInspector={() => {
              dispatch({ type: 'inspector/toggled' });
            }}
            // Lightbox entry point (#100): count=1, the focused photo.
            onExport={() => exportDialog.openPhotos([current.id])}
            onTransfer={pcloudEnabled ? () => openInterop('lightbox', [current.id]) : undefined}
            onOffload={() => {
              offload.open([current.id], false, () => dispatch({ type: 'lightbox/closed' }));
            }}
            suppressRehydrate={offload.activePhotoIds?.includes(current.id) === true}
            onRehydrateError={() => dispatch({ type: 'toast/shown', toast: rehydrateFailedToast(state.providerLabel) })}
            onEditResult={(result) => {
              dispatch({ type: 'pendingCount/set', count: result.pendingCount });
              if (result.derivatives === 'deferred') {
                dispatch({
                  type: 'toast/shown',
                  toast: { title: 'Edit saved — thumbnails update once the original is local again', tone: 'amber' },
                });
              } else if (result.derivatives === 'failed') {
                dispatch({ type: 'toast/shown', toast: { title: 'Edit saved — thumbnails could not be regenerated', tone: 'red' } });
              }
            }}
            onEditError={() => {
              dispatch({ type: 'toast/shown', toast: { title: 'Edit could not be saved', tone: 'red' } });
            }}
            onRepairDimensions={(width, height) => {
              void window.overlook.library.repairDimensions({ id: current.id, width, height }).then(({ pendingCount }) => {
                dispatch({ type: 'pendingCount/set', count: pendingCount });
              });
            }}
            onDelete={() => {
              // Soft delete (#120): the change push drops the row from the
              // visible set, which closes the lightbox in the reducer.
              deletePhoto(current.id, dispatch);
            }}
          />
        );
      })()}
      <div className="ovl-shell__body">
        {state.sidebarOpen ? (
          <Sidebar
            platform={commandPlatform(platform)}
            counts={counts}
            stats={stats}
            albums={albums}
            onTransferAlbum={pcloudEnabled ? (album) => openInterop('album', album.count) : undefined}
            onEmptyTrash={emptyTrash.open}
            protectedAlbums={protectedAlbums}
            onProtectedOpen={(albumId, origin) => {
              const album = protectedAlbums.find((candidate) => candidate.id === albumId);
              if (album?.locked === false) {
                dispatch({ type: 'protectedAlbum/set', albumId });
                return;
              }
              unlockOriginRef.current = origin;
              setUnlockAlbumId(albumId);
            }}
          />
        ) : null}
        {emptyTrash.dialog}
        <main
          className="ovl-shell__content"
          data-testid="content-region"
          aria-label={state.protectedAlbum === null ? undefined : viewTitle}
          aria-labelledby={state.protectedAlbum === null ? 'overlook-view-heading' : undefined}
        >
          {state.protectedAlbum === null ? (
            <h1 id="overlook-view-heading" className="ovl-sr-only">
              {viewTitle}
            </h1>
          ) : null}
          {state.protectedAlbum === null ? (
            <PrimaryLibraryView
              platform={commandPlatform(platform)}
              knownTotal={counts === null ? null : counts[state.source]}
              activeAlbum={albums.find((album) => album.id === state.album) ?? null}
              activeSmartAlbum={activeSmartAlbum}
              onExport={exportDialog.openPhotos}
              onBoardExport={exportDialog.openBoard}
              onOffload={offload.open}
              onKeepOnDevice={coverage.open}
              onBackUpAgain={coverage.include}
              onTransfer={pcloudEnabled ? openInterop : undefined}
            />
          ) : (
            <ProtectedAlbumView
              key={state.protectedAlbum}
              albumId={state.protectedAlbum}
              onRelocked={() => {
                dispatch({ type: 'protectedAlbum/set', albumId: null });
                refreshProtected();
                dispatch({ type: 'toast/shown', toast: { title: 'Protected album relocked', tone: 'neutral' } });
              }}
            />
          )}
        </main>
        {state.inspectorOpen && state.protectedAlbum === null ? (
          <aside className="ovl-shell__inspector" aria-label="Inspector">
            <Inspector
              providerLabel={state.providerLabel}
              photo={state.photos.find((photo) => photo.id === state.inspectorPhotoId) ?? null}
              photoIds={inspectorPhotoIds}
              selectionPosition={inspectorSelectionPosition}
              onPrevious={() => dispatch({ type: 'inspector/stepped', delta: -1 })}
              onNext={() => dispatch({ type: 'inspector/stepped', delta: 1 })}
              onShowPhoto={(photoId) => dispatch({ type: 'lightbox/opened', photoId })}
            />
          </aside>
        ) : null}
      </div>
      <ToastHost
        className="ovl-shell__toast"
        toasts={toastItems}
        onDismiss={(id) => {
          if (id === 'restore-background') restore.dismissRestoreToast();
          else dispatch({ type: 'toast/dismissed' });
        }}
      />
      <StatusBar
        stats={stats}
        counts={counts}
        restore={restore.restoreChip}
        onRestoreClick={restore.openRestore}
        onInclusionClick={() => {
          setSettingsSection('general');
          dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
        }}
      />
      <InteropEntryDialog entry={interopEntry} onClose={() => setInteropEntry(null)} />
    </div>
  );
}
