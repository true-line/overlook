import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, SyntheticEvent, WheelEvent as ReactWheelEvent } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { COMMANDS, formatAriaShortcut, formatShortcut, resolveCommand, type CommandId } from '../../../shared/commands/registry.js';
import { commandPlatform } from '../state/use-command-dispatcher';

import type { PhotoRecord } from '../../../shared/library/types.js';
import {
  IDENTITY_TRANSFORM,
  carryCrop,
  isIdentityTransform,
  transformsEqual,
  type EditCrop,
  type EditTransform,
} from '../../../shared/library/edit-revision.js';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { previewFailureLabel } from '../components/previewFailureLabel';
import { CropOverlay } from './CropOverlay';
import {
  DEFAULT_ORIENTATION,
  DEFAULT_VIEW_INTENT,
  clampTransform,
  cropCenterOffset,
  cropClipInset,
  croppedSize,
  fillZoom,
  flipVerticalOrientation,
  fitSize,
  orientedSize,
  panBy,
  rotateOrientation,
  transformToViewIntent,
  viewIntentToTransform,
  zoomAround,
  type LightboxOrientation,
  type LightboxSize,
  type LightboxViewIntent,
  type LightboxZoomMode,
} from './geometry.js';

const HINT_STORAGE_KEY = 'overlook.lightbox-gestures-seen';
const HINT_MS = 5500;
const KEYBOARD_ZOOM_STEP = 1.25;
const KEYBOARD_PAN_STEP = 64;
const LOADING_INDICATOR_DELAY_MS = 180;

const messages = defineMessages({
  loading: {
    id: 'lightbox.image.loading',
    defaultMessage: 'Loading full-resolution image…',
  },
  editToolbar: { id: 'lightbox.edit.toolbar', defaultMessage: 'Edit controls' },
  // The zoom-reset button shows the current zoom as its visible label, so the
  // name has to carry that number outside a parenthetical (axe strips
  // parentheticals before comparing the label with the name).
  fitImage: { id: 'lightbox.zoom.fitImage', defaultMessage: 'Fit image, currently {zoom}%' },
  cropSurface: { id: 'lightbox.edit.cropSurface', defaultMessage: 'Crop area — drag to frame the photo' },
  cropApply: { id: 'lightbox.edit.cropApply', defaultMessage: 'Apply crop (Enter)' },
  cropCancel: { id: 'lightbox.edit.cropCancel', defaultMessage: 'Cancel crop (Esc)' },
  cropClear: { id: 'lightbox.edit.cropClear', defaultMessage: 'Clear crop' },
  unsupported: {
    id: 'lightbox.edit.unsupported',
    defaultMessage: 'Edited with a newer version of Overlook — showing the original, view only',
  },
  unsaved: { id: 'lightbox.edit.unsaved', defaultMessage: 'Unsaved edit' },
});

type ImageLoadStage = 'loading' | 'decoded' | 'error';

/** Persisted edits (#493): the head's transform and the mutations the
 * viewport can request. Absent when the photo cannot be edited (video,
 * Storybook without a bridge). */
export interface LightboxEditProps {
  readonly persisted: EditTransform;
  /** The head was written by a newer format; controls are read-only. */
  readonly unsupported: string | null;
  readonly busy: boolean;
  readonly canRevert: boolean;
  readonly onSave: (transform: EditTransform) => void;
  readonly onReset: () => void;
  readonly onRevert: () => void;
}

interface LightboxViewportProps {
  readonly platform: string;
  readonly requestKey: string;
  readonly photo: PhotoRecord;
  readonly viewIntent: LightboxViewIntent;
  readonly onViewIntentChange: (intent: LightboxViewIntent) => void;
  readonly imageSrc: string;
  readonly chromeVisible: boolean;
  readonly onActivity: () => void;
  readonly onDimensionsResolved: (width: number, height: number) => void;
  readonly edit?: LightboxEditProps | undefined;
}

const EDIT_COMMANDS: readonly CommandId[] = ['photo.edit.save', 'photo.edit.crop', 'photo.edit.reset', 'photo.edit.revert'];

