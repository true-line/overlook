import type { ReactElement, PointerEvent as ReactPointerEvent } from 'react';
import { useIntl } from 'react-intl';

import type { Placement } from '../../../shared/moodboard/board.js';
import { canRenderPixels } from '../../../shared/moodboard/availability.js';
import { Icon } from '../components/Icon';
import { moodboardStatusText } from './messages';
import type { PlacementView } from './board-seed';

// One placement on the canvas (#693). A real focusable button so keyboard focus
// lands on placements (never <body>) and the accessible name carries the
// photo + layer position. Handles are drawn by the canvas, not here, and are
// not separate tab stops. Locked content never renders pixels (invariant I6).
export interface MoodboardPlacementProps {
  readonly placement: Placement;
  readonly view: PlacementView;
  readonly label: string;
  readonly selected: boolean;
  readonly onPointerDown: (event: ReactPointerEvent, placementId: string) => void;
  readonly onActivate: (placementId: string, additive: boolean) => void;
  readonly onFocus: (placementId: string) => void;
}

export function MoodboardPlacement({
  placement,
  view,
  label,
  selected,
  onPointerDown,
  onActivate,
  onFocus,
}: MoodboardPlacementProps): ReactElement {
  const intl = useIntl();
  const { availability } = view;
  const showPixels = canRenderPixels(availability) && view.thumbSrc !== null;

  // The placeholder text and the badge are the placement's visible words, so
  // the accessible name carries the same string (see moodboardStatusText).
  const statusText = moodboardStatusText(intl, availability);
  const placeholderText = availability === 'offloaded' ? null : statusText;

  return (
    <button
      type="button"
      className="ovl-moodboard__piece"
      data-selected={selected}
      data-availability={availability}
      data-testid={`moodboard-piece-${placement.id}`}
      aria-label={label}
      aria-pressed={selected}
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.w,
        height: placement.h,
        zIndex: placement.z,
        transform: placement.rotation === 0 ? undefined : `rotate(${placement.rotation}deg)`,
        transformOrigin: 'center',
      }}
      onPointerDown={(event) => onPointerDown(event, placement.id)}
      onClick={(event) => {
        // detail === 0 marks keyboard activation (Enter/Space); mouse selection
        // is already handled on pointer-down for drag. Keeps selection ≠ focus.
        if (event.detail === 0) onActivate(placement.id, event.shiftKey || event.metaKey || event.ctrlKey);
      }}
      onFocus={() => onFocus(placement.id)}
    >
      {showPixels && view.thumbSrc !== null ? (
        <img src={view.thumbSrc} alt="" draggable={false} />
      ) : (
        <span className="ovl-moodboard__placeholder">
          <Icon name={availability === 'locked' ? 'lock' : 'image-off'} size={20} />
          {placeholderText === null ? null : <span>{placeholderText}</span>}
        </span>
      )}
      {availability === 'offloaded' ? (
        <span className="ovl-moodboard__badge">
          <Icon name="cloud" size={11} color="currentColor" />
          {statusText}
        </span>
      ) : null}
    </button>
  );
}
