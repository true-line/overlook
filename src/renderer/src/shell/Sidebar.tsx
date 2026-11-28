import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';

import { useFormats } from '../i18n/use-formats.js';
import { directionOf } from '../../../shared/i18n/locales.js';
import type { AlbumListing, AlbumSummary, LibraryStats, SourceCounts, SourceFilter } from '../../../shared/library/types.js';
import { Icon, type IconName } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { Tooltip } from '../components/Tooltip';
import { EMPTY_PREDICATE } from '../../../shared/library/smart-album.js';
import { useAppState, useAppDispatch } from '../state/app-state-context';
import { AlbumActionMenu } from './AlbumActionMenu';
import { DeleteAlbumDialog, RenameAlbumDialog } from './AlbumDialogs';
import { AlbumTagsDialog, DeleteFolderDialog, MoveAlbumDialog, NewCollectionDialog } from './AlbumFolderDialogs';
import { AlbumDropDialog } from './AlbumDropDialog';
import { AlbumTree } from './AlbumTree';
import { SideRow } from './SideRow';
import { useAlbumPhotoDrop } from './use-album-photo-drop';
import { ContextMenu } from '../components/ContextMenu';
import { commandById } from '../../../shared/commands/registry.js';
import type { CommandPlatform } from '../../../shared/commands/registry.js';
import { useAlbumReorder } from './use-album-reorder';

// The shell stylesheet carries the sidebar/rail rules; importing it here
// (not just in Shell) keeps the component styled when mounted alone, e.g.
// by its stories (PR #245).
import './shell.css';

const messages = defineMessages({
  nav: { id: 'sidebar.nav', defaultMessage: 'Library' },
  headingLibrary: { id: 'sidebar.heading.library', defaultMessage: 'Library' },
  headingAlbums: { id: 'sidebar.heading.albums', defaultMessage: 'Albums' },
  headingProtected: { id: 'sidebar.heading.protected', defaultMessage: 'Protected' },
  expand: { id: 'sidebar.expand', defaultMessage: 'Expand sidebar' },
  collapse: { id: 'sidebar.collapse', defaultMessage: 'Collapse sidebar' },
  newAlbum: { id: 'sidebar.album.new', defaultMessage: 'New album' },
  newFolder: { id: 'sidebar.folder.new', defaultMessage: 'New folder' },
  albumName: { id: 'sidebar.album.name', defaultMessage: 'Album name' },
  settings: { id: 'sidebar.settings', defaultMessage: 'Settings' },
  encrypted: { id: 'sidebar.encrypted', defaultMessage: 'Library encrypted' },
  encryptedOpenSettings: { id: 'sidebar.encrypted.openSettings', defaultMessage: 'Library encrypted — open Settings' },
  storageOnDisk: { id: 'sidebar.storage.onDisk', defaultMessage: '{bytes} on disk' },
  storageOffload: { id: 'sidebar.storage.offload', defaultMessage: '{bytes} offload ({provider})' },
  storageExcluded: { id: 'sidebar.storage.excluded', defaultMessage: '{bytes} excluded from backup' },
  localCustodyProblems: {
    id: 'sidebar.storage.localProblems',
    defaultMessage:
      '{missing, plural, one {# local original missing} other {# local originals missing}} · {corrupt, plural, one {# local original corrupt} other {# local originals corrupt}}',
  },
  connect: { id: 'sidebar.connect', defaultMessage: 'Connect' },
  sourceAll: { id: 'sidebar.source.all', defaultMessage: 'All Photos' },
  sourceFavorites: { id: 'sidebar.source.favorites', defaultMessage: 'Favorites' },
  sourceRecent: { id: 'sidebar.source.recent', defaultMessage: 'Recent imports' },
  sourceRaw: { id: 'sidebar.source.raw', defaultMessage: 'RAW' },
  sourceOffloaded: { id: 'sidebar.source.offloaded', defaultMessage: 'Offloaded' },
  sourceUnavailable: { id: 'sidebar.source.unavailable', defaultMessage: 'Unavailable' },
  sourceDeleted: { id: 'sidebar.source.deleted', defaultMessage: 'Trash' },
  createdFolder: { id: 'sidebar.folder.created', defaultMessage: 'Created folder {name}' },
  createdAlbum: { id: 'sidebar.album.created', defaultMessage: 'Created album {name}' },
  createFailed: { id: 'sidebar.album.createFailed', defaultMessage: 'Could not create {name}. Press Enter in the name field to retry.' },
  visibilityFailed: {
    id: 'sidebar.album.visibilityFailed',
    defaultMessage: 'Could not change visibility for {name}. Reopen its actions menu to retry.',
  },
  movedToFolder: { id: 'sidebar.album.movedToFolder', defaultMessage: 'Moved {name} to {folder}' },
  movedToTop: { id: 'sidebar.album.movedToTop', defaultMessage: 'Moved {name} to the top level' },
  deletedFolder: {
    id: 'sidebar.folder.deleted',
    defaultMessage:
      'Deleted {name} · {folders, plural, one {# folder} other {# folders}}, {albums, plural, one {# album} other {# albums}}{smart, plural, =0 {} one {, # Smart Album} other {, # Smart Albums}} removed · photos kept',
  },
  savedTags: { id: 'sidebar.album.tagsSaved', defaultMessage: 'Saved tags for {name}' },
  deletedSmart: { id: 'sidebar.smart.deleted', defaultMessage: 'Deleted Smart Album {name} · photos kept' },
  duplicated: { id: 'sidebar.smart.duplicated', defaultMessage: 'Duplicated {name} as {copy}' },
  duplicateFailed: { id: 'sidebar.smart.duplicateFailed', defaultMessage: 'Could not duplicate {name}' },
});

