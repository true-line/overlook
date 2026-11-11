import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import './library-switcher.css';
import { useFormats } from '../i18n/use-formats.js';
import type { LibraryDescriptor } from '../../../shared/library/registry.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { MoveLibraryDialog } from './MoveLibraryDialog';
import { RenameLibraryDialog } from './RenameLibraryDialog';
import { destructiveActions } from '../../../shared/destructive-actions.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { EditLibraryDisplayNameDialog } from './EditLibraryDisplayNameDialog';
import { LibraryRow } from './LibraryRow';
import { LibraryRowMenu } from './LibraryRowMenu';
import { libraryRowActions } from './library-row-actions';

// Library Switcher (#386, ADR-0017): view, switch, create, and manage the
// registered libraries. Switching hands off to the main process (#385) which
// tears down, repoints, and reloads this window — the "switching" phase here
// is honest about that: it survives only until the reload wipes the renderer.

type Phase = 'list' | 'switching' | 'create' | 'confirm-remove' | 'display-name' | 'move' | 'rename';

// Where focus lands when the list comes back (#1299): a row's ⋯ after one of
// its dialogs, or the footer control that started the flow. Never the panel.
type ReturnFocus =
  | { readonly part: 'actions'; readonly libraryId: string; readonly index: number }
  | { readonly part: 'first-selectable' }
  | { readonly part: 'move-several' }
  | { readonly part: 'new-library' };

interface RowMenu {
  readonly library: LibraryDescriptor;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  /** The row or ⋯ that opened the menu; Esc hands focus back to it. */
  readonly origin: HTMLElement;
}

interface Refusal {
  readonly kind:
    'provider-busy' | 'locked' | 'locked-elsewhere' | 'missing' | 'switch-in-progress' | 'not-a-library' | 'already-registered' | 'error';
  readonly host?: string | null;
}

const refusalMessages = defineMessages({
  providerBusyTitle: { id: 'libswitch.refusal.providerBusy.title', defaultMessage: "Can't switch while a backup is running" },
  providerBusyDetail: {
    id: 'libswitch.refusal.providerBusy.detail',
    defaultMessage: 'Finish or wait for the current backup or restore before switching libraries.',
  },
  lockedTitle: { id: 'libswitch.refusal.locked.title', defaultMessage: 'Overlook is locked' },
  lockedDetail: { id: 'libswitch.refusal.locked.detail', defaultMessage: 'Unlock the current library before switching.' },
  lockedElsewhereTitle: { id: 'libswitch.refusal.lockedElsewhere.title', defaultMessage: 'This library is open elsewhere' },
  lockedElsewhereDetail: { id: 'libswitch.refusal.lockedElsewhere.detail', defaultMessage: 'Close it there first, then switch.' },
  missingTitle: { id: 'libswitch.refusal.missing.title', defaultMessage: "This library's folder is missing" },
  missingDetail: { id: 'libswitch.refusal.missing.detail', defaultMessage: 'Reconnect the volume it lives on, then try again.' },
  switchInProgressTitle: { id: 'libswitch.refusal.switchInProgress.title', defaultMessage: 'A switch is already in progress' },
  switchInProgressDetail: {
    id: 'libswitch.refusal.switchInProgress.detail',
    defaultMessage: 'Hold on — the current switch has to finish first.',
  },
  notALibraryTitle: { id: 'libswitch.refusal.notALibrary.title', defaultMessage: "That folder isn't an Overlook library" },
  notALibraryDetail: {
    id: 'libswitch.refusal.notALibrary.detail',
    defaultMessage: 'Choose a folder that contains an Overlook library.db.',
  },
  alreadyRegisteredTitle: { id: 'libswitch.refusal.alreadyRegistered.title', defaultMessage: 'Already in the list' },
  alreadyRegisteredDetail: {
    id: 'libswitch.refusal.alreadyRegistered.detail',
    defaultMessage: 'That library is registered here already.',
  },
  errorTitle: { id: 'libswitch.refusal.error.title', defaultMessage: 'Something went wrong' },
  errorDetail: { id: 'libswitch.refusal.error.detail', defaultMessage: 'The operation could not be completed safely. Try again.' },
  lockedOnHost: { id: 'libswitch.refusal.lockedOnHost', defaultMessage: 'Locked on {host}' },
});

