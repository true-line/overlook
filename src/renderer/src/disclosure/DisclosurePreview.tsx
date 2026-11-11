import { useEffect, useId, useRef, type ReactElement } from 'react';
import { useIntl } from 'react-intl';

import { Badge } from '../components/Badge';
import { Checkbox } from '../components/Checkbox';
import { Icon, type IconName } from '../components/Icon';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { Segmented } from '../components/Segmented';
import { Field } from '../settings/Field';
import type { DisclosureClass, DisclosureDestination, DisclosureField } from '../../../shared/disclosure/policy.js';
import type { DisclosurePreview as DisclosurePreviewData } from '../../../shared/ipc/disclosure-channels.js';
import { classLabel, disclosureMessages, fieldLabel } from './disclosure-messages.js';

import './disclosure.css';

// The exact preview ADR-0032 §6 requires before a crossing (#509): which
// fields, which values, which destination, and what changes on decline. The
// data comes from main's plan; this component only renders it and collects
// the operation-scope intent (named recipient or public destination, per-field
// widening) that
// main recompiles the plan from.

export interface DisclosurePreviewProps {
  readonly preview: DisclosurePreviewData | null;
  readonly destination: DisclosureDestination;
  readonly onDestinationChange: (destination: DisclosureDestination) => void;
  readonly widen: readonly DisclosureField[];
  readonly onWidenChange: (widen: readonly DisclosureField[]) => void;
  readonly disabled?: boolean | undefined;
}

// Class badges are neutral (Pass E, #1308): Private is the safe default, not a
// caution, and Public is a choice, not an error. The icon carries the class;
// Mixed has none.
const CLASS_ICONS: Readonly<Record<DisclosureClass | 'mixed', IconName | undefined>> = {
  private: 'lock',
  shared: 'users',
  public: 'globe',
  mixed: undefined,
};

/** Says the blocked notice once when it appears and again when the withheld
 *  set changes: politely, since it asks for a choice rather than reporting an
 *  error (#1308). */
function useBlockedAnnouncement(blocked: readonly DisclosureField[]): void {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const announcedRef = useRef('');
  const count = blocked.length;
  const fields = intl.formatList(
    blocked.map((field) => fieldLabel(intl, field)),
    { type: 'conjunction' },
  );
  useEffect(() => {
    if (fields === announcedRef.current) return;
    announcedRef.current = fields;
    if (count > 0)
      announce(intl.formatMessage(disclosureMessages.previewBlockedAnnounce, { count, fields }), 'polite', 'disclosure-blocked');
  }, [announce, count, fields, intl]);
}

