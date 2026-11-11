import { defineMessages } from 'react-intl';
import type { IntlShape } from 'react-intl';

import type { PlacementAvailability } from '../../../shared/moodboard/availability.js';

// User-facing copy for the Moodboard view (#693). Overlook voice: calm,
// factual, sentence case, addresses "you", no scare words, no emoji. Strings
// the design spec fixes verbatim (empty state, placeholders) are reproduced
// exactly. Live-region announcements come from the shared, tested string
// builders, not from here.
export const moodboardMessages = defineMessages({
  canvasLabel: { id: 'moodboard.canvas.label', defaultMessage: 'Moodboard canvas — {title}' },
  readingOrder: { id: 'moodboard.readingOrder.label', defaultMessage: 'Placements in reading order' },
  emptyTitle: { id: 'moodboard.empty.title', defaultMessage: 'This board is empty' },
  emptyHint: { id: 'moodboard.empty.hint', defaultMessage: 'Add photos from the library or drag them here.' },
  badgeOffloaded: { id: 'moodboard.badge.offloaded', defaultMessage: 'Offloaded' },
  unavailable: { id: 'moodboard.placeholder.unavailable', defaultMessage: 'Original not available' },
  locked: { id: 'moodboard.placeholder.locked', defaultMessage: 'Locked — unlock the album to show this photo' },
  cropHint: { id: 'moodboard.crop.hint', defaultMessage: "Adjust the visible frame. The original isn't changed." },

  panelBoard: { id: 'moodboard.panel.board', defaultMessage: 'Board' },
  panelBackground: { id: 'moodboard.panel.background', defaultMessage: 'Background' },
  fieldTitle: { id: 'moodboard.panel.title', defaultMessage: 'Title' },
  fieldNotes: { id: 'moodboard.panel.notes', defaultMessage: 'Notes' },
  fieldSize: { id: 'moodboard.panel.size', defaultMessage: 'Size' },
  rowPlacements: { id: 'moodboard.panel.placements', defaultMessage: 'Placements' },
  rowSelected: { id: 'moodboard.panel.selected', defaultMessage: 'Selected' },
  bgInk: { id: 'moodboard.bg.ink', defaultMessage: 'Ink' },
  bgPaper: { id: 'moodboard.bg.paper', defaultMessage: 'Paper' },
  bgSepia: { id: 'moodboard.bg.sepia', defaultMessage: 'Sepia' },
  bgNavy: { id: 'moodboard.bg.navy', defaultMessage: 'Navy' },
  background: { id: 'moodboard.bg.select', defaultMessage: 'Background {name}' },

  toolbarLabel: { id: 'moodboard.toolbar.label', defaultMessage: 'Board tools' },
  add: { id: 'moodboard.tool.add', defaultMessage: 'Add photos' },
  align: { id: 'moodboard.tool.align', defaultMessage: 'Align and distribute' },
  group: { id: 'moodboard.tool.group', defaultMessage: 'Group' },
  ungroup: { id: 'moodboard.tool.ungroup', defaultMessage: 'Ungroup' },
  bringForward: { id: 'moodboard.tool.bringForward', defaultMessage: 'Bring forward' },
  sendBack: { id: 'moodboard.tool.sendBack', defaultMessage: 'Send back' },
  crop: { id: 'moodboard.tool.crop', defaultMessage: 'Crop frame' },
  zoomOut: { id: 'moodboard.tool.zoomOut', defaultMessage: 'Zoom out' },
  zoomIn: { id: 'moodboard.tool.zoomIn', defaultMessage: 'Zoom in' },
  fit: { id: 'moodboard.tool.fit', defaultMessage: 'Fit board' },
  exportBoard: { id: 'moodboard.tool.export', defaultMessage: 'Export board' },

  alignLeft: { id: 'moodboard.align.left', defaultMessage: 'Align left' },
  alignCenter: { id: 'moodboard.align.center', defaultMessage: 'Align center' },
  alignRight: { id: 'moodboard.align.right', defaultMessage: 'Align right' },
  alignTop: { id: 'moodboard.align.top', defaultMessage: 'Align top' },
  alignMiddle: { id: 'moodboard.align.middle', defaultMessage: 'Align middle' },
  alignBottom: { id: 'moodboard.align.bottom', defaultMessage: 'Align bottom' },
  distributeH: { id: 'moodboard.distribute.horizontal', defaultMessage: 'Distribute horizontally' },
  distributeV: { id: 'moodboard.distribute.vertical', defaultMessage: 'Distribute vertically' },
});

/** The status a placement shows for its content availability — the badge for
 * an offloaded photo, the placeholder for an unavailable or locked one, and
 * nothing for a placement that renders its own pixels.
 *
 * The placement's accessible name carries the same words as the status it
 * renders, so WCAG 2.5.3 (label in name) holds: the visible words are part of
 * the accessible name. Both sides read this one mapping, so they cannot drift. */
export function moodboardStatusText(intl: IntlShape, availability: PlacementAvailability): string | null {
  if (availability === 'locked') return intl.formatMessage(moodboardMessages.locked);
  if (availability === 'unavailable') return intl.formatMessage(moodboardMessages.unavailable);
  if (availability === 'offloaded') return intl.formatMessage(moodboardMessages.badgeOffloaded);
  return null;
}
