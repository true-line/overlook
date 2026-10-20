import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import type { RestoreCoverage } from '../../../shared/backup/restore-contract.js';
import { useFormats } from '../i18n/use-formats.js';

const messages = defineMessages({
  excluded: {
    id: 'restore.library.excluded',
    defaultMessage:
      '{count, plural, one {# photo} other {# photos}} ({bytes}) deliberately not held by this backup; kept as placeholders when restored.',
  },
});

export function RestoreExclusionNotice({ coverage }: { readonly coverage: RestoreCoverage | null | undefined }): ReactElement | null {
  const intl = useIntl();
  const { formatBytes } = useFormats();
  if (coverage === null || coverage === undefined || coverage.excludedCount === 0) return null;
  return (
    <span className="ovl-restore__notice prose-note" data-testid="restore-excluded">
      {intl.formatMessage(messages.excluded, { count: coverage.excludedCount, bytes: formatBytes(coverage.excludedBytes) })}
    </span>
  );
}
