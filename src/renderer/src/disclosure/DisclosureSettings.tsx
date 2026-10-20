import { useEffect, useState, type ReactElement } from 'react';
import { useIntl } from 'react-intl';

import { Segmented } from '../components/Segmented';
import {
  DEFAULT_DISCLOSURE_POLICY,
  DISCLOSURE_FIELDS,
  PINNED_PRIVATE,
  type DisclosureClass,
  type DisclosureField,
  type DisclosurePolicy,
} from '../../../shared/disclosure/policy.js';
import { classLabel, disclosureMessages, fieldLabel } from './disclosure-messages.js';

import './disclosure.css';

// Settings ▸ Privacy ▸ Disclosure (#509, ADR-0032 §6): the library-scope
// class of every classifiable field, and the pinned-private set the user
// cannot change. Library data, not a profile setting — read and written
// through its own channel; main records each change in activity history by
// field name and class.

export function DisclosureSettings(): ReactElement {
  const intl = useIntl();
  const [policy, setPolicy] = useState<DisclosurePolicy | null>(null);
  const [pinned, setPinned] = useState<readonly string[]>(PINNED_PRIVATE);
  useEffect(() => {
    let live = true;
    void window.overlook.disclosure
      .policy()
      .then(({ policy: loaded, pinned: loadedPinned }) => {
        if (!live) return;
        setPolicy(loaded);
        setPinned(loadedPinned);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const current = policy ?? DEFAULT_DISCLOSURE_POLICY;
  const setField = (field: DisclosureField, cls: DisclosureClass): void => {
    setPolicy({ ...current, fields: { ...current.fields, [field]: cls } });
    void window.overlook.disclosure
      .setField({ field, class: cls })
      .then(({ policy: stored }) => {
        setPolicy(stored);
      })
      .catch(() => undefined);
  };
  const options = (['private', 'shared', 'public'] as const).map((cls) => ({ value: cls, label: classLabel(intl, cls) }));
  return (
    <section className="ovl-disclosure" data-testid="disclosure-settings" aria-labelledby="disclosure-heading">
      <div className="ovl-disclosure__head">
        <h3 id="disclosure-heading" className="ovl-disclosure__title">
          {intl.formatMessage(disclosureMessages.heading)}
        </h3>
        <p className="ovl-disclosure__hint prose-note">{intl.formatMessage(disclosureMessages.hint)}</p>
      </div>
      <ul className="ovl-disclosure__rows">
        {DISCLOSURE_FIELDS.map((field) => (
          <li key={field} className="ovl-disclosure__row" data-testid={`disclosure-field-${field}`} data-class={current.fields[field]}>
            <span className="ovl-disclosure__field">{fieldLabel(intl, field)}</span>
            <Segmented
              label={intl.formatMessage(disclosureMessages.classFor, { field: fieldLabel(intl, field) })}
              value={current.fields[field]}
              disabled={policy === null}
              options={options}
              onChange={(next) => {
                setField(field, next);
              }}
            />
          </li>
        ))}
      </ul>
      <div className="ovl-disclosure__pinned" data-testid="disclosure-pinned">
        <div className="ovl-disclosure__pinnedTitle">{intl.formatMessage(disclosureMessages.pinned)}</div>
        <div className="ovl-disclosure__hint prose-note">{intl.formatMessage(disclosureMessages.pinnedHint)}</div>
        <ul className="ovl-disclosure__pinnedList">
          {pinned.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
