import { useCallback, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import './pill.css';
import { photoKeyMessages } from '../commands/photo-command-targets.js';
import { commandById } from '../../../shared/commands/registry.js';
import { useFormats } from '../i18n/use-formats.js';
import { Button } from '../components/Button';
import { useCollapseLevel } from '../components/collapse-level';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { IconButton } from '../components/IconButton';
import { Tooltip } from '../components/Tooltip';
import { AlbumPicker } from './AlbumPicker';
import { collapseLevels, DANGER_ACTIONS, overflowFor, type PillActionId } from './selection-pill-actions';
import type { AlbumSummary } from '../../../shared/library/types.js';
import { destructiveActions } from '../../../shared/destructive-actions.js';

const pillMessages = defineMessages({
  offload: { id: 'selectionPill.offload', defaultMessage: 'Offload' },
  transfer: { id: 'selectionPill.transfer', defaultMessage: 'Transfer & Sync' },
  addToAlbum: { id: 'selectionPill.addToAlbum', defaultMessage: 'Add to album' },
});

export interface SelectionPillProps {
  readonly count: number;
  readonly onClear: () => void;
  /** Opens the ExportDialog with the selection set (#100). */
  readonly exportDisabledReason?: string | undefined;
  readonly onExport?: (() => void) | undefined;
  readonly onRetryExport?: (() => void) | undefined;
  readonly onOffload?: (() => void) | undefined;
  readonly onTransfer?: (() => void) | undefined;
  /** Soft-deletes the selection (#120) into reversible Trash custody. */
  readonly onDelete?: (() => void) | undefined;
  /** Inside Trash the pill flips to restore mode (#120). */
  readonly onRestore?: (() => void) | undefined;
  /** Adds the selection to the picked album (#118). */
  readonly onAddToAlbum?: ((album: AlbumSummary) => void) | undefined;
  /** Active-album mode: removes membership without deleting photos (#282). */
  readonly onRemoveFromAlbum?: (() => void) | undefined;
  /** Trash-only destructive path (#121) — opens the confirm ceremony. */
  readonly onPurge?: (() => void) | undefined;
  readonly onMarkOriginal?: (() => void) | undefined;
  readonly onUnmarkOriginal?: (() => void) | undefined;
}

interface PillAction {
  readonly id: string;
  readonly label: string;
  readonly icon: 'cloud-upload' | 'refresh-cw' | 'share' | 'album' | 'shield-check' | 'trash-2' | 'x';
  readonly run: (() => void) | undefined;
  readonly danger?: boolean;
  /** Unavailable: stays focusable and names its reason (Pass E shared rule). */
  readonly unavailableReason?: string | undefined;
  readonly description?: string | undefined;
}

interface OpenMenu {
  readonly x: number;
  readonly y: number;
  readonly anchorEdge: 'left' | 'right';
}

function isRendered(element: Element): boolean {
  return element.getClientRects().length > 0;
}

function moreButton(pill: HTMLElement): HTMLElement | null {
  return pill.querySelector<HTMLElement>('.ovl-pill__more button');
}

// Focus stays in the pill as it collapses: an action that just moved to ⋯
// hands focus to ⋯, and ⋯ leaving hands it to the last inline action.
function handOffFocus(pill: HTMLElement, focused: Element | null): void {
  if (!(focused instanceof HTMLElement) || !pill.contains(focused) || isRendered(focused)) return;
  const more = moreButton(pill);
  if (more !== null && isRendered(more)) {
    more.focus();
    return;
  }
  Array.from(pill.querySelectorAll<HTMLElement>('.ovl-pill__action button')).filter(isRendered).at(-1)?.focus();
}

// Floating selection pill (#78) — the mock's bottom-center bar. Actions
// collapse into ⋯ one at a time in a fixed priority order as the content
// area narrows (#1304, Pass E spec), on the toolbar's collapse rule.
export function SelectionPill(props: SelectionPillProps): ReactElement {
  const intl = useIntl();
  const exportReasonId = useId();
  const { formatCount } = useFormats();
  const pillRef = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<'inline' | 'menu' | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  const actions = pillActions(props, intl.formatMessage);
  const order = [...actions.keys()];
  const levels = collapseLevels(order);
  // A level change reshuffles what ⋯ holds, so an open menu closes first and
  // focus returns to ⋯ (or, with ⋯ gone, the last inline action).
  const settledLevelRef = useRef<number | null>(null);
  const onSettle = useCallback((pill: HTMLElement, focused: Element | null): void => {
    const next = Number(pill.dataset['collapse']);
    const changed = settledLevelRef.current !== null && settledLevelRef.current !== next;
    settledLevelRef.current = next;
    if (changed && pill.querySelector('[role="menu"]') !== null) {
      setMenu(null);
      const more = moreButton(pill);
      if (more !== null && isRendered(more)) more.focus();
    }
    handOffFocus(pill, focused);
  }, []);
  const collapse = useMemo(() => ({ onSettle }), [onSettle]);
  const level = useCollapseLevel(pillRef, order.length, collapse);
  const overflow = overflowFor(order, level);

  const focusMore = (): void => {
    const pill = pillRef.current;
    const more = pill === null ? null : moreButton(pill);
    if (pill !== null && more !== null && isRendered(more)) more.focus();
    else if (pill !== null) handOffFocus(pill, more);
  };
  const closeMenu = (): void => {
    setMenu(null);
    focusMore();
  };

  const openMenu = (): void => {
    const button = pillRef.current === null ? null : moreButton(pillRef.current);
    if (button === null) return;
    const rect = button.getBoundingClientRect();
    const rtl = getComputedStyle(button).direction === 'rtl';
    setMenu({ x: rtl ? rect.left : rect.right, y: rect.top - 8, anchorEdge: rtl ? 'left' : 'right' });
  };

  const menuItems = overflow.flatMap((id, index): ContextMenuItem[] =>
    (actions.get(id) ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.icon,
      action: () => {
        if (id === 'add') setPicker('menu');
        else action.run?.();
      },
      danger: action.danger,
      separatorBefore: DANGER_ACTIONS.has(id) && index > 0,
      disabled: action.unavailableReason !== undefined,
      description: action.unavailableReason ?? action.description,
    })),
  );

  const closePicker = (): void => {
    const from = picker;
    setPicker(null);
    if (from === 'menu') focusMore();
    else pillRef.current?.querySelector<HTMLElement>('[data-action="add"] button')?.focus();
  };

  return (
    <div className="ovl-pill-anchor">
      <div ref={pillRef} className="ovl-pill" data-testid="selection-pill" data-collapse={level}>
        {picker !== null && props.onAddToAlbum !== undefined ? (
          <AlbumPicker
            onPick={(album) => {
              closePicker();
              props.onAddToAlbum?.(album);
            }}
            onClose={closePicker}
          />
        ) : null}
        {props.exportDisabledReason === undefined ? null : (
          <span id={exportReasonId} hidden>
            {props.exportDisabledReason}
          </span>
        )}
        <span className="ovl-pill__count mono-data">{formatCount(props.count)} selected</span>
        {order.map((id) => (
          <span key={id} className="ovl-pill__action" data-action={id} data-collapse-at={levels.get(id)}>
            {(actions.get(id) ?? []).map((action) =>
              inlineButton(action, {
                reasonId: props.exportDisabledReason === undefined ? undefined : exportReasonId,
                onClick: id === 'add' ? () => setPicker((open) => (open === null ? 'inline' : null)) : action.run,
              }),
            )}
          </span>
        ))}
        <span className="ovl-pill__more">
          <IconButton
            icon="ellipsis"
            label="More selection actions"
            size="sm"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            // Keep this pointerdown from reaching the menu's outside-click
            // listener, so a second click toggles it shut cleanly.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              if (menu === null) openMenu();
              else closeMenu();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' || menu !== null) return;
              event.preventDefault();
              openMenu();
            }}
          />
          {menu === null ? null : (
            <ContextMenu
              label="Selection actions"
              x={menu.x}
              y={menu.y}
              anchorEdge={menu.anchorEdge}
              blockEdge="bottom"
              items={menuItems}
              initialFocus="first-enabled"
              closeOnTab
              onClose={closeMenu}
            />
          )}
        </span>
        <IconButton icon="x" label="Clear selection" size="sm" onClick={props.onClear} />
      </div>
    </div>
  );
}

