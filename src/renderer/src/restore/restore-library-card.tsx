import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { RestoreLibrarySummary } from '../../../shared/backup/restore-contract.js';
import { useFormats } from '../i18n/use-formats.js';
import { RestoreExclusionNotice } from './RestoreExclusionNotice.js';
import { Badge } from '../components/Badge.js';
import { CopyableValue } from '../components/CopyableValue.js';
import { WORD_SEPARATOR } from '../components/word-separator.js';

const messages = defineMessages({
  copyLibraryId: { id: 'restore.copy.libraryId', defaultMessage: 'library ID' },
  selectLibrary: { id: 'restore.select.library', defaultMessage: 'Select library {libraryId}' },
});

export function RestoreLibraryCard({
  library,
  selected,
  onSelect,
}: {
  readonly library: RestoreLibrarySummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCount } = useFormats();
  const valid = library.validation === 'valid';
  const exclusionCoverage =
    valid && library.excludedCount !== null && library.excludedCount > 0 && library.excludedBytes !== null
      ? { excludedCount: library.excludedCount, excludedBytes: library.excludedBytes }
      : null;
  return (
    <div className={`ovl-restore__library${selected ? ' ovl-restore__library--selected' : ''}`} data-testid="restore-library-card">
      <div className="ovl-restore__libraryHead">
        <CopyableValue
          value={library.libraryId}
          label={intl.formatMessage(messages.copyLibraryId)}
          textClassName="ovl-restore__libraryId"
        />
        <Badge tone={valid ? 'green' : library.validation === 'unsupported' ? 'amber' : 'red'}>
          {valid ? 'Validated' : library.validation.replace('-', ' ')}
        </Badge>
      </div>
      {/* The name comes from the card's own content — the action label plus
          every visible line — so the visible words stay inside the accessible
          name (WCAG 2.5.3). The separators keep the lines apart: axe reads the
          visible text of a button by concatenating child text with no
          separator. */}
      <button type="button" className="ovl-restore__librarySelect" disabled={!valid} aria-pressed={selected} onClick={onSelect}>
        <span className="ovl-sr-only">{intl.formatMessage(messages.selectLibrary, { libraryId: library.libraryId })}</span>
        {WORD_SEPARATOR}
        {valid ? (
          <div className="ovl-restore__meta mono-data">
            Gen {String(library.generation)} · {formatCount(library.photos ?? 0)} photos · {formatBytes(library.totalBytes ?? 0)} ·{' '}
            {formatCount(library.albums ?? 0)} albums
          </div>
        ) : (
          <div className="ovl-restore__meta">Metadata is unavailable until this backup validates.</div>
        )}
        {WORD_SEPARATOR}
        <RestoreExclusionNotice coverage={exclusionCoverage} />
        {WORD_SEPARATOR}
        {library.generatedAt === null ? null : (
          <div className="ovl-restore__date">
            Backed up {intl.formatDate(library.generatedAt, { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
        )}
        {library.fallbackGenerations > 0 ? (
          <>
            {WORD_SEPARATOR}
            <div className="ovl-restore__notice">{formatCount(library.fallbackGenerations)} retained fallback generation available</div>
          </>
        ) : null}
        {library.resumable ? (
          <>
            {WORD_SEPARATOR}
            <div className="ovl-restore__notice">Verified staged work is ready to resume</div>
          </>
        ) : null}
      </button>
    </div>
  );
}