const REFUSAL_COPY: Record<Refusal['kind'], { title: MessageDescriptor; detail: MessageDescriptor }> = {
  'provider-busy': { title: refusalMessages.providerBusyTitle, detail: refusalMessages.providerBusyDetail },
  locked: { title: refusalMessages.lockedTitle, detail: refusalMessages.lockedDetail },
  'locked-elsewhere': { title: refusalMessages.lockedElsewhereTitle, detail: refusalMessages.lockedElsewhereDetail },
  missing: { title: refusalMessages.missingTitle, detail: refusalMessages.missingDetail },
  'switch-in-progress': { title: refusalMessages.switchInProgressTitle, detail: refusalMessages.switchInProgressDetail },
  'not-a-library': { title: refusalMessages.notALibraryTitle, detail: refusalMessages.notALibraryDetail },
  'already-registered': { title: refusalMessages.alreadyRegisteredTitle, detail: refusalMessages.alreadyRegisteredDetail },
  error: { title: refusalMessages.errorTitle, detail: refusalMessages.errorDetail },
};

// New copy goes through the catalog (ADR-0020 §6); the switcher's legacy
// literals hold a shrinking budget and migrate opportunistically.
const moveMessages = defineMessages({
  actions: { id: 'libswitch.actions', defaultMessage: 'Actions for {name}' },
  actionsDuplicate: { id: 'libswitch.actions.duplicate', defaultMessage: 'Actions for {name} ({hint})' },
  moveSeveral: { id: 'libswitch.move.several', defaultMessage: 'Move several…' },
  modeBanner: { id: 'libswitch.move.banner', defaultMessage: 'Choose libraries to move. The open library moves last.' },
  modeOn: { id: 'libswitch.move.modeOn', defaultMessage: 'Choose libraries to move. Press Space to select, Escape to cancel.' },
  modeKeys: { id: 'libswitch.move.keys', defaultMessage: 'Space select · esc cancel' },
  modeCount: { id: 'libswitch.move.count', defaultMessage: '{count} selected.' },
  modeCancel: { id: 'libswitch.move.cancel', defaultMessage: 'Cancel' },
  modeCanceled: { id: 'libswitch.move.canceled', defaultMessage: 'Move canceled. Nothing was moved.' },
  noneSelected: { id: 'libswitch.move.none', defaultMessage: 'Select at least one library' },
  moveSelected: { id: 'libswitch.move.selected', defaultMessage: 'Move {count} selected…' },
  removed: { id: 'libswitch.remove.done', defaultMessage: '{name} removed from this list. Its files were not changed.' },
  duplicateHint: { id: 'libswitch.displayName.duplicateHint', defaultMessage: 'Location: {location} · ID ending {id}' },
  folder: { id: 'libswitch.displayName.folder', defaultMessage: 'Library folder' },
  changed: { id: 'libswitch.displayName.changed', defaultMessage: 'Display name changed to {name}' },
});

function privacySafeLocationHint(libraryPath: string): string | null {
  const parts = libraryPath
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]+/u)
    .filter(Boolean);
  return parts.at(-1) ?? null;
}

function focusReturnTarget(root: HTMLElement, target: ReturnFocus): void {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.ovl-libswitch__row'));
  let element: HTMLElement | null = null;
  if (target.part === 'actions') {
    element = rows.find((row) => row.dataset['libraryId'] === target.libraryId)?.querySelector('.ovl-libswitch__actions') ?? null;
    // The library left the list: the row that took its place, else the one before.
    element ??= (rows[target.index] ?? rows[target.index - 1])?.querySelector('.ovl-libswitch__rowbtn') ?? null;
  } else if (target.part === 'first-selectable') {
    // With every row blocked there is nothing to check; Cancel is the way out.
    element = root.querySelector('.ovl-libswitch__rowbtn:not([aria-disabled="true"])') ?? root.querySelector('[data-testid="move-cancel"]');
  } else if (target.part === 'move-several') {
    element = root.querySelector('[data-testid="move-several"]');
  }
  element ??= root.querySelector('[data-testid="new-library"]');
  element?.focus();
}

