import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { ZOOM_MAX, ZOOM_MIN, type ViewMode } from '../../../shared/library/app-state.js';
import { commandById, formatShortcut, type CommandPlatform } from '../../../shared/commands/registry.js';
import { VIEW_MODE_BY_COMMAND, VIEW_MODE_COMMAND_IDS } from '../../../shared/commands/view-modes.js';
import type { AlbumListing, ChipFilters, SearchMode } from '../../../shared/library/types.js';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { IconButton } from '../components/IconButton';
import { SearchField } from '../components/SearchField';
import { Segmented } from '../components/Segmented';
import { Tooltip } from '../components/Tooltip';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { useAppState, useAppDispatch } from '../state/app-state-context';
import { FacetBar } from './FacetBar';
import { useToolbarCollapse } from './toolbar-collapse';
import { ToolbarViewMenu, ToolbarZoom } from './ToolbarCollapsibles';

import overlookIcon from '../assets/overlook-icon-64.png';
// The toolbar rules live in the shell stylesheet; importing it here keeps
// the component styled when mounted alone, as by its stories (#1292).
import './shell.css';

const QUERY_DEBOUNCE_MS = 250;

// The wordmark is the brand identifier, not translatable copy (ADR-0020 §3
// draws the catalog line at "if language, in catalog; if identifier, left
// alone"). Hoisted to a const so it renders without tripping the hardcoded-
// string ratchet, which flags only literal JSX text.
const BRAND_WORDMARK = 'OVERLOOK';

/** The view control is a projection of the `view.mode.*` commands (labels
 * from the registry, modes from the shared table); only the glyphs are the
 * toolbar's own. */
const VIEW_MODE_ICON: Readonly<Record<ViewMode, 'layout-grid' | 'list' | 'captions' | 'layout-dashboard'>> = {
  grid: 'layout-grid',
  list: 'list',
  feed: 'captions',
  moodboard: 'layout-dashboard',
};

const FILTERS: readonly { key: keyof ChipFilters; icon: 'star' | 'image' | 'cloud' | 'hard-drive' }[] = [
  { key: 'favorites', icon: 'star' },
  { key: 'raw', icon: 'image' },
  { key: 'offloaded', icon: 'cloud' },
  { key: 'localOnly', icon: 'hard-drive' },
];

const messages = defineMessages({
  search: { id: 'toolbar.search', defaultMessage: 'Search library' },
  filters: { id: 'toolbar.filters', defaultMessage: 'Filters' },
  view: { id: 'toolbar.view', defaultMessage: 'View' },
  // The level-4 View menu button (#1290, Pass B spec §06).
  viewTrigger: { id: 'toolbar.view.trigger', defaultMessage: 'View: {mode}' },
  viewChanged: { id: 'toolbar.view.changed', defaultMessage: 'View: {mode}.' },
  importLabel: { id: 'toolbar.import', defaultMessage: 'Import' },
  zoom: { id: 'toolbar.zoom', defaultMessage: 'Zoom' },
  region: { id: 'toolbar.region', defaultMessage: 'Photo tools' },
  backupNow: { id: 'toolbar.backup.now', defaultMessage: 'Back up now' },
  backup: { id: 'toolbar.backup', defaultMessage: 'Back up' },
  backupStarted: { id: 'toolbar.toast.backupStarted', defaultMessage: 'Backup started' },
  backupDisconnected: { id: 'toolbar.toast.backupDisconnected', defaultMessage: 'Backup off — not connected' },
  lockNow: { id: 'toolbar.lock', defaultMessage: 'Lock now' },
  filterFavorites: { id: 'toolbar.filter.favorites', defaultMessage: 'Favorites' },
  filterRaw: { id: 'toolbar.filter.raw', defaultMessage: 'RAW' },
  filterOffloaded: { id: 'toolbar.filter.offloaded', defaultMessage: 'Offloaded' },
  filterLocalOnly: { id: 'toolbar.filter.localOnly', defaultMessage: 'Local only' },
  searchMode: { id: 'toolbar.search.mode', defaultMessage: 'Search mode' },
  searchAuto: { id: 'toolbar.search.mode.auto', defaultMessage: 'Auto' },
  searchSemantic: { id: 'toolbar.search.mode.semantic', defaultMessage: 'Semantic' },
  searchKeyword: { id: 'toolbar.search.mode.keyword', defaultMessage: 'Keyword' },
  // Search mode menu (#1291, Pass B spec §07).
  searchModeTrigger: { id: 'toolbar.search.mode.trigger', defaultMessage: 'Search mode: {mode}' },
  searchModeChanged: { id: 'toolbar.search.mode.changed', defaultMessage: 'Search mode: {mode}.' },
  searchAutoDescription: {
    id: 'toolbar.search.mode.auto.description',
    defaultMessage: 'Keyword and meaning together. Best for most searches.',
  },
  searchSemanticDescription: {
    id: 'toolbar.search.mode.semantic.description',
    defaultMessage: 'Finds photos by what’s in them, like ‘dog on a beach’.',
  },
  searchKeywordDescription: {
    id: 'toolbar.search.mode.keyword.description',
    defaultMessage: 'Matches file names, places, cameras, and tags exactly.',
  },
  searchSemanticWithNote: { id: 'toolbar.search.mode.semantic.withNote', defaultMessage: '{description} {note}' },
  searchFusedStatus: { id: 'toolbar.search.status.fused', defaultMessage: 'Keyword + semantic results' },
  searchSemanticStatus: { id: 'toolbar.search.status.semantic', defaultMessage: 'Semantic results' },
  searchKeywordStatus: { id: 'toolbar.search.status.keyword', defaultMessage: 'Keyword results' },
  searchFallbackStatus: { id: 'toolbar.search.status.fallback', defaultMessage: 'Semantic {reason}; showing keyword results' },
  searchIndexStatus: { id: 'toolbar.search.status.index', defaultMessage: '{indexed} of {total} photos indexed' },
  searchStatusWithIndex: { id: 'toolbar.search.status.withIndex', defaultMessage: '{status} · {index}' },
});