const SOURCES: readonly { key: SourceFilter; icon: IconName; label: MessageDescriptor }[] = [
  { key: 'all', icon: 'images', label: messages.sourceAll },
  { key: 'favorites', icon: 'star', label: messages.sourceFavorites },
  { key: 'recent', icon: 'download', label: messages.sourceRecent },
  { key: 'raw', icon: 'aperture', label: messages.sourceRaw },
  { key: 'offloaded', icon: 'cloud', label: messages.sourceOffloaded },
  { key: 'unavailable', icon: 'image-off', label: messages.sourceUnavailable },
  { key: 'deleted', icon: 'trash-2', label: messages.sourceDeleted },
];

// Derived sources earn their row once they have members (#268 precedent for
// Offloaded): an always-empty RAW or Unavailable destination reads as broken,
// and the count is exact the moment real rows exist (#512).
const DERIVED_SOURCES = new Set<SourceFilter>(['raw', 'offloaded', 'unavailable']);

// Collapsed state persists across launches under the mock's own key (#238).
const COLLAPSE_KEY = 'overlook.sidebarCollapsed';
// Folder disclosure is per-profile view state (ADR-0030 §5, #505): the ids
// of collapsed folders, never backed up. Folders start expanded.
const FOLDERS_KEY = 'overlook.albumFoldersCollapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function readCollapsedFolders(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(FOLDERS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export interface SidebarProps {
  readonly platform: CommandPlatform;
  readonly counts: SourceCounts | null;
  readonly stats: LibraryStats | null;
  readonly albums: readonly AlbumListing[];
  readonly onTransferAlbum?: ((album: AlbumSummary) => void) | undefined;
  readonly protectedAlbums?: readonly {
    readonly id: string;
    readonly label: string;
    readonly locked: boolean;
    readonly name?: string | undefined;
    readonly count?: number | undefined;
  }[];
  readonly onProtectedOpen?: ((albumId: string, origin: HTMLButtonElement) => void) | undefined;
  readonly onEmptyTrash?: (() => void) | undefined;
}