export interface LibrarySwitcherProps {
  readonly onClose: () => void;
  readonly onCurrentNameChange?: ((name: string) => void) | undefined;
  /** Open straight into the "New library…" form (File → New Library…, #689). */
  readonly startInCreate?: boolean;
  /** Locked surfaces expose switching without library management (#847). */
  readonly switchOnly?: boolean;
}

export function LibrarySwitcher({
  onClose,
  onCurrentNameChange,
  startInCreate = false,
  switchOnly = false,
}: LibrarySwitcherProps): ReactElement {
  const intl = useIntl();
  const { formatRelativeTime } = useFormats();
  const { announce } = useAnnouncer();
  const [libs, setLibs] = useState<readonly LibraryDescriptor[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // "4h ago" stamps are relative to load time, not render time (purity).
  const [loadedAt, setLoadedAt] = useState(0);
  const [phase, setPhase] = useState<Phase>(startInCreate ? 'create' : 'list');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [switchTarget, setSwitchTarget] = useState<LibraryDescriptor | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LibraryDescriptor | null>(null);
  const [removing, setRemoving] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPath, setCreatePath] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [moveTargets, setMoveTargets] = useState<readonly LibraryDescriptor[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<LibraryDescriptor | null>(null);
  const [displayNameTarget, setDisplayNameTarget] = useState<LibraryDescriptor | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<ReturnFocus | null>(startInCreate ? { part: 'new-library' } : null);
  const countTimerRef = useRef<number | null>(null);
  const noneSelectedId = useId();

  const refresh = useCallback((): void => {
    void Promise.all([window.overlook.libraries.list(), window.overlook.libraries.current()])
      .then(([{ libraries }, { library }]) => {
        setLibs(libraries);
        setCurrentId(library.id);
        setLoadedAt(Date.now());
      })
      .catch(() => setRefusal({ kind: 'error' }));
  }, []);
  useEffect(refresh, [refresh]);

  const current = libs?.find((lib) => lib.open) ?? libs?.find((lib) => lib.id === currentId) ?? null;

  const switchTo = (lib: LibraryDescriptor): void => {
    setRefusal(null);
    // The designed refusals are visible in the list itself — refuse locally
    // before asking main, so the banner explains rather than round-trips.
    if (lib.missing) {
      setRefusal({ kind: 'missing' });
      return;
    }
    if (lib.lockedBy !== null) {
      setRefusal({ kind: 'locked-elsewhere', host: lib.lockedBy });
      return;
    }
    if (lib.open || lib.id === currentId) {
      onClose();
      return;
    }
    setSwitchTarget(lib);
    setPhase('switching');
    announce(`Switching to ${lib.name}`, 'polite', 'library-switch');
    window.overlook.libraries
      .open({ id: lib.id })
      .then((outcome) => {
        if (!outcome.ok) {
          setPhase('list');
          setSwitchTarget(null);
          setRefusal({ kind: outcome.reason, host: outcome.host });
        }
        // ok: the main process reloads this window into the new library —
        // nothing to do; the switching screen holds until then.
      })
      .catch(() => {
        // A successful switch DESTROYS this JS context mid-IPC (window
        // reload) — no callback ever runs. So a rejection that reaches us
        // is a real failure (entry removed under us, teardown threw):
        // return to a fresh list instead of wedging on the progress screen
        // (PR #450 review).
        setPhase('list');
        setSwitchTarget(null);
        setRefusal({ kind: 'error' });
        refresh();
      });
  };

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    const name = createName.trim();
    if (name === '' || creating) return;
    setCreating(true);
    setRefusal(null);
    window.overlook.libraries
      .create({ name, path: createPath })
      .then(({ library }) => {
        // Acceptance 1: create and LAND in it — hand off to the switch.
        setCreating(false);
        setCreateName('');
        setCreatePath(null);
        switchTo(library);
      })
      .catch(() => {
        setCreating(false);
        setRefusal({ kind: 'error' });
      });
  };

  const addExisting = (): void => {
    setRefusal(null);
    window.overlook.libraries
      .add({ path: null })
      .then((outcome) => {
        if (outcome.ok) {
          refresh();
          return;
        }
        if (outcome.reason !== 'cancelled') setRefusal({ kind: outcome.reason });
      })
      .catch(() => setRefusal({ kind: 'error' }));
  };

  const confirmRemove = (): void => {
    if (removeTarget === null || removing) return;
    setRemoving(true);
    window.overlook.libraries
      .remove({ id: removeTarget.id })
      .then(() => {
        const removed = removeTarget;
        setRemoving(false);
        setRemoveTarget(null);
        setLibs((previous) => previous?.filter((library) => library.id !== removed.id) ?? null);
        setPhase('list');
        announce(intl.formatMessage(moveMessages.removed, { name: removed.name }), 'polite', 'library-remove');
        refresh();
      })
      .catch(() => {
        setRemoving(false);
        setRefusal({ kind: 'error' });
        setPhase('list');
      });
  };

  // ↑/↓ move focus between rows from anywhere in the modal (roving focus
  // keeps Enter = native activate). Document-level because the Dialog panel
  // holds focus on open — a handler on our subtree would never hear it.
  const inList = phase === 'list' && menu === null;
  useEffect(() => {
    if (!inList) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.ovl-libswitch__rowbtn') ?? []);
      if (rows.length === 0) return;
      const at = rows.findIndex((row) => row === document.activeElement);
      const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
      rows[next]?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [inList]);

  // Focus comes back once the list is on screen again, after the closing
  // dialog has handed focus to its (now unmounted) opener on a timeout.
  useEffect(() => {
    const target = returnFocusRef.current;
    const root = rootRef.current;
    if (phase !== 'list' || libs === null || target === null || root === null) return;
    const timer = window.setTimeout(() => {
      returnFocusRef.current = null;
      focusReturnTarget(root, target);
    });
    return () => window.clearTimeout(timer);
  }, [phase, libs, selecting]);

  const clearCountTimer = (): void => {
    if (countTimerRef.current !== null) window.clearTimeout(countTimerRef.current);
    countTimerRef.current = null;
  };
  useEffect(() => clearCountTimer, []);

  const startSelecting = (): void => {
    setRefusal(null);
    setSelected(new Set());
    setSelecting(true);
    returnFocusRef.current = { part: 'first-selectable' };
    announce(intl.formatMessage(moveMessages.modeOn), 'polite', 'library-move-mode');
  };

  const leaveSelecting = (): void => {
    clearCountTimer();
    setSelecting(false);
    setSelected(new Set());
    returnFocusRef.current = { part: 'move-several' };
  };

  const cancelSelecting = (): void => {
    leaveSelecting();
    announce(intl.formatMessage(moveMessages.modeCanceled), 'polite', 'library-move-mode');
  };

  const toggleSelected = (library: LibraryDescriptor): void => {
    const next = new Set(selected);
    if (next.has(library.id)) next.delete(library.id);
    else next.add(library.id);
    setSelected(next);
    // Only the count after the last change within 500ms is read.
    clearCountTimer();
    countTimerRef.current = window.setTimeout(() => {
      countTimerRef.current = null;
      announce(intl.formatMessage(moveMessages.modeCount, { count: next.size }), 'polite', 'library-move-mode');
    }, 500);
  };

  const moveSelected = (): void => {
    if (selected.size === 0) return;
    setRefusal(null);
    setMoveTargets((libs ?? []).filter((library) => selected.has(library.id)));
    leaveSelecting();
    setPhase('move');
  };

  // Esc in the mode leaves the mode; the switcher stays. Captured ahead of the
  // Dialog's own Esc, which would otherwise start closing the switcher.
  useEffect(() => {
    if (!selecting || phase !== 'list') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelSelecting();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  });

  // A row's dialogs hand focus back to its ⋯ (or, if it has gone, a neighbour).
  const beginRowAction = (library: LibraryDescriptor, next: Phase): void => {
    setRefusal(null);
    returnFocusRef.current = {
      part: 'actions',
      libraryId: library.id,
      index: (libs ?? []).findIndex((entry) => entry.id === library.id),
    };
    setPhase(next);
  };

  const openMenu = (
    library: LibraryDescriptor,
    label: string,
    anchor: HTMLElement,
    origin: HTMLElement,
    at?: { x: number; y: number },
  ): void => {
    const bounds = anchor.getBoundingClientRect();
    const rtl = getComputedStyle(anchor).direction === 'rtl';
    // Under the ⋯, its inline-end edge on the menu's (210px min width).
    const position = at ?? { x: rtl ? bounds.left : bounds.right - 210, y: bounds.bottom + 4 };
    setMenu({ library, label, origin, ...position });
  };

  const closeMenu = (): void => {
    const origin = menu?.origin;
    setMenu(null);
    if (origin?.isConnected === true) origin.focus();
  };

  // Esc backs out of layered phases before it closes the switcher.
  const close = (): void => {
    if (phase === 'switching') return;
    if (selecting) {
      cancelSelecting();
      return;
    }
    if (phase === 'confirm-remove' || phase === 'create' || phase === 'display-name') {
      setPhase('list');
      setRemoveTarget(null);
      setDisplayNameTarget(null);
      return;
    }
    onClose();
  };

  if (phase === 'rename' && renameTarget !== null) {
    return (
      <RenameLibraryDialog
        library={renameTarget}
        onClose={() => {
          setPhase('list');
          setRenameTarget(null);
          refresh();
        }}
      />
    );
  }

  if (phase === 'display-name' && displayNameTarget !== null) {
    return (
      <EditLibraryDisplayNameDialog
        library={displayNameTarget}
        onClose={() => {
          setPhase('list');
          setDisplayNameTarget(null);
        }}
        onSaved={(updated) => {
          setLibs((previous) => previous?.map((library) => (library.id === updated.id ? updated : library)) ?? [updated]);
          if (updated.open || updated.id === currentId) onCurrentNameChange?.(updated.name);
          announce(intl.formatMessage(moveMessages.changed, { name: updated.name }), 'polite', 'library-display-name');
          setPhase('list');
          setDisplayNameTarget(null);
        }}
      />
    );
  }

  if (phase === 'move' && moveTargets !== null) {
    return (
      <MoveLibraryDialog
        libraries={moveTargets}
        onClose={() => {
          setPhase('list');
          setMoveTargets(null);
          refresh();
        }}
      />
    );
  }

  if (phase === 'switching') {
    return (
      <Dialog open title="Switching libraries" icon="refresh-cw" width={420}>
        <div className="ovl-libswitch__progress" data-testid="switch-progress" role="status">
          <Icon name="refresh-cw" size={28} color="var(--accent-iris)" />
          <div className="ovl-libswitch__progress-steps">
            <div className="ovl-libswitch__step">
              <Icon name="check" size={14} color="var(--accent-green)" />
              <span>Settling writes</span>
            </div>
            <div className="ovl-libswitch__step">
              <Icon name="check" size={14} color="var(--accent-green)" />
              <span>Closing {current?.name ?? 'current library'}</span>
            </div>
            <div className="ovl-libswitch__step ovl-libswitch__step--active">
              <span className="ovl-libswitch__spinner" aria-hidden="true" />
              <span>Opening {switchTarget?.name ?? 'library'}…</span>
            </div>
          </div>
          <div className="prose-note ovl-libswitch__progress-note">Encrypted teardown · keys never leave this device</div>
        </div>
      </Dialog>
    );
  }

  if (phase === 'confirm-remove' && removeTarget !== null) {
    return (
      <Dialog
        open
        title={`Remove “${removeTarget.name}” from this list?`}
        icon="images"
        width={440}
        {...(removing ? {} : { onClose: close })}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={removing}>
              Cancel
            </Button>
            <Button onClick={confirmRemove} disabled={removing} data-testid="remove-confirm">
              {removing ? 'Removing…' : destructiveActions.removeLibraryFromList.label}
            </Button>
          </>
        }
      >
        <p className="ovl-libswitch__remove-copy">This only removes the library from Overlook’s list here.</p>
        <div className="ovl-libswitch__reassure">
          <Icon name="shield-check" size={16} color="var(--accent-green)" />
          <span>{destructiveActions.removeLibraryFromList.survival}</span>
        </div>
        <div className="mono-data ovl-libswitch__remove-path">{removeTarget.path}</div>
      </Dialog>
    );
  }

  if (phase === 'create') {
    const trimmed = createName.trim();
    return (
      <Dialog
        open
        title="New library"
        icon="plus"
        width={440}
        {...(creating ? {} : { onClose: close })}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={creating}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="library-create"
              disabled={trimmed === '' || creating}
              data-testid="create-confirm"
            >
              {creating ? 'Creating…' : 'Create library'}
            </Button>
          </>
        }
      >
        <form id="library-create" onSubmit={submitCreate}>
          <label className="ovl-libswitch__label" htmlFor="library-create-name">
            Library name
          </label>
          <input
            id="library-create-name"
            className="ovl-libswitch__input"
            value={createName}
            maxLength={120}
            autoFocus
            data-testid="create-name"
            onChange={(event) => setCreateName(event.currentTarget.value)}
          />
          <div className="ovl-libswitch__label">Location</div>
          <div className="ovl-libswitch__location">
            <span className={`${createPath === null ? 'prose-note' : 'mono-data'} ovl-libswitch__location-path`}>
              {createPath ?? 'App-managed location'}
            </span>
            <Button
              size="sm"
              disabled={creating}
              onClick={() => {
                void window.overlook.libraries.pickCreateLocation().then(({ path }) => {
                  if (path !== null) setCreatePath(path);
                });
              }}
            >
              Choose…
            </Button>
          </div>
          {refusal === null ? null : (
            <div className="ovl-libswitch__error" role="alert">
              {intl.formatMessage(REFUSAL_COPY[refusal.kind].detail)}
            </div>
          )}
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog open title="Libraries" icon="images" width={520} onClose={close}>
      <div data-testid="library-switcher" ref={rootRef}>
        {refusal === null ? null : (
          <div className="ovl-libswitch__banner" role="alert" data-testid="switch-refusal">
            <Icon name="triangle-alert" size={16} color="var(--accent-amber)" />
            <div className="ovl-libswitch__banner-copy">
              <div className="ovl-libswitch__banner-title">{intl.formatMessage(REFUSAL_COPY[refusal.kind].title)}</div>
              <div className="ovl-libswitch__banner-detail">{intl.formatMessage(REFUSAL_COPY[refusal.kind].detail)}</div>
              {refusal.host == null ? null : (
                <div className="prose-note ovl-libswitch__banner-host">
                  {intl.formatMessage(refusalMessages.lockedOnHost, { host: refusal.host })}
                </div>
              )}
            </div>
            <IconButton icon="x" label="Dismiss" size="sm" onClick={() => setRefusal(null)} />
          </div>
        )}
        <div className="ovl-libswitch__count mono-data">{libs === null ? 'Loading…' : `${String(libs.length)} registered`}</div>
        {selecting ? (
          <p className="ovl-libswitch__mode" data-testid="move-mode-banner">
            <Icon name="info" size={14} color="var(--text-muted)" />
            <span>{intl.formatMessage(moveMessages.modeBanner)}</span>
          </p>
        ) : null}
        <ul className="ovl-libswitch__list" ref={listRef} data-testid="library-list">
          {(libs ?? []).map((lib) => {
            const duplicateName =
              (libs ?? []).filter((candidate) => candidate.name.localeCompare(lib.name, undefined, { sensitivity: 'base' }) === 0).length >
              1;
            const duplicateHint = duplicateName
              ? intl.formatMessage(moveMessages.duplicateHint, {
                  location: privacySafeLocationHint(lib.path) ?? intl.formatMessage(moveMessages.folder),
                  id: lib.id.slice(-4),
                })
              : null;
            // Duplicate names get the hint too, so no two ⋯ buttons share a name.
            const actionsLabel =
              duplicateHint === null
                ? intl.formatMessage(moveMessages.actions, { name: lib.name })
                : intl.formatMessage(moveMessages.actionsDuplicate, { name: lib.name, hint: duplicateHint });
            const moveBlocked = libraryRowActions(lib, currentId).move !== null;
            return (
              <LibraryRow
                key={lib.id}
                library={lib}
                when={lib.lastOpenedAt === null ? 'Never opened' : formatRelativeTime(lib.lastOpenedAt, loadedAt)}
                duplicateHint={duplicateHint}
                actionsLabel={switchOnly || selecting ? null : actionsLabel}
                menuOpen={menu?.library.id === lib.id}
                selection={selecting ? { checked: selected.has(lib.id), blocked: moveBlocked } : null}
                onActivate={() => {
                  if (!selecting) switchTo(lib);
                  else if (!moveBlocked) toggleSelected(lib);
                }}
                onOpenActions={(anchor, origin, at) => openMenu(lib, actionsLabel, anchor, origin, at)}
              />
            );
          })}
        </ul>
        {menu === null ? null : (
          <LibraryRowMenu
            library={menu.library}
            currentId={currentId}
            label={menu.label}
            x={menu.x}
            y={menu.y}
            onClose={closeMenu}
            onEditDisplayName={() => {
              setDisplayNameTarget(menu.library);
              beginRowAction(menu.library, 'display-name');
            }}
            onRename={() => {
              setRenameTarget(menu.library);
              beginRowAction(menu.library, 'rename');
            }}
            onMove={() => {
              setMoveTargets([menu.library]);
              beginRowAction(menu.library, 'move');
            }}
            onRemove={() => {
              setRemoveTarget(menu.library);
              beginRowAction(menu.library, 'confirm-remove');
            }}
          />
        )}
        <div className="ovl-libswitch__footer">
          {switchOnly ? null : selecting ? (
            <>
              <Button
                variant="primary"
                icon="hard-drive"
                data-testid="move-selected"
                aria-disabled={selected.size === 0}
                aria-describedby={selected.size === 0 ? noneSelectedId : undefined}
                title={selected.size === 0 ? intl.formatMessage(moveMessages.noneSelected) : undefined}
                onClick={moveSelected}
              >
                {intl.formatMessage(moveMessages.moveSelected, { count: selected.size })}
              </Button>
              <span id={noneSelectedId} hidden>
                {intl.formatMessage(moveMessages.noneSelected)}
              </span>
              <Button variant="ghost" data-testid="move-cancel" onClick={cancelSelecting}>
                {intl.formatMessage(moveMessages.modeCancel)}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                icon="plus"
                data-testid="new-library"
                onClick={() => {
                  setRefusal(null);
                  returnFocusRef.current = { part: 'new-library' };
                  setPhase('create');
                }}
              >
                New library…
              </Button>
              <Button icon="folder-open" onClick={addExisting} data-testid="add-existing">
                Add existing…
              </Button>
              {(libs ?? []).length > 1 ? (
                <Button icon="hard-drive" data-testid="move-several" onClick={startSelecting}>
                  {intl.formatMessage(moveMessages.moveSeveral)}
                </Button>
              ) : null}
            </>
          )}
          <span className="prose-note ovl-libswitch__keys">
            {selecting ? intl.formatMessage(moveMessages.modeKeys) : '↑↓ select · ⏎ switch · esc close'}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