function shouldShowHint(): boolean {
  try {
    return window.localStorage.getItem(HINT_STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}

function recordHint(): void {
  try {
    window.localStorage.setItem(HINT_STORAGE_KEY, '1');
  } catch {
    // A locked-down profile may reject localStorage; the hint still expires.
  }
}

function wheelPixels(value: number, mode: number, viewportAxis: number): number {
  if (mode === WheelEvent.DOM_DELTA_LINE) return value * 16;
  if (mode === WheelEvent.DOM_DELTA_PAGE) return value * viewportAxis;
  return value;
}

function orientationOf(transform: EditTransform): LightboxOrientation {
  return { quarterTurns: transform.quarterTurns, flipped: transform.flipped };
}

function cropAttribute(crop: EditCrop | null): string {
  return crop === null ? 'none' : [crop.left, crop.top, crop.width, crop.height].map((part) => part.toFixed(3)).join(',');
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

export function LightboxViewport({
  platform,
  requestKey,
  photo,
  viewIntent,
  onViewIntentChange,
  imageSrc,
  chromeVisible,
  onActivity,
  onDimensionsResolved,
  edit,
}: LightboxViewportProps): ReactElement {
  const intl = useIntl();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<LightboxSize>({ width: 0, height: 0 });
  const persisted = edit?.persisted ?? IDENTITY_TRANSFORM;
  // The draft starts on the persisted head and follows it until the user
  // touches it; saving, resetting and reverting hand control back so the
  // head that lands (or a later external change) flows into the view again.
  const [orientation, setOrientation] = useState<LightboxOrientation>(() => orientationOf(persisted));
  const [crop, setCrop] = useState<EditCrop | null>(persisted.crop);
  const [cropMode, setCropMode] = useState(false);
  const [cropDraft, setCropDraft] = useState<EditCrop | null>(null);
  const [touched, setTouched] = useState(false);
  const [syncedFrom, setSyncedFrom] = useState(persisted);
  if (syncedFrom !== persisted) {
    setSyncedFrom(persisted);
    if (!touched) {
      setOrientation(orientationOf(persisted));
      setCrop(persisted.crop);
    }
  }
  const draft = useMemo<EditTransform>(
    () => ({ quarterTurns: orientation.quarterTurns, flipped: orientation.flipped, crop }),
    [crop, orientation.flipped, orientation.quarterTurns],
  );
  const [showHint, setShowHint] = useState(shouldShowHint);
  const [decoded, setDecoded] = useState<LightboxSize | null>(null);
  const source = imageSrc;
  const [loadStage, setLoadStage] = useState<ImageLoadStage>('loading');
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const image = useMemo(() => decoded ?? { width: photo.width, height: photo.height }, [decoded, photo.height, photo.width]);
  const orientedImage = useMemo(() => orientedSize(image, orientation), [image, orientation]);
  // The view fits the FRAMED region: the crop when one is applied, the whole
  // oriented image while the crop is being drawn.
  const activeCrop = cropMode ? null : crop;
  const visible = useMemo(() => croppedSize(orientedImage, activeCrop), [activeCrop, orientedImage]);
  const fitted = fitSize(visible, viewport);
  const scale = visible.width > 0 ? fitted.width / visible.width : 0;
  const fullOriented = { width: orientedImage.width * scale, height: orientedImage.height * scale };
  const transform = viewIntentToTransform(viewIntent, visible, viewport);
  const mode = viewIntent.mode;
  const elementSize = orientedSize(fullOriented, orientation);
  const cropOffset = cropCenterOffset(activeCrop);
  const cropShift = { x: -cropOffset.x * fullOriented.width * transform.zoom, y: -cropOffset.y * fullOriented.height * transform.zoom };
  const clip = activeCrop === null ? null : cropClipInset(activeCrop, orientation);
  const toolbarTop = Math.max(64, Math.min((viewport.height + fitted.height) / 2 - 8, viewport.height - 92));
  const chromeClass = chromeVisible ? ' ovl-lightbox__chrome--on' : '';
  const dirty = edit !== undefined && !transformsEqual(draft, persisted);
  const editable = edit !== undefined && edit.unsupported === null && !edit.busy;

  useEffect(() => {
    if (loadStage !== 'loading') return;
    const timer = window.setTimeout(() => {
      setShowLoadingIndicator(true);
    }, LOADING_INDICATOR_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadStage]);

  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      setViewport(next);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!showHint) return;
    recordHint();
    const timer = window.setTimeout(() => {
      setShowHint(false);
    }, HINT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [showHint]);

  const resetView = useCallback(() => {
    onViewIntentChange(DEFAULT_VIEW_INTENT);
    onActivity();
  }, [onActivity, onViewIntentChange]);

  const applyEdit = useCallback(
    (next: LightboxOrientation, nextCrop: EditCrop | null) => {
      const axesChanged = next.quarterTurns % 2 !== orientation.quarterTurns % 2;
      const nextFitted = fitSize(croppedSize(orientedSize(image, next), cropMode ? null : nextCrop), viewport);
      const nextMode: LightboxZoomMode = axesChanged && mode === 'fill' ? 'custom' : mode;
      onViewIntentChange(transformToViewIntent(clampTransform(transform, nextFitted, viewport), nextMode, nextFitted, viewport));
      setOrientation(next);
      setCrop(nextCrop);
      setTouched(true);
      setShowHint(false);
      onActivity();
    },
    [cropMode, image, mode, onActivity, onViewIntentChange, orientation.quarterTurns, transform, viewport],
  );

  const rotateBy = useCallback(
    (delta: -1 | 1) => {
      const carried = crop === null ? null : carryCrop(crop, { type: 'rotate', version: 1, quarterTurns: delta === 1 ? 1 : 3 });
      applyEdit(rotateOrientation(orientation, delta), carried);
    },
    [applyEdit, crop, orientation],
  );

  const flipHorizontal = useCallback(() => {
    const carried = crop === null ? null : carryCrop(crop, { type: 'flip', version: 1, axis: 'horizontal' });
    applyEdit({ ...orientation, flipped: !orientation.flipped }, carried);
  }, [applyEdit, crop, orientation]);

  const flipVertical = useCallback(() => {
    const carried = crop === null ? null : carryCrop(crop, { type: 'flip', version: 1, axis: 'vertical' });
    applyEdit(flipVerticalOrientation(orientation), carried);
  }, [applyEdit, crop, orientation]);

  const resetOrientation = useCallback(() => {
    // Undo the view's mirror first, then the remaining clockwise turns, so an
    // existing crop keeps framing the same pixels.
    let carried = crop;
    if (carried !== null && orientation.flipped) carried = carryCrop(carried, { type: 'flip', version: 1, axis: 'horizontal' });
    const remaining = (4 - orientation.quarterTurns) % 4;
    if (carried !== null && (remaining === 1 || remaining === 2 || remaining === 3)) {
      carried = carryCrop(carried, { type: 'rotate', version: 1, quarterTurns: remaining });
    }
    applyEdit(DEFAULT_ORIENTATION, carried);
  }, [applyEdit, crop, orientation.flipped, orientation.quarterTurns]);

  const zoomBy = useCallback(
    (factor: number) => {
      const next = zoomAround(transform, transform.zoom * factor, { x: viewport.width / 2, y: viewport.height / 2 }, fitted, viewport);
      onViewIntentChange(transformToViewIntent(next, 'custom', fitted, viewport));
      setShowHint(false);
      onActivity();
    },
    [fitted, onActivity, onViewIntentChange, transform, viewport],
  );

  const enterCropMode = useCallback(() => {
    if (!editable) return;
    setCropDraft(crop);
    setCropMode(true);
    onViewIntentChange(DEFAULT_VIEW_INTENT);
    setShowHint(false);
    onActivity();
  }, [crop, editable, onActivity, onViewIntentChange]);

  const leaveCropMode = useCallback(
    (apply: boolean) => {
      if (apply) {
        setCrop(cropDraft);
        setTouched(true);
      }
      setCropDraft(null);
      setCropMode(false);
      onViewIntentChange(DEFAULT_VIEW_INTENT);
      onActivity();
    },
    [cropDraft, onActivity, onViewIntentChange],
  );

  const saveEdit = useCallback(() => {
    if (edit === undefined || !editable) return;
    const next: EditTransform = { ...draft, crop: cropMode ? cropDraft : crop };
    if (cropMode) leaveCropMode(true);
    if (transformsEqual(next, persisted)) return;
    setTouched(false);
    edit.onSave(next);
  }, [crop, cropDraft, cropMode, draft, edit, editable, leaveCropMode, persisted]);

  const resetEdits = useCallback(() => {
    if (edit === undefined || !editable) return;
    setCropDraft(null);
    setCropMode(false);
    setOrientation(DEFAULT_ORIENTATION);
    setCrop(null);
    onViewIntentChange(DEFAULT_VIEW_INTENT);
    onActivity();
    setTouched(false);
    if (!isIdentityTransform(persisted)) edit.onReset();
  }, [edit, editable, onActivity, onViewIntentChange, persisted]);

  const revertEdit = useCallback(() => {
    if (edit === undefined || !editable || !edit.canRevert) return;
    setCropDraft(null);
    setCropMode(false);
    setTouched(false);
    onViewIntentChange(DEFAULT_VIEW_INTENT);
    onActivity();
    edit.onRevert();
  }, [edit, editable, onActivity, onViewIntentChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const inField =
        event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null;
      const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
      if (inField || modalOpen) return;
      const context = { surface: 'lightbox' as const, dialogOpen: modalOpen, editable: inField, platform: commandPlatform(platform) };
      if (edit !== undefined) {
        if (cropMode && (event.key === 'Enter' || event.key === 'Escape')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          leaveCropMode(event.key === 'Enter');
          return;
        }
        const editCommand = resolveCommand(event, context)?.id;
        if (editCommand !== undefined && EDIT_COMMANDS.includes(editCommand)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (editCommand === 'photo.edit.save') saveEdit();
          else if (editCommand === 'photo.edit.crop') {
            if (cropMode) leaveCropMode(true);
            else enterCropMode();
          } else if (editCommand === 'photo.edit.reset') resetEdits();
          else revertEdit();
          return;
        }
      }
      if (event.metaKey || event.ctrlKey) return;
      const horizontalOverflow = fitted.width * transform.zoom > viewport.width + 1;
      const verticalOverflow = fitted.height * transform.zoom > viewport.height + 1;
      const panDelta =
        event.altKey || event.shiftKey
          ? null
          : event.key === 'ArrowLeft' && horizontalOverflow
            ? { x: KEYBOARD_PAN_STEP, y: 0 }
            : event.key === 'ArrowRight' && horizontalOverflow
              ? { x: -KEYBOARD_PAN_STEP, y: 0 }
              : event.key === 'ArrowUp' && verticalOverflow
                ? { x: 0, y: KEYBOARD_PAN_STEP }
                : event.key === 'ArrowDown' && verticalOverflow
                  ? { x: 0, y: -KEYBOARD_PAN_STEP }
                  : null;
      if (panDelta !== null) {
        event.preventDefault();
        const next = panBy(transform, panDelta, fitted, viewport);
        onViewIntentChange(transformToViewIntent(next, mode, fitted, viewport));
        setShowHint(false);
        onActivity();
        return;
      }
      const command = resolveCommand(event, context);
      if (command?.id === 'view.lightbox.zoomIn') zoomBy(KEYBOARD_ZOOM_STEP);
      else if (command?.id === 'view.lightbox.zoomOut') zoomBy(1 / KEYBOARD_ZOOM_STEP);
      else if (command?.id === 'view.lightbox.zoomReset') resetView();
      else if (command?.id === 'view.lightbox.rotateLeft') rotateBy(-1);
      else if (command?.id === 'view.lightbox.rotateRight') rotateBy(1);
      else if (command?.id === 'view.lightbox.flipHorizontal') flipHorizontal();
      else if (command?.id === 'view.lightbox.flipVertical') flipVertical();
      else if (command?.id === 'view.lightbox.orientationReset') resetOrientation();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [
    cropMode,
    edit,
    enterCropMode,
    fitted,
    flipHorizontal,
    flipVertical,
    leaveCropMode,
    mode,
    onActivity,
    onViewIntentChange,
    platform,
    resetEdits,
    resetOrientation,
    resetView,
    revertEdit,
    rotateBy,
    saveEdit,
    transform,
    viewport,
    zoomBy,
  ]);

  const toggleFill = (): void => {
    if (mode === 'fill') {
      resetView();
      return;
    }
    onViewIntentChange({ mode: 'fill', zoom: fillZoom(visible, viewport), panX: 0, panY: 0 });
    setShowHint(false);
    onActivity();
  };

  const onWheel = (event: ReactWheelEvent<HTMLImageElement>): void => {
    event.preventDefault();
    const deltaX = wheelPixels(event.deltaX, event.deltaMode, viewport.width);
    const deltaY = wheelPixels(event.deltaY, event.deltaMode, viewport.height);
    if (event.altKey) {
      const bounds = viewportRef.current?.getBoundingClientRect();
      const focal = {
        x: bounds === undefined ? viewport.width / 2 : event.clientX - bounds.left,
        y: bounds === undefined ? viewport.height / 2 : event.clientY - bounds.top,
      };
      const next = zoomAround(transform, transform.zoom * Math.exp(-deltaY * 0.002), focal, fitted, viewport);
      onViewIntentChange(transformToViewIntent(next, 'custom', fitted, viewport));
      setShowHint(false);
    } else {
      const next = panBy(transform, { x: -deltaX, y: -deltaY }, fitted, viewport);
      onViewIntentChange(transformToViewIntent(next, mode, fitted, viewport));
    }
    onActivity();
  };

  useEffect(() => {
    if (loadStage === 'error') onViewIntentChange(DEFAULT_VIEW_INTENT);
  }, [loadStage, onViewIntentChange]);

  const onImageLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const element = event.currentTarget;
    void element
      .decode()
      .then(() => {
        if (!element.isConnected) return;
        const width = element.naturalWidth;
        const height = element.naturalHeight;
        if (width <= 0 || height <= 0) {
          setLoadStage('error');
          return;
        }
        if (photo.width <= 0 || photo.height <= 0) {
          setDecoded({ width, height });
          onDimensionsResolved(width, height);
        }
        setLoadStage('decoded');
      })
      .catch(() => {
        if (element.isConnected) setLoadStage('error');
      });
  };

  const commandLabel = (id: CommandId): string => {
    const command = COMMANDS.find((candidate) => candidate.id === id);
    if (command === undefined) return id;
    const label = intl.formatMessage(command.label);
    return command.key === undefined ? label : `${label} (${formatShortcut(command, commandPlatform(platform))})`;
  };

  const ariaShortcut = (id: CommandId): string | undefined => {
    const command = COMMANDS.find((candidate) => candidate.id === id);
    return command === undefined || command.key === undefined ? undefined : formatAriaShortcut(command, commandPlatform(platform));
  };

  const cropBox = {
    left: viewport.width / 2 + transform.x - (fullOriented.width * transform.zoom) / 2,
    top: viewport.height / 2 + transform.y - (fullOriented.height * transform.zoom) / 2,
    width: fullOriented.width * transform.zoom,
    height: fullOriented.height * transform.zoom,
  };
  const imageTransform = `translate3d(${String(transform.x + cropShift.x)}px, ${String(transform.y + cropShift.y)}px, 0) scale(${String(transform.zoom)}) scaleX(${orientation.flipped ? '-1' : '1'}) rotate(${String(orientation.quarterTurns * 90)}deg)`;
  const clipPath =
    clip === null ? undefined : `inset(${percent(clip.top)} ${percent(clip.right)} ${percent(clip.bottom)} ${percent(clip.left)})`;

  return (
    <div
      ref={viewportRef}
      className="ovl-lightbox__viewport"
      data-testid="lightbox-viewport"
      data-mode={mode}
      data-zoom={transform.zoom.toFixed(3)}
      data-pan-x={transform.x.toFixed(1)}
      data-pan-y={transform.y.toFixed(1)}
      data-image-width={image.width}
      data-image-height={image.height}
      data-orientation-turns={orientation.quarterTurns}
      data-orientation-flipped={orientation.flipped ? 'true' : 'false'}
      data-edit-crop={cropAttribute(crop)}
      data-edit-mode={cropMode ? 'crop' : 'view'}
      data-edit-dirty={dirty ? 'true' : 'false'}
      data-edit-busy={edit?.busy === true ? 'true' : 'false'}
      data-load-state={loadStage}
      data-unavailable={loadStage === 'error' ? 'true' : 'false'}
      aria-busy={loadStage === 'loading'}
    >
      {/* The rule fires on this <img> because of `onDoubleClick` (and the onLoad/onError
          lifecycle handlers), not `onWheel`, which is in no jsx-a11y handler set. Keyboard
          pan is provided by the viewport-level Arrow key handler; this disable acknowledges
          only that the image legitimately carries pointer and lifecycle handlers. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <img
        key={requestKey}
        className={`ovl-lightbox__img${loadStage === 'decoded' ? ' ovl-lightbox__img--decoded' : ''}`}
        src={source}
        alt={photo.fileName}
        data-request-key={requestKey}
        data-orientation={photo.width >= photo.height ? 'landscape' : 'portrait'}
        draggable={false}
        style={{
          width: elementSize.width,
          height: elementSize.height,
          transform: imageTransform,
          ...(clipPath === undefined ? {} : { clipPath }),
        }}
        onLoad={onImageLoad}
        onError={() => setLoadStage('error')}
        onDoubleClick={toggleFill}
        onWheel={onWheel}
      />
      {cropMode ? (
        <CropOverlay box={cropBox} crop={cropDraft} onChange={setCropDraft} label={intl.formatMessage(messages.cropSurface)} />
      ) : null}
      {loadStage === 'loading' && showLoadingIndicator ? (
        <div className="ovl-lightbox__loading prose-note" role="status" aria-live="polite">
          <span className="ovl-lightbox__loading-spinner" aria-hidden="true" />
          {intl.formatMessage(messages.loading)}
        </div>
      ) : null}
      {loadStage === 'error' ? (
        <div className="ovl-lightbox__unavailable prose-note" role="status">
          {previewFailureLabel(intl, photo.previewFailure)}
        </div>
      ) : null}
      {showHint && chromeVisible ? (
        <div className="ovl-lightbox__gesture-hint prose-note" role="status">
          Double-click to fill · Option + scroll to zoom · scroll or arrows to pan
        </div>
      ) : null}
      {edit !== undefined && edit.unsupported !== null ? (
        <div className="ovl-lightbox__edit-status prose-note" role="status" data-testid="lightbox-edit-unsupported">
          {intl.formatMessage(messages.unsupported)}
        </div>
      ) : null}
      <div
        className={`ovl-lightbox__orientation ovl-lightbox__chrome${chromeClass}`}
        role="toolbar"
        aria-label="Image orientation controls"
        style={{ top: toolbarTop }}
      >
        <IconButton
          icon="refresh-cw"
          size="md"
          label={commandLabel('view.lightbox.orientationReset')}
          aria-keyshortcuts={ariaShortcut('view.lightbox.orientationReset')}
          onClick={resetOrientation}
        />
        <IconButton
          icon="flip-horizontal-2"
          size="md"
          label={commandLabel('view.lightbox.flipHorizontal')}
          aria-keyshortcuts={ariaShortcut('view.lightbox.flipHorizontal')}
          onClick={flipHorizontal}
        />
        <IconButton
          icon="flip-horizontal-2"
          size="md"
          className="ovl-lightbox__flip-vertical"
          label={commandLabel('view.lightbox.flipVertical')}
          aria-keyshortcuts={ariaShortcut('view.lightbox.flipVertical')}
          onClick={flipVertical}
        />
        <span className="ovl-lightbox__orientation-divider" role="separator" aria-orientation="vertical" />
        <IconButton
          icon="rotate-ccw"
          size="md"
          label={commandLabel('view.lightbox.rotateLeft')}
          aria-keyshortcuts={ariaShortcut('view.lightbox.rotateLeft')}
          onClick={() => rotateBy(-1)}
        />
        <IconButton
          icon="rotate-cw"
          size="md"
          label={commandLabel('view.lightbox.rotateRight')}
          aria-keyshortcuts={ariaShortcut('view.lightbox.rotateRight')}
          onClick={() => rotateBy(1)}
        />
      </div>
      <div
        className={`ovl-lightbox__zoom ovl-lightbox__chrome${chromeClass}`}
        role="toolbar"
        aria-label="Image zoom controls"
        style={{ top: toolbarTop }}
      >
        <IconButton icon="minus" size="sm" label="Zoom out (−)" onClick={() => zoomBy(1 / KEYBOARD_ZOOM_STEP)} />
        <Button
          className="ovl-lightbox__zoom-reset mono-data"
          variant="ghost"
          size="sm"
          aria-label={intl.formatMessage(messages.fitImage, { zoom: String(Math.round(transform.zoom * 100)) })}
          onClick={resetView}
        >
          {Math.round(transform.zoom * 100)}%
        </Button>
        <IconButton icon="plus" size="sm" label="Zoom in (+)" onClick={() => zoomBy(KEYBOARD_ZOOM_STEP)} />
      </div>
      {edit === undefined ? null : (
        <div
          className={`ovl-lightbox__edit ovl-lightbox__chrome${chromeClass}`}
          role="toolbar"
          aria-label={intl.formatMessage(messages.editToolbar)}
          data-testid="lightbox-edit-toolbar"
          style={{ top: toolbarTop }}
        >
          {cropMode ? (
            <>
              <Button size="sm" variant="primary" icon="check" data-testid="lightbox-crop-apply" onClick={() => leaveCropMode(true)}>
                {intl.formatMessage(messages.cropApply)}
              </Button>
              <Button size="sm" variant="ghost" icon="x" data-testid="lightbox-crop-cancel" onClick={() => leaveCropMode(false)}>
                {intl.formatMessage(messages.cropCancel)}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={cropDraft === null}
                data-testid="lightbox-crop-clear"
                onClick={() => setCropDraft(null)}
              >
                {intl.formatMessage(messages.cropClear)}
              </Button>
            </>
          ) : (
            <>
              <IconButton
                icon="crop"
                size="md"
                label={commandLabel('photo.edit.crop')}
                aria-keyshortcuts={ariaShortcut('photo.edit.crop')}
                data-testid="lightbox-edit-crop"
                disabled={!editable}
                onClick={enterCropMode}
              />
              <Button
                size="sm"
                variant={dirty ? 'primary' : 'ghost'}
                disabled={!dirty || !editable}
                aria-keyshortcuts={ariaShortcut('photo.edit.save')}
                data-testid="lightbox-edit-save"
                onClick={saveEdit}
              >
                {commandLabel('photo.edit.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!editable || (!dirty && isIdentityTransform(persisted))}
                data-testid="lightbox-edit-reset"
                onClick={resetEdits}
              >
                {commandLabel('photo.edit.reset')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!editable || !edit.canRevert}
                data-testid="lightbox-edit-revert"
                onClick={revertEdit}
              >
                {commandLabel('photo.edit.revert')}
              </Button>
              {dirty ? (
                <span className="ovl-lightbox__edit-dirty mono-data" role="status">
                  {intl.formatMessage(messages.unsaved)}
                </span>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