function inlineButton(
  action: PillAction,
  options: {
    readonly reasonId: string | undefined;
    readonly onClick: (() => void) | undefined;
  },
): ReactNode {
  const unavailable = action.unavailableReason !== undefined;
  const button = (
    <Button
      key={action.id}
      size="sm"
      variant={action.danger === true ? 'danger' : 'secondary'}
      icon={action.icon}
      aria-disabled={unavailable ? true : undefined}
      aria-describedby={action.id === 'export' ? options.reasonId : undefined}
      onClick={unavailable ? undefined : options.onClick}
    >
      {action.label}
    </Button>
  );
  if (!unavailable) return button;
  return (
    // The hidden reason span already describes the button; the bubble is visual only.
    <Tooltip key={action.id} label={action.unavailableReason} describe={action.id !== 'export'}>
      {button}
    </Tooltip>
  );
}

type FormatMessage = ReturnType<typeof useIntl>['formatMessage'];

// Every action the selection allows, keyed in inline order (Pass E): Offload ·
// Transfer & Sync · Export · Add to album · Mark/Unmark Original · Move to
// Trash (Remove from album in an album). Trash: Restore · Delete permanently….
function pillActions(props: SelectionPillProps, format: FormatMessage): ReadonlyMap<PillActionId, readonly PillAction[]> {
  const labels = destructiveActions;
  if (props.onRestore !== undefined) {
    return new Map<PillActionId, readonly PillAction[]>([
      ['restore', [{ id: 'restore', label: labels.restorePhotosFromTrash.label, icon: 'refresh-cw', run: props.onRestore }]],
      ['purge', [{ id: 'purge', label: labels.deletePhotosPermanently.label, icon: 'trash-2', run: props.onPurge, danger: true }]],
    ]);
  }
  const map = new Map<PillActionId, readonly PillAction[]>();
  map.set('offload', [{ id: 'offload', label: format(pillMessages.offload), icon: 'cloud-upload', run: props.onOffload }]);
  if (props.onTransfer !== undefined)
    map.set('transfer', [{ id: 'transfer', label: format(pillMessages.transfer), icon: 'refresh-cw', run: props.onTransfer }]);
  const retry = props.onRetryExport !== undefined;
  map.set('export', [
    {
      id: 'export',
      label: format(retry ? photoKeyMessages.retry : commandById('photo.export').label),
      icon: 'share',
      run: props.onRetryExport ?? props.onExport,
      unavailableReason: retry ? undefined : props.exportDisabledReason,
      description: retry ? props.exportDisabledReason : undefined,
    },
  ]);
  map.set('add', [{ id: 'add', label: format(pillMessages.addToAlbum), icon: 'album', run: undefined }]);
  const original: PillAction[] = [];
  if (props.onMarkOriginal !== undefined)
    original.push({ id: 'mark', label: format(commandById('photo.original.mark').label), icon: 'shield-check', run: props.onMarkOriginal });
  if (props.onUnmarkOriginal !== undefined)
    original.push({
      id: 'unmark',
      label: format(commandById('photo.original.unmark').label),
      icon: 'shield-check',
      run: props.onUnmarkOriginal,
    });
  if (original.length > 0) map.set('original', original);
  if (props.onRemoveFromAlbum === undefined)
    map.set('trash', [{ id: 'trash', label: labels.movePhotosToTrash.label, icon: 'trash-2', run: props.onDelete, danger: true }]);
  else map.set('remove', [{ id: 'remove', label: labels.removePhotosFromAlbum.label, icon: 'x', run: props.onRemoveFromAlbum }]);
  return map;
}
