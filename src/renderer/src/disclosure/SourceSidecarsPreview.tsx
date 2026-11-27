import type { ReactElement } from 'react';
import { useIntl } from 'react-intl';

import type { SourceSidecarFinding } from '../../../shared/disclosure/source-sidecars.js';
import { disclosureMessages, fieldLabel } from './disclosure-messages.js';

export function SourceSidecarsPreview({ sidecars }: { readonly sidecars: readonly SourceSidecarFinding[] }): ReactElement | null {
  const intl = useIntl();
  if (sidecars.length === 0) return null;
  const fieldList = (fields: SourceSidecarFinding['blocked']): string => intl.formatList(fields.map((field) => fieldLabel(intl, field)));
  return (
    <div data-testid="disclosure-sidecars">
      <p className="ovl-disclosure__note prose-note">
        {intl.formatMessage(disclosureMessages.previewSidecars, { count: sidecars.length })}
      </p>
      <ul className="ovl-disclosure__rows">
        {sidecars.map((sidecar, index) => (
          <li key={`${sidecar.photoId}:${String(index)}`} className="ovl-disclosure__note prose-note" data-status={sidecar.status}>
            <div className="mono-data">{sidecar.fileName}</div>
            <p className="prose-note">
              {sidecar.status === 'inspected'
                ? intl.formatMessage(sidecar.fields.length === 0 ? disclosureMessages.sidecarEmpty : disclosureMessages.sidecarFound, {
                    fields: fieldList(sidecar.fields.map(({ field }) => field)),
                  })
                : intl.formatMessage(
                    sidecar.reason === 'budget'
                      ? disclosureMessages.sidecarBudget
                      : sidecar.status === 'unknown'
                        ? disclosureMessages.sidecarUnknown
                        : sidecar.status === 'unsupported'
                          ? disclosureMessages.sidecarUnsupported
                          : sidecar.status === 'malformed'
                            ? disclosureMessages.sidecarMalformed
                            : disclosureMessages.sidecarUnavailable,
                    { properties: intl.formatList(sidecar.unclassified ?? []) },
                  )}
            </p>
            {sidecar.blocked.length === 0 ? null : (
              <p className="prose-note">{intl.formatMessage(disclosureMessages.sidecarWithheld, { fields: fieldList(sidecar.blocked) })}</p>
            )}
            {sidecar.fields
              .filter(({ field }) => !sidecar.blocked.includes(field))
              .map(({ field, values }) => (
                <div key={field} className="mono-data">
                  {values.join('; ')}
                </div>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
