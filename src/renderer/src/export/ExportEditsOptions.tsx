import { useEffect, useRef, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { ExportPayloadMode } from '../../../shared/ipc/export-channels.js';
import { Checkbox } from '../components/Checkbox';
import { Icon } from '../components/Icon';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { Segmented } from '../components/Segmented';
import { Field } from '../settings/Field';
import type { ExportPreflightReport } from './use-export-preflight.js';

// Edits control (#497, ADR-0031 §6): one declared payload mode — Bake, Original
// + XMP, Original only — with the explicit quality for Bake and the preflight
// loss report. Export stays unavailable until the user confirms exporting
// without the named edits or picks another mode (#1307); Original only states
// what it omits.

const messages = defineMessages({
  label: { id: 'export.edits.label', defaultMessage: 'Edits' },
  bake: { id: 'export.edits.bake', defaultMessage: 'Bake' },
  originalXmp: { id: 'export.edits.originalXmp', defaultMessage: 'Original + XMP' },
  originalOnly: { id: 'export.edits.originalOnly', defaultMessage: 'Original only' },
  bakeHint: {
    id: 'export.edits.bakeHint',
    defaultMessage: 'Render the saved rotation, flip, and crop into a new JPEG. Embedded metadata is not carried over.',
  },
  originalXmpHint: {
    id: 'export.edits.originalXmpHint',
    defaultMessage: 'Write the byte-identical original beside an XMP sidecar that names the saved rotation, flip, and crop.',
  },
  originalOnlyHint: {
    id: 'export.edits.originalOnlyHint',
    defaultMessage: 'Write the byte-identical original and nothing beside it. Presentation edits and companion sidecars are omitted.',
  },
  quality: { id: 'export.edits.quality', defaultMessage: 'JPEG quality' },
  qualityBest: { id: 'export.edits.quality.best', defaultMessage: 'Best · 95' },
  qualityHigh: { id: 'export.edits.quality.high', defaultMessage: 'High · 90' },
  qualitySmall: { id: 'export.edits.quality.small', defaultMessage: 'Small · 80' },
  omitted: {
    id: 'export.edits.omitted',
    defaultMessage: '{count, plural, one {# photo has} other {# photos have}} presentation edits that will not be exported.',
  },
  losses: {
    id: 'export.edits.losses',
    defaultMessage: '{count, plural, one {# edit} other {# edits}} can’t travel in this mode:',
  },
  lossItem: { id: 'export.edits.lossItem', defaultMessage: '{fileName}: {reason}' },
  lossMore: { id: 'export.edits.lossMore', defaultMessage: 'and {count} more' },
  acknowledge: {
    id: 'export.edits.acknowledge',
    defaultMessage: 'Export without {count, plural, one {this edit} other {these # edits}}',
  },
  lossesAnnounce: {
    id: 'export.edits.lossesAnnounce',
    defaultMessage:
      '{count, plural, one {# edit} other {# edits}} can’t travel in this mode. Confirm to export without {count, plural, one {it} other {them}}, or choose another mode.',
  },
});

/** The loss list shows this many edits, then "and {n} more". */
const LOSSES_SHOWN = 5;

export const EXPORT_JPEG_QUALITIES = { best: 95, high: 90, small: 80 } as const;
export type ExportJpegQuality = keyof typeof EXPORT_JPEG_QUALITIES;

export interface ExportEditsOptionsProps {
  readonly mode: ExportPayloadMode;
  readonly onModeChange: (mode: ExportPayloadMode) => void;
  readonly quality: ExportJpegQuality;
  readonly onQualityChange: (quality: ExportJpegQuality) => void;
  readonly disabled: boolean;
  /** Null while the preflight is loading or not applicable. */
  readonly preflight: ExportPreflightReport | null;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (acknowledged: boolean) => void;
}

export function ExportEditsOptions({
  mode,
  onModeChange,
  quality,
  onQualityChange,
  disabled,
  preflight,
  acknowledged,
  onAcknowledge,
}: ExportEditsOptionsProps): ReactElement {
  const intl = useIntl();
  const losses = disabled ? [] : (preflight?.losses ?? []);
  const modeHint = disabled
    ? undefined
    : intl.formatMessage(
        mode === 'baked' ? messages.bakeHint : mode === 'original-sidecars' ? messages.originalXmpHint : messages.originalOnlyHint,
      );
  // Pass C Field rows (#1306): the label names each Segmented, and the mode's
  // hint describes it, so there's no wrapper group or second label.
  return (
    <>
      <Field
        label={intl.formatMessage(messages.label)}
        hint={modeHint === undefined ? undefined : <span data-testid="export-edits-hint">{modeHint}</span>}
        testId="export-edits-mode"
      >
        <Segmented
          value={disabled ? 'original' : mode}
          disabled={disabled}
          onChange={onModeChange}
          options={[
            { value: 'baked', label: intl.formatMessage(messages.bake) },
            { value: 'original-sidecars', label: intl.formatMessage(messages.originalXmp) },
            { value: 'original', label: intl.formatMessage(messages.originalOnly) },
          ]}
        />
      </Field>
      {disabled || mode !== 'baked' ? null : (
        <Field label={intl.formatMessage(messages.quality)} testId="export-edits-quality">
          <Segmented
            value={quality}
            onChange={onQualityChange}
            options={[
              { value: 'best', label: intl.formatMessage(messages.qualityBest) },
              { value: 'high', label: intl.formatMessage(messages.qualityHigh) },
              { value: 'small', label: intl.formatMessage(messages.qualitySmall) },
            ]}
          />
        </Field>
      )}
      {disabled || preflight === null || mode !== 'original' || preflight.edited === 0 ? null : (
        <div className="ovl-export__photosNotice prose-note" data-testid="export-edits-omitted">
          <Icon name="info" size={12} />
          {intl.formatMessage(messages.omitted, { count: preflight.edited })}
        </div>
      )}
      <LossReport losses={losses} acknowledged={acknowledged} onAcknowledge={onAcknowledge} />
    </>
  );
}

interface LossReportProps {
  readonly losses: ExportPreflightReport['losses'];
  readonly acknowledged: boolean;
  readonly onAcknowledge: (acknowledged: boolean) => void;
}

/** The edits this mode can't carry, and the checkbox that confirms exporting
 *  without them. Said once when the report appears and again when its count
 *  changes, politely: it's a consequence of a choice, not an error (#1307). */
function LossReport({ losses, acknowledged, onAcknowledge }: LossReportProps): ReactElement | null {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const announcedCountRef = useRef(0);
  useEffect(() => {
    if (losses.length === announcedCountRef.current) return;
    announcedCountRef.current = losses.length;
    if (losses.length > 0) announce(intl.formatMessage(messages.lossesAnnounce, { count: losses.length }), 'polite', 'export-edit-losses');
  }, [announce, intl, losses.length]);
  if (losses.length === 0) return null;
  return (
    <div className="ovl-export__losses" data-testid="export-edits-losses">
      <div className="ovl-export__lossHead prose-note">
        <Icon name="triangle-alert" size={14} />
        {intl.formatMessage(messages.losses, { count: losses.length })}
      </div>
      <ul className="ovl-export__lossList prose-note">
        {losses.slice(0, LOSSES_SHOWN).map((loss) => (
          <li key={loss.photoId}>{intl.formatMessage(messages.lossItem, { fileName: loss.fileName, reason: loss.reason })}</li>
        ))}
        {losses.length > LOSSES_SHOWN ? (
          <li className="ovl-export__lossMore">{intl.formatMessage(messages.lossMore, { count: losses.length - LOSSES_SHOWN })}</li>
        ) : null}
      </ul>
      <Checkbox
        checked={acknowledged}
        onChange={onAcknowledge}
        label={intl.formatMessage(messages.acknowledge, { count: losses.length })}
      />
    </div>
  );
}