const fallbackMessages = defineMessages({
  disabled: { id: 'toolbar.search.fallback.disabled', defaultMessage: 'is off' },
  unavailable: { id: 'toolbar.search.fallback.unavailable', defaultMessage: 'is unavailable' },
  indexing: { id: 'toolbar.search.fallback.indexing', defaultMessage: 'is still indexing' },
  busy: { id: 'toolbar.search.fallback.busy', defaultMessage: 'is busy' },
  error: { id: 'toolbar.search.fallback.error', defaultMessage: 'had an error' },
});

// Why Semantic can't run right now, appended to its menu description. It stays
// selectable; searches fall back to keyword results until it can.
const semanticNotes = defineMessages({
  indexing: { id: 'toolbar.search.mode.semantic.note.indexing', defaultMessage: 'Still indexing — keyword results until it finishes.' },
  disabled: { id: 'toolbar.search.mode.semantic.note.disabled', defaultMessage: 'Turned off in Settings.' },
  // Design gives no copy for unavailable, busy, or error; one line covers them
  // and the results line names the exact reason.
  other: { id: 'toolbar.search.mode.semantic.note.other', defaultMessage: 'Not available right now — keyword results until it’s back.' },
});

const filterLabels = {
  favorites: messages.filterFavorites,
  raw: messages.filterRaw,
  offloaded: messages.filterOffloaded,
  localOnly: messages.filterLocalOnly,
} satisfies Record<keyof ChipFilters, (typeof messages)[keyof typeof messages]>;

// The 48px command strip (#79) per the design's Toolbar.jsx: wordmark,
// debounced search, funnel + chip row, view segmented, zoom (hidden in list
// via visibility so layout holds), backup state from pendingCount pushes,
// and the primary Import entry point (#88 dialog via onImport). Backup
// lands with M08 — until then it surfaces its stub toast.
export interface ToolbarProps {
  readonly platform: CommandPlatform;
  /** Opens the ImportDialog (#88); wired by the shell. */
  readonly onImport?: (() => void) | undefined;
  readonly onLock?: (() => void) | undefined;
  /** Collections for the facet bar (#514): the open Smart Album, and folders to save into. */
  readonly albums?: readonly AlbumListing[] | undefined;
}