type CollectionDialog =
  | { readonly kind: 'new'; readonly collection: 'album' | 'folder'; readonly parent: AlbumListing | null }
  | { readonly kind: 'rename'; readonly album: AlbumListing }
  | { readonly kind: 'delete'; readonly album: AlbumListing }
  | { readonly kind: 'move'; readonly album: AlbumListing }
  | { readonly kind: 'tags'; readonly album: AlbumListing };

// The 216px navigation rail (#80) per the design's Sidebar.jsx. Album
// creation and management are keyboard-accessible here; the backup card
// shows the encrypted badge, the settings gear (opens the M09 dialog), a
// live aggregate bar while a backup runs (#108), and the mono storage line.
export function Sidebar({
  platform,
  counts,
  stats,
  albums,
  onTransferAlbum,
  protectedAlbums = [],
  onProtectedOpen,
  onEmptyTrash,
}: SidebarProps): ReactElement {
  const intl = useIntl();
  const direction = directionOf(intl.locale);
  const inlineEndSide = direction === 'rtl' ? 'left' : 'right';
  const { formatBytes, formatCount } = useFormats();
  const state = useAppState();
  const dispatch = useAppDispatch();
  // Folders never hold photos (ADR-0030 §1): only albums are drop targets.
  const albumDrop = useAlbumPhotoDrop(albums.filter((album) => album.kind === 'album'));
  // Collapse to the 56px icon rail (#238): labels/counts move to tooltips,
  // headings become dividers, the backup card becomes the shield button.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [collapsedFolders, setCollapsedFolders] = useState(readCollapsedFolders);
  const albumReorder = useAlbumReorder(albums, (parentId) => {
    if (parentId === null) return;
    setCollapsedFolders((current) => {
      const next = new Set(current);
      const seen = new Set<string>();
      let cursor: string | null = parentId;
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        next.delete(cursor);
        cursor = albums.find((album) => album.id === cursor)?.parentId ?? null;
      }
      return next;
    });
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(FOLDERS_KEY, JSON.stringify([...collapsedFolders]));
    } catch {
      // Best-effort, like the rail state; the current view still updates.
    }
  }, [collapsedFolders]);
  const [sourceMenu, setSourceMenu] = useState<{ readonly x: number; readonly y: number; readonly origin: HTMLButtonElement } | null>(null);
  const toggleCollapsed = (): void => {
    const next = !collapsed;
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // Persistence is best-effort; the in-session toggle still works.
    }
    setCollapsed(next);
  };
  const toggleFolder = (folderId: string): void => {
    const next = new Set(collapsedFolders);
    if (next.has(folderId)) next.delete(folderId);
    else next.add(folderId);
    setCollapsedFolders(next);
  };
  // The card's aggregate bar rides backup:progress (#108); it hides again
  // when the run finishes (done === total).
  const [backupRun, setBackupRun] = useState<{ done: number; total: number } | null>(null);
  // Inline album creation (#117) — the design gives the + affordance but no
  // flow; an inline name row keeps it keyboard-first (Enter/Escape).
  const [namingAlbum, setNamingAlbum] = useState(false);
  const [albumName, setAlbumName] = useState('');
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const newAlbumRef = useRef<HTMLButtonElement>(null);
  const albumNameRef = useRef<HTMLInputElement>(null);
  const restoreNewAlbumFocus = useRef(false);
  useLayoutEffect(() => {
    if (creatingAlbum || namingAlbum || !restoreNewAlbumFocus.current) return;
    restoreNewAlbumFocus.current = false;
    newAlbumRef.current?.focus();
  }, [creatingAlbum, namingAlbum]);
  const [albumMenu, setAlbumMenu] = useState<{ readonly album: AlbumListing; readonly x: number; readonly y: number } | null>(null);
  const [dialog, setDialog] = useState<CollectionDialog | null>(null);
  const allPhotosRef = useRef<HTMLButtonElement>(null);
  const albumActionOriginRef = useRef<HTMLElement | null>(null);
  const restoreAlbumActionFocus = (fallback: HTMLElement | null = allPhotosRef.current): void => {
    const origin = albumActionOriginRef.current;
    albumActionOriginRef.current = null;
    requestAnimationFrame(() => {
      (origin?.isConnected === true ? origin : fallback)?.focus();
    });
  };
  const closeDialog = (): void => {
    setDialog(null);
    restoreAlbumActionFocus();
  };
  const toast = (title: string, tone: 'green' | 'neutral' = 'green'): void => {
    dispatch({ type: 'toast/shown', toast: { title, tone } });
  };
  const setVisibility = (album: AlbumListing, showInAllPhotos: boolean | 'inherit'): void => {
    setAlbumMenu(null);
    restoreAlbumActionFocus();
    // Listing/count changes arrive only after the authoritative library push.
    void window.overlook.albums.setVisibility({ albumId: album.id, showInAllPhotos }).catch(() =>
      dispatch({
        type: 'toast/shown',
        toast: { title: intl.formatMessage(messages.visibilityFailed, { name: album.name }), tone: 'red' },
      }),
    );
  };
  // The opener belongs to a row being removed: move focus to a stable
  // destination instead of leaving keyboard focus on body.
  const completeRemoval = (removedIds: readonly string[]): void => {
    const open = state.album ?? state.smartAlbum;
    if (open !== null && removedIds.includes(open)) dispatch({ type: 'source/set', source: 'all' });
    setDialog(null);
    albumActionOriginRef.current = null;
    requestAnimationFrame(() => allPhotosRef.current?.focus());
  };
  const openMenuFor = (album: AlbumListing, position: { readonly x: number; readonly y: number }, origin: HTMLElement): void => {
    albumActionOriginRef.current = origin;
    setAlbumMenu({ album, ...position });
  };
  useEffect(() => {
    const offProgress = window.overlook.backup.onProgress(({ done, total }) => {
      setBackupRun(total === 0 ? null : { done, total });
    });
    // Early exits (auth/quota) break before a final done===total event —
    // completion always clears the bar (PR #207 review).
    const offCompleted = window.overlook.backup.onCompleted(() => {
      setBackupRun(null);
    });
    return () => {
      offProgress();
      offCompleted();
    };
  }, []);
  return (
    <nav
      className={`ovl-sidebar${collapsed ? ' ovl-sidebar--collapsed' : ''}${albumReorder.invalid ? ' ovl-sidebar--reorder-invalid' : ''}`}
      aria-label={intl.formatMessage(messages.nav)}
      {...albumReorder.invalidZoneProps}
    >
      <div className="ovl-sidebar__toggle-row">
        <Tooltip label={intl.formatMessage(collapsed ? messages.expand : messages.collapse)} side={inlineEndSide}>
          <button
            type="button"
            className="ovl-sidebar__toggle"
            aria-label={intl.formatMessage(collapsed ? messages.expand : messages.collapse)}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            <Icon name={collapsed ? 'panel-left-open' : 'panel-left-close'} size={15} />
          </button>
        </Tooltip>
      </div>
      {collapsed ? (
        <div className="ovl-sidebar__divider" role="presentation" />
      ) : (
        <div className="ovl-sidebar__heading mono-data">
          <h2 className="ovl-sidebar__headingText">
            <FormattedMessage id="sidebar.heading.library" defaultMessage="Library" />
          </h2>
        </div>
      )}
      {SOURCES.filter(({ key }) => !DERIVED_SOURCES.has(key) || (counts !== null && counts[key] > 0)).map(({ key, icon, label }) => (
        <SideRow
          key={key}
          icon={icon}
          label={intl.formatMessage(label)}
          count={counts === null ? null : counts[key]}
          active={state.album === null && state.smartAlbum === null && state.source === key}
          collapsed={collapsed}
          buttonRef={key === 'all' ? allPhotosRef : undefined}
          onClick={() => {
            dispatch({ type: 'source/set', source: key });
          }}
          onOpenActions={
            key === 'deleted' && onEmptyTrash !== undefined && (counts?.deleted ?? 0) > 0
              ? (position, origin) => setSourceMenu({ ...position, origin })
              : undefined
          }
        />
      ))}
      {sourceMenu === null ? null : (
        <ContextMenu
          label={intl.formatMessage({ id: 'sidebar.trash.actions', defaultMessage: 'Trash actions' })}
          x={sourceMenu.x}
          y={sourceMenu.y}
          items={[
            {
              id: 'trash.empty',
              label: intl.formatMessage(commandById('trash.empty').label),
              icon: 'trash-2',
              action: onEmptyTrash ?? (() => undefined),
              danger: true,
            },
          ]}
          onClose={() => {
            const origin = sourceMenu.origin;
            setSourceMenu(null);
            requestAnimationFrame(() => {
              if (origin.isConnected) origin.focus();
            });
          }}
        />
      )}
      {collapsed ? (
        <div className="ovl-sidebar__divider" role="presentation" />
      ) : (
        <div className="ovl-sidebar__heading mono-data">
          <h2 className="ovl-sidebar__headingText">
            <FormattedMessage id="sidebar.heading.albums" defaultMessage="Albums" />
          </h2>
          <span className="ovl-sidebar__headingActions">
            <button
              type="button"
              className="ovl-sidebar__gear"
              aria-label={intl.formatMessage(messages.newFolder)}
              onClick={(event) => {
                albumActionOriginRef.current = event.currentTarget;
                setDialog({ kind: 'new', collection: 'folder', parent: null });
              }}
            >
              <Icon name="folder" size={13} color="var(--text-faint)" />
            </button>
            <button
              type="button"
              className="ovl-sidebar__gear"
              aria-label={intl.formatMessage(messages.newAlbum)}
              ref={newAlbumRef}
              disabled={creatingAlbum}
              onClick={() => {
                setNamingAlbum(true);
                albumNameRef.current?.focus();
              }}
            >
              <Icon name="plus" size={13} color="var(--text-faint)" />
            </button>
          </span>
        </div>
      )}
      {namingAlbum && !collapsed ? (
        <input
          className="ovl-sidebar__albumname"
          aria-label={intl.formatMessage(messages.albumName)}
          placeholder={intl.formatMessage(messages.albumName)}
          ref={albumNameRef}
          value={albumName}
          readOnly={creatingAlbum}
          aria-busy={creatingAlbum}
          onChange={(event) => setAlbumName(event.currentTarget.value)}
          // The affordance just appeared under the pointer — take focus so
          // Enter/Escape work immediately.
          autoFocus
          onKeyDown={(event) => {
            if (creatingAlbum) {
              if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
              return;
            }
            if (event.key === 'Escape') {
              setNamingAlbum(false);
              setAlbumName('');
              newAlbumRef.current?.focus();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const name = albumName.trim();
              if (name !== '') {
                const input = event.currentTarget;
                setCreatingAlbum(true);
                // The albums list refreshes off the library:changed push.
                void window.overlook.albums.create({ name }).then(
                  () => {
                    restoreNewAlbumFocus.current = input.ownerDocument.activeElement === input;
                    setCreatingAlbum(false);
                    setNamingAlbum(false);
                    setAlbumName('');
                  },
                  () => {
                    setCreatingAlbum(false);
                    dispatch({
                      type: 'toast/shown',
                      toast: { title: intl.formatMessage(messages.createFailed, { name }), tone: 'red' },
                    });
                  },
                );
              }
            }
          }}
          onBlur={() => {
            if (!creatingAlbum && albumName.trim() === '') setNamingAlbum(false);
          }}
        />
      ) : null}
      <span id={albumReorder.instructionId} className="ovl-sr-only">
        <FormattedMessage
          id="album.reorder.instructions"
          defaultMessage="Press Space or Enter to grab. Use arrow keys to move, Space or Enter to drop, and Escape to cancel."
        />
      </span>
      <AlbumTree
        collapsed={collapsed}
        activeAlbumId={state.album ?? state.smartAlbum}
        isExpanded={(folderId) => !collapsedFolders.has(folderId)}
        onToggleFolder={toggleFolder}
        onSelectAlbum={(albumId) => {
          dispatch({ type: 'album/set', albumId });
        }}
        onSelectSmartAlbum={(album) => {
          dispatch({ type: 'smartAlbum/set', albumId: album.id, predicate: album.predicate ?? EMPTY_PREDICATE });
        }}
        onOpenActions={openMenuFor}
        albumReorder={albumReorder}
        albumDrop={albumDrop}
      />
      {protectedAlbums.length === 0 ? null : collapsed ? (
        <div className="ovl-sidebar__divider" role="presentation" />
      ) : (
        <div className="ovl-sidebar__heading mono-data">
          <h2 className="ovl-sidebar__headingText">
            <FormattedMessage id="sidebar.heading.protected" defaultMessage="Protected" />
          </h2>
        </div>
      )}
      {protectedAlbums.map((album) => {
        const label = album.locked ? album.label : (album.name ?? album.label);
        return (
          <SideRow
            key={album.id}
            icon="lock"
            label={label}
            count={album.locked ? null : (album.count ?? null)}
            active={state.protectedAlbum === album.id}
            collapsed={collapsed}
            onClick={onProtectedOpen === undefined ? undefined : (origin) => onProtectedOpen(album.id, origin)}
          />
        );
      })}
      {albumDrop.choice === null ? null : (
        <AlbumDropDialog
          count={albumDrop.choice.payload.photoIds.length}
          source={albumDrop.choice.source}
          target={albumDrop.choice.target}
          onAdd={albumDrop.chooseAdd}
          onMove={albumDrop.chooseMove}
          onClose={albumDrop.closeChoice}
        />
      )}
      {albumMenu === null ? null : (
        <AlbumActionMenu
          album={albumMenu.album}
          x={albumMenu.x}
          y={albumMenu.y}
          onClose={() => {
            setAlbumMenu(null);
            restoreAlbumActionFocus();
          }}
          onRename={() => {
            setAlbumMenu(null);
            setDialog({ kind: 'rename', album: albumMenu.album });
          }}
          onDelete={() => {
            setAlbumMenu(null);
            setDialog({ kind: 'delete', album: albumMenu.album });
          }}
          onSetVisibility={(showInAllPhotos) => {
            setVisibility(albumMenu.album, showInAllPhotos);
          }}
          onInheritVisibility={() => {
            setVisibility(albumMenu.album, 'inherit');
          }}
          onOpenAlbum={(albumId) => {
            setAlbumMenu(null);
            dispatch({ type: 'album/set', albumId });
          }}
          onNewAlbumInside={() => {
            setAlbumMenu(null);
            setDialog({ kind: 'new', collection: 'album', parent: albumMenu.album });
          }}
          onNewFolderInside={() => {
            setAlbumMenu(null);
            setDialog({ kind: 'new', collection: 'folder', parent: albumMenu.album });
          }}
          onMove={
            albumMenu.album.parentId !== null || albums.some((album) => album.kind === 'folder' && album.id !== albumMenu.album.id)
              ? () => {
                  setAlbumMenu(null);
                  setDialog({ kind: 'move', album: albumMenu.album });
                }
              : undefined
          }
          onTags={() => {
            setAlbumMenu(null);
            setDialog({ kind: 'tags', album: albumMenu.album });
          }}
          onEditSmart={() => {
            const album = albumMenu.album;
            setAlbumMenu(null);
            dispatch({ type: 'smartAlbum/set', albumId: album.id, predicate: album.predicate ?? EMPTY_PREDICATE });
          }}
          onDuplicate={() => {
            const album = albumMenu.album;
            setAlbumMenu(null);
            restoreAlbumActionFocus();
            void window.overlook.albums
              .duplicate({ albumId: album.id })
              .then(({ album: copy }) => toast(intl.formatMessage(messages.duplicated, { name: album.name, copy: copy.name })))
              .catch(() =>
                dispatch({
                  type: 'toast/shown',
                  toast: { title: intl.formatMessage(messages.duplicateFailed, { name: album.name }), tone: 'red' },
                }),
              );
          }}
          onTransfer={
            onTransferAlbum === undefined
              ? undefined
              : () => {
                  setAlbumMenu(null);
                  onTransferAlbum(albumMenu.album);
                }
          }
          position={albumReorder.placement(albumMenu.album.id).position}
          total={albumReorder.placement(albumMenu.album.id).total}
          platform={platform}
          onReorder={(command) => {
            const album = albumMenu.album;
            setAlbumMenu(null);
            albumReorder.moveByCommand(album, command);
            restoreAlbumActionFocus();
          }}
        />
      )}
      {dialog?.kind === 'new' ? (
        <NewCollectionDialog
          kind={dialog.collection}
          parent={dialog.parent}
          onClose={closeDialog}
          onComplete={(album) => {
            setDialog(null);
            toast(intl.formatMessage(album.kind === 'folder' ? messages.createdFolder : messages.createdAlbum, { name: album.name }));
            restoreAlbumActionFocus();
          }}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <RenameAlbumDialog
          key={dialog.album.id}
          album={dialog.album}
          onClose={closeDialog}
          onComplete={(name) => {
            setDialog(null);
            toast(`Renamed album to ${name}`);
            restoreAlbumActionFocus();
          }}
        />
      ) : null}
      {dialog?.kind === 'move' ? (
        <MoveAlbumDialog
          key={dialog.album.id}
          album={dialog.album}
          albums={albums}
          onClose={closeDialog}
          onComplete={(moved) => {
            setDialog(null);
            const folder = albums.find((album) => album.id === moved.parentId);
            toast(
              folder === undefined
                ? intl.formatMessage(messages.movedToTop, { name: moved.name })
                : intl.formatMessage(messages.movedToFolder, { name: moved.name, folder: folder.name }),
            );
            restoreAlbumActionFocus();
          }}
        />
      ) : null}
      {dialog?.kind === 'tags' ? (
        <AlbumTagsDialog
          key={dialog.album.id}
          album={dialog.album}
          onClose={closeDialog}
          onComplete={(updated) => {
            setDialog(null);
            toast(intl.formatMessage(messages.savedTags, { name: updated.name }));
            restoreAlbumActionFocus();
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' && dialog.album.kind === 'folder' ? (
        <DeleteFolderDialog
          key={dialog.album.id}
          folder={dialog.album}
          albums={albums}
          onClose={closeDialog}
          onComplete={(removed, removedIds) => {
            const folder = dialog.album;
            toast(
              intl.formatMessage(messages.deletedFolder, {
                name: folder.name,
                folders: removed.folders,
                albums: removed.albums,
                smart: removed.smart,
              }),
              'neutral',
            );
            completeRemoval(removedIds);
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' && dialog.album.kind !== 'folder' ? (
        <DeleteAlbumDialog
          key={dialog.album.id}
          album={dialog.album}
          kind={dialog.album.kind}
          onClose={closeDialog}
          onComplete={() => {
            const album = dialog.album;
            toast(
              album.kind === 'smart'
                ? intl.formatMessage(messages.deletedSmart, { name: album.name })
                : `Deleted ${album.name} · ${formatCount(album.count)} ${album.count === 1 ? 'photo' : 'photos'} kept`,
              'neutral',
            );
            completeRemoval([album.id]);
          }}
        />
      ) : null}
      <div className="ovl-sidebar__spacer" />
      {collapsed ? (
        <Tooltip
          label={
            backupRun !== null && backupRun.done < backupRun.total
              ? intl.formatMessage({ id: 'sidebar.encrypted.backingUp', defaultMessage: 'Library encrypted · backing up' })
              : intl.formatMessage(messages.encrypted)
          }
          side={inlineEndSide}
        >
          <button
            type="button"
            className="ovl-sidebar__shield"
            data-testid="backup-shield"
            aria-label={intl.formatMessage(messages.encryptedOpenSettings)}
            onClick={() => {
              dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
            }}
          >
            <Icon name="shield-check" size={15} color="var(--accent-green)" />
          </button>
        </Tooltip>
      ) : (
        <div className="ovl-sidebar__card" data-testid="backup-card">
          <div className="ovl-sidebar__card-head">
            <Icon name="shield-check" size={14} color="var(--accent-green)" />
            <span className="ovl-sidebar__card-title">
              <FormattedMessage id="sidebar.encrypted" defaultMessage="Library encrypted" />
            </span>
            <button
              type="button"
              className="ovl-sidebar__gear"
              aria-label={intl.formatMessage(messages.settings)}
              onClick={() => {
                dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
              }}
            >
              <Icon name="settings-2" size={13} color="var(--text-faint)" />
            </button>
          </div>
          {state.providerConnected && backupRun !== null && backupRun.done < backupRun.total ? (
            <ProgressBar
              label={intl.formatMessage({ id: 'sidebar.backingUp', defaultMessage: 'Backing up' })}
              detail={`${formatCount(backupRun.done)} / ${formatCount(backupRun.total)}`}
              value={backupRun.done}
              max={Math.max(backupRun.total, 1)}
              tone="amber"
            />
          ) : null}
          {/* Before the first stats load there is nothing true to say about
              storage, so the line waits rather than showing a dash (#1301). */}
          {stats === null ? null : (
            <div className="ovl-sidebar__storage mono-data">
              <div>
                {intl.formatMessage(messages.storageOnDisk, {
                  bytes: formatBytes(Math.max(0, stats.bytes - stats.offloadedBytes - (stats.localMissingBytes ?? 0))),
                })}
              </div>
              {state.providerConnected ? (
                <div>
                  {intl.formatMessage(messages.storageOffload, {
                    bytes: formatBytes(stats.offloadedBytes),
                    provider: state.providerLabel,
                  })}
                </div>
              ) : null}
              {stats.excludedCount > 0 ? (
                <div data-testid="storage-excluded">
                  {intl.formatMessage(messages.storageExcluded, { bytes: formatBytes(stats.excludedBytes) })}
                </div>
              ) : null}
              {(stats.localMissingCount ?? 0) + (stats.localCorruptCount ?? 0) > 0 ? (
                <div data-testid="storage-local-problems" style={{ color: 'var(--accent-red)' }}>
                  {intl.formatMessage(messages.localCustodyProblems, {
                    missing: stats.localMissingCount ?? 0,
                    corrupt: stats.localCorruptCount ?? 0,
                  })}
                </div>
              ) : null}
            </div>
          )}
          {state.providerConnected ? null : (
            // Disconnected (#239): say so and offer the path back — never a
            // fabricated backup figure.
            <p className="prose-note ovl-sidebar__connect">
              <Icon name="cloud-off" size={12} color="var(--text-faint)" />
              <span>
                <FormattedMessage
                  id="sidebar.notConnected"
                  defaultMessage="{provider} not connected — <cta>Connect</cta>"
                  values={{
                    provider: state.providerLabel,
                    // A sans sentence with Connect as its only control (#1302).
                    cta: (chunks) => (
                      <button
                        type="button"
                        className="ovl-sidebar__connect-cta"
                        data-testid="sidebar-connect"
                        onClick={() => {
                          dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
                        }}
                      >
                        {chunks}
                      </button>
                    ),
                  }}
                />
              </span>
            </p>
          )}
        </div>
      )}
    </nav>
  );
}
