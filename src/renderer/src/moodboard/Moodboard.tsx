import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

import './moodboard.css';
import type { Board, BoardBackground, BoardSize, Placement } from '../../../shared/moodboard/board.js';
import type { PlacementAvailability } from '../../../shared/moodboard/availability.js';
import {
  BOARD_ZOOM_MAX,
  BOARD_ZOOM_MIN,
  BOARD_ZOOM_STEP,
  FULL_CROP,
  MIN_PLACEMENT_SIZE,
  normalizeBoard,
} from '../../../shared/moodboard/board.js';
import {
  alignPlacements,
  bringForward,
  distributePlacements,
  expandGroupSelection,
  groupPlacements,
  movePlacements,
  resizeBy,
  rotatePlacement,
  sendBackward,
  ungroupPlacements,
  type AlignEdge,
  type DistributeAxis,
} from '../../../shared/moodboard/geometry.js';
import { layerPosition, placementLabel, readingOrder } from '../../../shared/moodboard/reading-order.js';
import {
  announceAdded,
  announceAligned,
  announceBroughtForward,
  announceDistributed,
  announceGrouped,
  announceMoved,
  announceRemoved,
  announceResized,
  announceSentBack,
  announceUngrouped,
} from '../../../shared/moodboard/announce.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { Icon } from '../components/Icon';
import { MoodboardPlacement } from './MoodboardPlacement';
import { BoardPanel } from './BoardPanel';
import { BoardToolbar } from './BoardToolbar';
import { handleMoodboardKey } from './use-moodboard-keyboard';
import { moodboardMessages, moodboardStatusText } from './messages';
import type { ResolvePlacement } from './board-seed';

const ANNOUNCE_KEY = 'moodboard';
const GUIDE_THRESHOLD = 6;

// nw n ne / w e / sw s se → (horizontal dir, vertical dir), fraction positions.
const HANDLES: readonly {
  readonly key: string;
  readonly hx: -1 | 0 | 1;
  readonly vy: -1 | 0 | 1;
  readonly fx: number;
  readonly fy: number;
}[] = [
  { key: 'nw', hx: -1, vy: -1, fx: 0, fy: 0 },
  { key: 'n', hx: 0, vy: -1, fx: 0.5, fy: 0 },
  { key: 'ne', hx: 1, vy: -1, fx: 1, fy: 0 },
  { key: 'w', hx: -1, vy: 0, fx: 0, fy: 0.5 },
  { key: 'e', hx: 1, vy: 0, fx: 1, fy: 0.5 },
  { key: 'sw', hx: -1, vy: 1, fx: 0, fy: 1 },
  { key: 's', hx: 0, vy: 1, fx: 0.5, fy: 1 },
  { key: 'se', hx: 1, vy: 1, fx: 1, fy: 1 },
];

function resizeByHandle(p: Placement, hx: number, vy: number, dx: number, dy: number): Placement {
  let { x, y, w, h } = p;
  if (hx > 0) w = Math.max(MIN_PLACEMENT_SIZE, Math.round(p.w + dx));
  else if (hx < 0) {
    w = Math.max(MIN_PLACEMENT_SIZE, Math.round(p.w - dx));
    x = Math.round(p.x + (p.w - w));
  }
  if (vy > 0) h = Math.max(MIN_PLACEMENT_SIZE, Math.round(p.h + dy));
  else if (vy < 0) {
    h = Math.max(MIN_PLACEMENT_SIZE, Math.round(p.h - dy));
    y = Math.round(p.y + (p.h - h));
  }
  return { ...p, x, y, w, h };
}

type Drag =
  | { readonly mode: 'move'; readonly sx: number; readonly sy: number; readonly start: readonly Placement[] }
  | {
      readonly mode: 'resize';
      readonly sx: number;
      readonly sy: number;
      readonly hx: number;
      readonly vy: number;
      readonly base: Placement;
    }
  | { readonly mode: 'rotate'; readonly cx: number; readonly cy: number; readonly base: Placement };