export function Toolbar({ platform, onImport, onLock, albums = [] }: ToolbarProps): ReactElement {
  const intl = useIntl();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { announce } = useAnnouncer();
  const [filterOpen, setFilterOpen] = useState(false);
  const [draft, setDraft] = useState(state.query);
  const rowRef = useRef<HTMLDivElement>(null);
  const collapse = useToolbarCollapse(rowRef);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
    };
  }, []);

  const onSearch = (value: string): void => {
    setDraft(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch({ type: 'query/set', query: value });
    }, QUERY_DEBOUNCE_MS);
  };

  const modeName = (mode: SearchMode): string =>
    intl.formatMessage(mode === 'auto' ? messages.searchAuto : mode === 'semantic' ? messages.searchSemantic : messages.searchKeyword);
  const fallback = state.search.fallbackReason;
  const semanticNote =
    fallback === null
      ? null
      : intl.formatMessage(fallback === 'indexing' || fallback === 'disabled' ? semanticNotes[fallback] : semanticNotes.other);
  const semanticDescription = intl.formatMessage(messages.searchSemanticDescription);
  const searchModeOptions = [
    { value: 'auto', label: modeName('auto'), description: intl.formatMessage(messages.searchAutoDescription) },
    {
      value: 'semantic',
      label: modeName('semantic'),
      description:
        semanticNote === null
          ? semanticDescription
          : intl.formatMessage(messages.searchSemanticWithNote, { description: semanticDescription, note: semanticNote }),
    },
    { value: 'keyword', label: modeName('keyword'), description: intl.formatMessage(messages.searchKeywordDescription) },
  ] as const;
  const viewOptions = VIEW_MODE_COMMAND_IDS.map((id) => ({
    value: VIEW_MODE_BY_COMMAND[id],
    label: intl.formatMessage(commandById(id).label),
    icon: VIEW_MODE_ICON[VIEW_MODE_BY_COMMAND[id]],
    iconOnly: true,
  }));
  const viewName = (view: ViewMode): string => viewOptions.find((option) => option.value === view)?.label ?? view;
  const onViewChange = (view: ViewMode): void => {
    // The same `view/set` the native View menu reaches through
    // `VIEW_MODE_BY_COMMAND` (use-native-command-router).
    dispatch({ type: 'view/set', view });
    announce(intl.formatMessage(messages.viewChanged, { mode: viewName(view) }), 'polite', 'view-mode');
  };
  const anyFilter = Object.values(state.chips).some(Boolean) || state.facets.groups.length > 0;
  const smartAlbum = state.smartAlbum === null ? null : (albums.find((album) => album.id === state.smartAlbum) ?? null);
  const searchStatus =
    state.search.fallbackReason === null
      ? intl.formatMessage(
          state.search.appliedMode === 'fused'
            ? messages.searchFusedStatus
            : state.search.appliedMode === 'semantic'
              ? messages.searchSemanticStatus
              : messages.searchKeywordStatus,
        )
      : intl.formatMessage(messages.searchFallbackStatus, {
          reason: intl.formatMessage(fallbackMessages[state.search.fallbackReason]),
        });
  return (
    <section className="ovl-toolbar titlebar-no-drag" aria-label={intl.formatMessage(messages.region)}>
      {/* No `role="toolbar"`: the row has no arrow-key roving, so each
          control keeps its own Tab stop (Pass B spec §06). */}
      <div ref={rowRef} className="ovl-toolbar__row" data-collapse={collapse}>
        <div className="ovl-toolbar__wordmark">
          <img className="ovl-toolbar__mark" src={overlookIcon} alt="" width={20} height={20} />
          <span className="ovl-toolbar__brand">{BRAND_WORDMARK}</span>
        </div>
        <SearchField<SearchMode>
          value={draft}
          onChange={onSearch}
          shortcut={formatShortcut(commandById('app.search.focus'), platform)}
          width="auto"
          label={intl.formatMessage(messages.search)}
          mode={{
            value: state.searchMode,
            options: searchModeOptions,
            menuLabel: intl.formatMessage(messages.searchMode),
            triggerLabel: intl.formatMessage(messages.searchModeTrigger, { mode: modeName(state.searchMode) }),
            showName: state.searchMode !== 'auto',
          }}
          onModeChange={(mode) => {
            dispatch({ type: 'searchMode/set', mode });
            announce(intl.formatMessage(messages.searchModeChanged, { mode: modeName(mode) }), 'polite', 'search-mode');
          }}
        />
        <IconButton
          icon="funnel"
          label={intl.formatMessage(messages.filters)}
          active={filterOpen || anyFilter}
          onClick={() => {
            setFilterOpen((open) => !open);
          }}
        />
        <div className="ovl-toolbar__spacer" />
        <div className="ovl-toolbar__view" data-collapse-slot="view" data-collapse-variant="full">
          <Segmented label={intl.formatMessage(messages.view)} options={viewOptions} value={state.view} onChange={onViewChange} />
        </div>
        <div className="ovl-toolbar__view" data-collapse-slot="view" data-collapse-variant="compact">
          <ToolbarViewMenu
            value={state.view}
            options={viewOptions}
            menuLabel={intl.formatMessage(messages.view)}
            triggerLabel={intl.formatMessage(messages.viewTrigger, { mode: viewName(state.view) })}
            onChange={onViewChange}
          />
        </div>
        <ToolbarZoom
          label={intl.formatMessage(messages.zoom)}
          value={state.zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          hidden={state.view !== 'grid'}
          collapsed={collapse >= 1}
          onChange={(zoom) => {
            dispatch({ type: 'zoom/set', zoom });
          }}
        />
        {state.providerConnected && state.pendingCount > 0 ? (
          <Tooltip label={intl.formatMessage(messages.backupNow)} side="bottom">
            <IconButton
              icon="cloud-upload"
              label={intl.formatMessage(messages.backup)}
              onClick={() => {
                // Manual trigger (#108): amber start toast per the mock; the
                // completion listener shows green/red endings. A disconnected
                // provider blocks the run (#114) — say so instead.
                dispatch({ type: 'toast/shown', toast: { title: intl.formatMessage(messages.backupStarted), tone: 'amber' } });
                void window.overlook.backup.run({}).then(({ skipped }) => {
                  if (skipped === 'disconnected') {
                    dispatch({
                      type: 'toast/shown',
                      toast: { title: intl.formatMessage(messages.backupDisconnected), tone: 'neutral' },
                    });
                  }
                });
              }}
            />
          </Tooltip>
        ) : // Disconnected (#239) or fully backed up (#266) hides the button
        // entirely — it appears when a change creates work and leaves when
        // the pending set drains; an idle affordance misstates that there
        // is something to run.
        null}
        {onLock === undefined ? null : (
          <Tooltip label={intl.formatMessage(messages.lockNow)} side="bottom">
            <IconButton icon="lock" label={intl.formatMessage(messages.lockNow)} onClick={onLock} />
          </Tooltip>
        )}
        {/* Icon-only from level 3, still primary; the name stays "Import". */}
        <Tooltip label={intl.formatMessage(messages.importLabel)} side="bottom" disabled={collapse < 3}>
          <Button
            variant="primary"
            icon="download"
            size="md"
            className="ovl-toolbar__import"
            aria-label={intl.formatMessage(messages.importLabel)}
            onClick={() => {
              onImport?.();
            }}
          >
            <span className="ovl-toolbar__import-label">{intl.formatMessage(messages.importLabel)}</span>
          </Button>
        </Tooltip>
      </div>
      {filterOpen || state.query !== '' ? (
        <div className="ovl-toolbar__chips" data-testid="chip-row">
          {filterOpen
            ? FILTERS.map(({ key, icon }) => (
                <Chip
                  key={key}
                  icon={icon}
                  selected={state.chips[key] === true}
                  onClick={() => {
                    dispatch({ type: 'chip/toggled', chip: key });
                  }}
                >
                  {intl.formatMessage(filterLabels[key])}
                </Chip>
              ))
            : null}
          {state.query === '' ? null : (
            <span className="ovl-toolbar__hint prose-note" role="status" aria-live="polite">
              {state.search.total === 0
                ? searchStatus
                : intl.formatMessage(messages.searchStatusWithIndex, {
                    status: searchStatus,
                    index: intl.formatMessage(messages.searchIndexStatus, {
                      indexed: state.search.indexed,
                      total: state.search.total,
                    }),
                  })}
            </span>
          )}
        </div>
      ) : null}
      {filterOpen || state.facets.groups.length > 0 || state.smartAlbum !== null ? (
        <FacetBar smartAlbum={smartAlbum} albums={albums} />
      ) : null}
    </section>
  );
}
