import type { ReactElement } from 'react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import './feedback.css';
import { Icon, type IconName, type IconSize } from './Icon';

export type SyncState = 'local' | 'synced' | 'syncing' | 'offloaded' | 'error' | 'excluded' | 'local-missing' | 'local-corrupt';

const messages = defineMessages({
  local: { id: 'statusGlyph.local', defaultMessage: 'Local only' },
  synced: { id: 'statusGlyph.synced', defaultMessage: 'Backed up (encrypted)' },
  syncing: { id: 'statusGlyph.syncing', defaultMessage: 'Uploading…' },
  offloaded: { id: 'statusGlyph.offloaded', defaultMessage: 'Offloaded to cloud' },
  error: { id: 'statusGlyph.error', defaultMessage: 'Sync failed' },
  excluded: { id: 'statusGlyph.excluded', defaultMessage: 'On this device only' },
  localMissing: { id: 'statusGlyph.localMissing', defaultMessage: 'Local original missing' },
  localCorrupt: { id: 'statusGlyph.localCorrupt', defaultMessage: 'Local original corrupt' },
});

// The design's STATES map (media/StatusGlyph.jsx) paired with catalog descriptors.
export const SYNC_STATES: Record<SyncState, { icon: IconName; color: string; label: string; message: MessageDescriptor }> = {
  local: { icon: 'hard-drive', color: 'var(--text-muted)', label: 'Local only', message: messages.local },
  synced: { icon: 'cloud-check', color: 'var(--accent-green)', label: 'Backed up (encrypted)', message: messages.synced },
  syncing: { icon: 'refresh-cw', color: 'var(--accent-amber)', label: 'Uploading…', message: messages.syncing },
  offloaded: { icon: 'cloud', color: 'var(--accent-amber)', label: 'Offloaded to cloud', message: messages.offloaded },
  error: { icon: 'cloud-alert', color: 'var(--accent-red)', label: 'Sync failed', message: messages.error },
  // Backup coverage (#506, ADR-0033): local-only by choice, distinct from
  // 'local' (not backed up yet) so the tile says so.
  excluded: { icon: 'hard-drive', color: 'var(--accent-amber)', label: 'On this device only', message: messages.excluded },
  'local-missing': { icon: 'hard-drive', color: 'var(--accent-red)', label: 'Local original missing', message: messages.localMissing },
  'local-corrupt': { icon: 'hard-drive', color: 'var(--accent-red)', label: 'Local original corrupt', message: messages.localCorrupt },
};

/** The glyph a record shows: coverage wins over the upload state, since an
 * excluded row's status is bookkeeping the user did not choose to see. */
export function glyphStateOf(photo: {
  readonly syncState: SyncState | 'local';
  readonly coverage: 'included' | 'excluding' | 'excluded';
  readonly localCustodyFailure?: 'local-missing' | 'local-corrupt' | null | undefined;
}): SyncState {
  if (photo.coverage === 'excluded' && photo.localCustodyFailure != null) return photo.localCustodyFailure;
  return photo.coverage === 'included' ? photo.syncState : 'excluded';
}

export interface StatusGlyphProps {
  readonly state: SyncState;
  /** Capsule diameter; the glyph renders at ~60% of it (20 → 12). 16 is the
   *  list-row size the design's ListRow.jsx uses (#77). */
  readonly size?: 16 | 18 | 20 | 22;
  readonly title?: string;
}

export function StatusGlyph({ state, size = 20, title }: StatusGlyphProps): ReactElement {
  const intl = useIntl();
  const s = SYNC_STATES[state];
  const resolvedLabel = title ?? intl.formatMessage(s.message);
  // Floors at 11, the smallest DS icon size (16 * 0.6 would be 10).
  const iconSize = Math.max(11, Math.round(size * 0.6)) as IconSize;
  return (
    <span
      role="img"
      aria-label={resolvedLabel}
      title={resolvedLabel}
      className={`ovl-status-glyph${state === 'syncing' ? ' ovl-status-glyph--syncing' : ''}`}
      style={{ width: size, height: size, color: s.color }}
    >
      <Icon name={s.icon} size={iconSize} strokeWidth={2} />
    </span>
  );
}