export interface MoodboardProps {
  readonly board: Board;
  readonly resolvePlacement: ResolvePlacement;
  readonly onExport?: (request: { readonly board: Board; readonly availability: Readonly<Record<string, PlacementAvailability>> }) => void;
  /** Seeds the initial selection (stories, tests); the canvas owns it after. */
  readonly initialSelection?: readonly string[];
  /** Photo ids available to add — used to repopulate an emptied board. */
  readonly availablePhotoIds?: readonly string[];
  /** Notified whenever the board changes, so the host can persist it. */
  readonly onBoardChange?: (board: Board) => void;
}

export function Moodboard({
  board: initialBoard,
  resolvePlacement,
  onExport,
  initialSelection,
  availablePhotoIds = [],
  onBoardChange,
}: MoodboardProps): ReactElement {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const [board, setBoard] = useState<Board>(() => normalizeBoard(initialBoard));
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set(initialSelection ?? []));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [guide, setGuide] = useState<{ readonly x?: number; readonly y?: number } | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const emptyAddRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const spaceHeldRef = useRef(false);
  const cropSnapshotRef = useRef<Placement | null>(null);

  const order = useMemo(() => readingOrder(board), [board]);
  const total = order.length;
  const say = useCallback((message: string) => announce(message, 'polite', ANNOUNCE_KEY), [announce]);

  // Notify the host of every board change so it can persist the layout — but
  // not for the initial (loaded/seeded) board, so opening the view never
  // triggers a redundant save.
  const boardSettledRef = useRef(false);
  useEffect(() => {
    if (!boardSettledRef.current) {
      boardSettledRef.current = true;
      return;
    }
    onBoardChange?.(board);
  }, [board, onBoardChange]);

  const patch = useCallback((next: readonly Placement[]) => {
    setBoard((current) => ({ ...current, placements: [...next] }));
  }, []);

  const primaryId = useCallback((): string | null => {
    if (focusId !== null && selection.has(focusId)) return focusId;
    for (const id of selection) return id;
    return null;
  }, [focusId, selection]);

  // Focus the first placement in reading order on mount — never <body>. The
  // .focus() call fires the placement's onFocus, which records focusId, so no
  // state is set from inside the effect.
  useEffect(() => {
    if (total === 0) {
      emptyAddRef.current?.focus();
      return;
    }
    const first = order[0];
    if (first !== undefined) {
      canvasRef.current?.querySelector<HTMLButtonElement>(`[data-testid="moodboard-piece-${first.id}"]`)?.focus();
    }
    // Mount-only: seed focus once.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  // Keyboard activation (Enter/Space): select without starting a drag, so
  // focus and selection remain independent (spec §05).
  const activate = useCallback(
    (id: string, additive: boolean) => {
      setSelection((current) => {
        const base = additive ? new Set(current) : new Set<string>();
        if (additive && current.has(id)) base.delete(id);
        else base.add(id);
        return expandGroupSelection(board.placements, base);
      });
      setFocusId(id);
    },
    [board.placements],
  );

  // ---- pointer drag -------------------------------------------------------
  const onPiecePointerDown = useCallback(
    (event: ReactPointerEvent, id: string) => {
      event.stopPropagation();
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const nextSel = additive ? new Set(selection) : selection.has(id) ? new Set(selection) : new Set([id]);
      if (additive && selection.has(id)) nextSel.delete(id);
      else nextSel.add(id);
      const expanded = expandGroupSelection(board.placements, nextSel);
      setSelection(expanded);
      setFocusId(id);
      const start = board.placements.filter((p) => expanded.has(p.id));
      dragRef.current = { mode: 'move', sx: event.clientX, sy: event.clientY, start };
    },
    [board.placements, selection],
  );

  const onHandlePointerDown = useCallback((event: ReactPointerEvent, base: Placement, hx: number, vy: number) => {
    event.stopPropagation();
    dragRef.current = { mode: 'resize', sx: event.clientX, sy: event.clientY, hx, vy, base };
  }, []);

  const onRotatePointerDown = useCallback(
    (event: ReactPointerEvent, base: Placement) => {
      event.stopPropagation();
      const rect = canvasRef.current?.getBoundingClientRect();
      // The placement renders inside translate(pan) scale(zoom); the rotate
      // center must be projected through the same transform so the pointer
      // angle is measured around the real on-screen center.
      const cx = (rect?.left ?? 0) + pan.x + (base.x + base.w / 2) * zoom;
      const cy = (rect?.top ?? 0) + pan.y + (base.y + base.h / 2) * zoom;
      dragRef.current = { mode: 'rotate', cx, cy, base };
    },
    [pan, zoom],
  );

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      if (drag.mode === 'move') {
        const dx = (event.clientX - drag.sx) / zoom;
        const dy = (event.clientY - drag.sy) / zoom;
        const map = new Map(drag.start.map((p) => [p.id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) }]));
        setBoard((current) => ({
          ...current,
          placements: current.placements.map((p) => {
            const at = map.get(p.id);
            return at === undefined ? p : { ...p, x: at.x, y: at.y };
          }),
        }));
        setGuide(computeGuide(drag.start[0], map, board));
      } else if (drag.mode === 'resize') {
        const dx = (event.clientX - drag.sx) / zoom;
        const dy = (event.clientY - drag.sy) / zoom;
        const resized = resizeByHandle(drag.base, drag.hx, drag.vy, dx, dy);
        setBoard((current) => ({ ...current, placements: current.placements.map((p) => (p.id === drag.base.id ? resized : p)) }));
      } else {
        const angle = (Math.atan2(event.clientY - drag.cy, event.clientX - drag.cx) * 180) / Math.PI + 90;
        const snapped = event.shiftKey ? Math.round(angle / 15) * 15 : angle;
        setBoard((current) => ({
          ...current,
          placements: current.placements.map((p) =>
            p.id === drag.base.id ? rotatePlacement({ ...drag.base, rotation: 0 }, snapped, false) : p,
          ),
        }));
      }
    };
    const up = (): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      setGuide(null);
      if (drag === null) return;
      const primary = drag.mode === 'move' ? drag.start[0]?.id : drag.base.id;
      const settled = board.placements.find((p) => p.id === primary);
      if (settled === undefined) return;
      if (drag.mode === 'resize') say(announceResized(settled.w, settled.h));
      else if (drag.mode === 'move') say(announceMoved(settled.x, settled.y));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [board, zoom, say]);

  // ---- keyboard actions ---------------------------------------------------
  const nudge = useCallback(
    (dx: number, dy: number) => {
      const next = movePlacements(board.placements, selection, dx, dy);
      patch(next);
      const p = next.find((q) => q.id === primaryId());
      if (p !== undefined) say(announceMoved(p.x, p.y));
    },
    [board.placements, selection, patch, primaryId, say],
  );

  const resize = useCallback(
    (dw: number, dh: number, keepAspect: boolean) => {
      const next = board.placements.map((p) => (selection.has(p.id) ? resizeBy(p, dw, dh, keepAspect) : p));
      patch(next);
      const p = next.find((q) => q.id === primaryId());
      if (p !== undefined) say(announceResized(p.w, p.h));
    },
    [board.placements, selection, patch, primaryId, say],
  );

  const rotate = useCallback(
    (delta: number, snap: boolean) => {
      patch(board.placements.map((p) => (selection.has(p.id) ? rotatePlacement(p, delta, snap) : p)));
    },
    [board.placements, selection, patch],
  );

  const layer = useCallback(
    (direction: 1 | -1) => {
      const next = direction > 0 ? bringForward(board.placements, selection) : sendBackward(board.placements, selection);
      patch(next);
      const id = primaryId();
      if (id === null) return;
      const position =
        next
          .slice()
          .sort((a, b) => a.z - b.z)
          .findIndex((p) => p.id === id) + 1;
      say(direction > 0 ? announceBroughtForward(position, next.length) : announceSentBack(position, next.length));
    },
    [board.placements, selection, patch, primaryId, say],
  );

  const group = useCallback(() => {
    if (selection.size < 2) return;
    patch(groupPlacements(board.placements, selection, `g-${crypto.randomUUID()}`));
    say(announceGrouped(selection.size));
  }, [board.placements, selection, patch, say]);

  const ungroup = useCallback(() => {
    patch(ungroupPlacements(board.placements, selection));
    say(announceUngrouped());
  }, [board.placements, selection, patch, say]);

  const remove = useCallback(() => {
    const removed = new Set(selection);
    const nextOrder = order.filter((p) => !removed.has(p.id));
    patch(board.placements.filter((p) => !removed.has(p.id)));
    setSelection(new Set());
    say(announceRemoved());
    const nextFocus = nextOrder[0];
    if (nextFocus !== undefined) {
      setFocusId(nextFocus.id);
      requestAnimationFrame(() =>
        canvasRef.current?.querySelector<HTMLButtonElement>(`[data-testid="moodboard-piece-${nextFocus.id}"]`)?.focus(),
      );
    }
  }, [board.placements, selection, order, patch, say]);

  const zoomBy = useCallback((direction: 1 | -1 | 0) => {
    setZoom((current) => {
      if (direction === 0) {
        setPan({ x: 0, y: 0 });
        return 1;
      }
      const next = current + direction * BOARD_ZOOM_STEP;
      return Math.min(BOARD_ZOOM_MAX, Math.max(BOARD_ZOOM_MIN, Math.round(next * 100) / 100));
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => setPan((current) => ({ x: current.x + dx, y: current.y + dy })), []);

  const align = useCallback(
    (edge: AlignEdge) => {
      patch(alignPlacements(board.placements, selection, edge));
      say(announceAligned(edge));
    },
    [board.placements, selection, patch, say],
  );

  const distribute = useCallback(
    (axis: DistributeAxis) => {
      patch(distributePlacements(board.placements, selection, axis));
      say(announceDistributed(axis));
    },
    [board.placements, selection, patch, say],
  );

  const singleSelected = selection.size === 1 ? (board.placements.find((p) => selection.has(p.id)) ?? null) : null;

  const toggleCrop = useCallback(() => {
    if (cropMode) {
      setCropMode(false);
      return;
    }
    if (singleSelected === null) return;
    cropSnapshotRef.current = singleSelected;
    // A full-frame crop has no room to pan (1 - w = 0); inset it so the arrow
    // keys can actually move the visible window. Esc restores the snapshot.
    if (singleSelected.crop.w >= 1 && singleSelected.crop.h >= 1) {
      patch(board.placements.map((p) => (p.id === singleSelected.id ? { ...p, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } : p)));
    }
    setCropMode(true);
  }, [cropMode, singleSelected, board.placements, patch]);

  const commitCrop = useCallback(() => {
    cropSnapshotRef.current = null;
    setCropMode(false);
  }, []);

  const cancelCrop = useCallback(() => {
    const snapshot = cropSnapshotRef.current;
    if (snapshot !== null) patch(board.placements.map((p) => (p.id === snapshot.id ? snapshot : p)));
    cropSnapshotRef.current = null;
    setCropMode(false);
  }, [board.placements, patch]);

  const adjustCrop = useCallback(
    (dx: number, dy: number) => {
      const id = primaryId();
      if (id === null) return;
      patch(
        board.placements.map((p) => {
          if (p.id !== id) return p;
          const nx = Math.min(Math.max(p.crop.x + dx * 0.02, 0), 1 - p.crop.w);
          const ny = Math.min(Math.max(p.crop.y + dy * 0.02, 0), 1 - p.crop.h);
          return { ...p, crop: { ...p.crop, x: Math.round(nx * 1e6) / 1e6, y: Math.round(ny * 1e6) / 1e6 } };
        }),
      );
    },
    [board.placements, primaryId, patch],
  );

  const addPhoto = useCallback(() => {
    // Duplicate an existing placement's photo, or fall back to the first
    // available library photo so an emptied board can be repopulated.
    const photoId = board.placements[0]?.photoId ?? availablePhotoIds[0];
    if (photoId === undefined) return;
    const id = `pl-${crypto.randomUUID()}`;
    const maxZ = board.placements.reduce((m, p) => Math.max(m, p.z), 0);
    const placement: Placement = { id, photoId, x: 320, y: 220, w: 200, h: 150, rotation: 0, crop: FULL_CROP, z: maxZ + 1, groupId: null };
    patch([...board.placements, placement]);
    setSelection(new Set([id]));
    setFocusId(id);
    say(announceAdded());
  }, [board.placements, availablePhotoIds, patch, say]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === ' ') spaceHeldRef.current = true;
    handleMoodboardKey(
      event,
      { hasSelection: selection.size > 0, cropMode, spaceHeld: spaceHeldRef.current },
      {
        nudge,
        resize,
        rotate,
        layer,
        group,
        ungroup,
        remove,
        zoom: zoomBy,
        pan: panBy,
        toggleCrop,
        commitCrop,
        cancelCrop,
        adjustCrop,
      },
    );
  };
  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === ' ') spaceHeldRef.current = false;
  };

  const groupBoxes = useMemo(() => computeGroupBoxes(board.placements), [board.placements]);

  return (
    <div className="ovl-moodboard">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- role=application is the documented exception (spec §05): freeform 2-D manipulation is not expressible as a native widget; the parallel reading-order list below carries structure non-visually, and every gesture has a keyboard equivalent. */}
      <div
        ref={canvasRef}
        className="ovl-moodboard__canvas"
        data-bg={board.background}
        role="application"
        aria-label={intl.formatMessage(moodboardMessages.canvasLabel, { title: board.title })}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerDown={() => setSelection(new Set())}
        style={{
          backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      >
        <div className="ovl-moodboard__scene" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {groupBoxes.map((box) => (
            <div key={box.key} className="ovl-moodboard__groupbox" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
          ))}
          {guide?.x !== undefined ? (
            <div className="ovl-moodboard__guide" style={{ left: guide.x, top: 0, width: 1, height: board.size.height }} />
          ) : null}
          {guide?.y !== undefined ? (
            <div className="ovl-moodboard__guide" style={{ left: 0, top: guide.y, width: board.size.width, height: 1 }} />
          ) : null}
          {order.map((placement) => {
            const view = resolvePlacement(placement.photoId);
            return (
              <MoodboardPlacement
                key={placement.id}
                placement={placement}
                view={view}
                label={placementLabel({
                  photoName: view.name || null,
                  layer: layerPosition(board, placement.id),
                  total,
                  // The placement shows a status badge or placeholder for
                  // offloaded, unavailable and locked content; the name
                  // repeats those words so the visible label stays inside the
                  // accessible name (WCAG 2.5.3).
                  qualifier: moodboardStatusText(intl, view.availability),
                })}
                selected={selection.has(placement.id)}
                onPointerDown={onPiecePointerDown}
                onActivate={activate}
                onFocus={setFocusId}
              />
            );
          })}
          {singleSelected !== null ? (
            <>
              <div
                className="ovl-moodboard__rotate"
                style={{ left: singleSelected.x + singleSelected.w / 2 - 6, top: singleSelected.y - 24 }}
                onPointerDown={(event) => onRotatePointerDown(event, singleSelected)}
                aria-hidden
              />
              {HANDLES.map((handle) => (
                <div
                  key={handle.key}
                  className="ovl-moodboard__handle"
                  style={{
                    left: singleSelected.x + handle.fx * singleSelected.w - 5,
                    top: singleSelected.y + handle.fy * singleSelected.h - 5,
                  }}
                  onPointerDown={(event) => onHandlePointerDown(event, singleSelected, handle.hx, handle.vy)}
                  aria-hidden
                />
              ))}
            </>
          ) : null}
        </div>

        {total === 0 ? (
          <div className="ovl-moodboard__empty">
            <Icon name="layout-dashboard" size={28} color="var(--text-faint)" />
            <div className="ovl-moodboard__empty-title">
              <FormattedMessage {...moodboardMessages.emptyTitle} />
            </div>
            <div>
              <FormattedMessage {...moodboardMessages.emptyHint} />
            </div>
            <button ref={emptyAddRef} type="button" className="ovl-button ovl-button--primary ovl-button--md" onClick={addPhoto}>
              <Icon name="plus" size={16} />
              <FormattedMessage {...moodboardMessages.add} />
            </button>
          </div>
        ) : null}
      </div>

      <BoardPanel
        board={board}
        selected={singleSelected}
        onTitleChange={(title) => setBoard((current) => ({ ...current, title }))}
        onNotesChange={(notes) => setBoard((current) => ({ ...current, notes }))}
        onSizeChange={(size: BoardSize) => setBoard((current) => ({ ...current, size }))}
        onBackgroundChange={(background: BoardBackground) => setBoard((current) => ({ ...current, background }))}
      />

      <BoardToolbar
        zoom={zoom}
        cropMode={cropMode}
        hasSelection={selection.size > 0}
        canGroup={selection.size >= 2}
        canUngroup={board.placements.some((p) => selection.has(p.id) && p.groupId !== null)}
        onAdd={addPhoto}
        onAlign={align}
        onDistribute={distribute}
        onGroup={group}
        onUngroup={ungroup}
        onBringForward={() => layer(1)}
        onSendBack={() => layer(-1)}
        onToggleCrop={toggleCrop}
        onZoomIn={() => zoomBy(1)}
        onZoomOut={() => zoomBy(-1)}
        onFit={() => zoomBy(0)}
        onExport={() =>
          onExport?.({
            board,
            availability: Object.fromEntries(
              board.placements.map((placement) => [placement.id, resolvePlacement(placement.photoId).availability]),
            ),
          })
        }
      />

      <ol className="ovl-moodboard__reading-order" aria-label={intl.formatMessage(moodboardMessages.readingOrder)}>
        {order.map((placement, index) => {
          const view = resolvePlacement(placement.photoId);
          return (
            <li key={placement.id}>
              {placementLabel({
                photoName: view.name || null,
                layer: index + 1,
                total,
                qualifier: moodboardStatusText(intl, view.availability),
              })}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface GuideResult {
  readonly x?: number;
  readonly y?: number;
}

function computeGuide(primary: Placement | undefined, moved: Map<string, { x: number; y: number }>, board: Board): GuideResult | null {
  if (primary === undefined) return null;
  const at = moved.get(primary.id);
  if (at === undefined) return null;
  const cx = at.x + primary.w / 2;
  const cy = at.y + primary.h / 2;
  const boardCx = board.size.width / 2;
  const boardCy = board.size.height / 2;
  if (Math.abs(cx - boardCx) <= GUIDE_THRESHOLD) return { x: boardCx };
  if (Math.abs(cy - boardCy) <= GUIDE_THRESHOLD) return { y: boardCy };
  for (const other of board.placements) {
    if (other.id === primary.id) continue;
    if (Math.abs(cx - (other.x + other.w / 2)) <= GUIDE_THRESHOLD) return { x: other.x + other.w / 2 };
    if (Math.abs(cy - (other.y + other.h / 2)) <= GUIDE_THRESHOLD) return { y: other.y + other.h / 2 };
  }
  return null;
}

interface GroupBox {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function computeGroupBoxes(placements: readonly Placement[]): readonly GroupBox[] {
  const groups = new Map<string, Placement[]>();
  for (const placement of placements) {
    if (placement.groupId === null) continue;
    const bucket = groups.get(placement.groupId) ?? [];
    bucket.push(placement);
    groups.set(placement.groupId, bucket);
  }
  const boxes: GroupBox[] = [];
  for (const [key, members] of groups) {
    const minX = Math.min(...members.map((p) => p.x));
    const minY = Math.min(...members.map((p) => p.y));
    const maxX = Math.max(...members.map((p) => p.x + p.w));
    const maxY = Math.max(...members.map((p) => p.y + p.h));
    boxes.push({ key, x: minX - 6, y: minY - 6, w: maxX - minX + 12, h: maxY - minY + 12 });
  }
  return boxes;
}