export function DisclosurePreview({
  preview,
  destination,
  onDestinationChange,
  widen,
  onWidenChange,
  disabled = false,
}: DisclosurePreviewProps): ReactElement {
  const intl = useIntl();
  const headingId = useId();
  const rows = preview?.fields.filter((field) => field.present > 0) ?? [];
  useBlockedAnnouncement(preview?.blocked ?? []);
  return (
    <section className="ovl-disclosure ovl-disclosure--preview" data-testid="disclosure-preview" aria-labelledby={headingId}>
      <div className="ovl-disclosure__head">
        <h4 id={headingId} className="ovl-disclosure__title">
          {intl.formatMessage(disclosureMessages.previewHeading)}
        </h4>
      </div>
      <DestinationField destination={destination} onChange={onDestinationChange} disabled={disabled} />
      {preview === null ? (
        <p className="ovl-disclosure__hint ovl-disclosure__hint--faint prose-note" data-testid="disclosure-preview-loading">
          {intl.formatMessage(disclosureMessages.previewLoading)}
        </p>
      ) : rows.length === 0 ? (
        <p className="ovl-disclosure__hint ovl-disclosure__hint--faint prose-note" data-testid="disclosure-preview-empty">
          {intl.formatMessage(disclosureMessages.previewNothing)}
        </p>
      ) : (
        <ul className="ovl-disclosure__rows">
          {rows.map((row) => (
            <li
              key={row.field}
              className={`ovl-disclosure__row${row.disclosed === 0 ? ' ovl-disclosure__row--withheld' : ''}`}
              data-testid={`disclosure-row-${row.field}`}
              data-disclosed={row.disclosed}
            >
              <span className="ovl-disclosure__field">
                {fieldLabel(intl, row.field)}
                <Badge tone="neutral" icon={CLASS_ICONS[row.class]} data-class={row.class}>
                  {classLabel(intl, row.class)}
                </Badge>
              </span>
              <span className="ovl-disclosure__count prose-note">
                {row.disclosed === 0
                  ? intl.formatMessage(disclosureMessages.previewWithheld)
                  : intl.formatMessage(disclosureMessages.previewCrosses, { disclosed: row.disclosed, present: row.present })}
              </span>
              {row.sample !== null && row.disclosed > 0 ? <span className="ovl-disclosure__sample mono-data">{row.sample}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {preview !== null && preview.embedded.length > 0 ? (
        <p className="ovl-disclosure__note prose-note" data-testid="disclosure-embedded">
          {intl.formatMessage(disclosureMessages.previewEmbedded, {
            fields: preview.embedded.map((field) => fieldLabel(intl, field)).join(', '),
          })}
        </p>
      ) : null}
      {preview !== null && preview.blocked.length > 0 ? (
        <div className="ovl-disclosure__blocked prose-note" data-testid="disclosure-blocked">
          <Icon name="triangle-alert" size={14} />
          {intl.formatMessage(disclosureMessages.previewBlocked)}
        </div>
      ) : null}
      {preview === null ? null : (
        <WidenChoices fields={[...new Set([...preview.blocked, ...widen])]} widen={widen} onChange={onWidenChange} disabled={disabled} />
      )}
      {preview !== null && preview.retainedSidecars > 0 ? (
        <p className="ovl-disclosure__note prose-note" data-testid="disclosure-sidecars">
          {intl.formatMessage(disclosureMessages.previewSidecars, { count: preview.retainedSidecars })}
        </p>
      ) : null}
      <p className="ovl-disclosure__hint ovl-disclosure__hint--faint prose-note">{intl.formatMessage(disclosureMessages.previewDecline)}</p>
    </section>
  );
}

interface DestinationFieldProps {
  readonly destination: DisclosureDestination;
  readonly onChange: (destination: DisclosureDestination) => void;
  readonly disabled: boolean;
}

/** Named recipient (Shared and Public fields cross) or Public (only Public
 *  fields cross), each with its own hint (Pass E, #1308). */
function DestinationField({ destination, onChange, disabled }: DestinationFieldProps): ReactElement {
  const intl = useIntl();
  return (
    <Field
      label={intl.formatMessage(disclosureMessages.previewDestination)}
      hint={intl.formatMessage(
        destination === 'public' ? disclosureMessages.previewDestinationPublicHint : disclosureMessages.previewDestinationSharedHint,
      )}
      testId="disclosure-destination"
    >
      <Segmented<DisclosureDestination>
        value={destination}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: 'shared', label: intl.formatMessage(disclosureMessages.previewDestinationShared) },
          { value: 'public', label: intl.formatMessage(disclosureMessages.previewDestinationPublic) },
        ]}
      />
    </Field>
  );
}

interface WidenChoicesProps {
  readonly fields: readonly DisclosureField[];
  readonly widen: readonly DisclosureField[];
  readonly onChange: (widen: readonly DisclosureField[]) => void;
  readonly disabled: boolean;
}

/** One checkbox per withheld field the user may include in this export. */
function WidenChoices({ fields, widen, onChange, disabled }: WidenChoicesProps): ReactElement {
  const intl = useIntl();
  return (
    <>
      {fields.map((field) => (
        <div key={field} className="ovl-disclosure__widen" data-testid={`disclosure-widen-${field}`}>
          <Checkbox
            disabled={disabled}
            checked={widen.includes(field)}
            onChange={(checked) => {
              onChange(checked ? [...widen, field] : widen.filter((entry) => entry !== field));
            }}
            label={intl.formatMessage(disclosureMessages.previewWiden, { field: fieldLabel(intl, field) })}
          />
        </div>
      ))}
    </>
  );
}
