import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';

import './move-library.css';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';

const messages = defineMessages({
  corrupt: {
    id: 'libmove.banner.corrupt',
    defaultMessage: 'A library move journal is damaged. Nothing was changed — both locations are untouched.',
  },
  pending: {
    id: 'libmove.banner.pending',
    defaultMessage: 'A finished library move still has its original in place. Both copies are verified — finishing removes the original.',
  },
  interrupted: {
    id: 'libmove.banner.interrupted',
    defaultMessage: 'A library move was interrupted. Discard the staged copy, or resume after its existing files are verified.',
  },
  notResumable: {
    id: 'libmove.banner.notResumable',
    defaultMessage: 'The staged copy cannot be verified for resume. The original library is still authoritative.',
  },
  resume: { id: 'libmove.banner.resume', defaultMessage: 'Resume' },
  discard: { id: 'libmove.banner.discard', defaultMessage: 'Discard staged copy' },
  actionFailed: { id: 'libmove.banner.actionFailed', defaultMessage: 'The recovery action could not be completed.' },
  finishCleanup: { id: 'libmove.banner.finishCleanup', defaultMessage: 'Finish cleanup' },
  dismiss: { id: 'libmove.banner.dismiss', defaultMessage: 'Dismiss' },
  paths: { id: 'libmove.banner.paths', defaultMessage: '{from} → {to}' },
});

// Relocation resume banner (#559, ADR-0022 §2). Pre-commit copy staging stays
// inert until the user explicitly resumes or discards it. Committed cleanup
// and corrupt journals remain visible here too.

type PendingMove = Awaited<ReturnType<typeof window.overlook.libraries.pendingMoves>>['pending'][number];

export function MoveResumeBanner(): ReactElement | null {
  const intl = useIntl();
  const [pending, setPending] = useState<readonly PendingMove[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ readonly libraryId: string; readonly detail: string } | null>(null);

  useEffect(() => {
    void window.overlook.libraries
      .pendingMoves()
      .then(({ pending: entries }) => setPending(entries.filter((entry) => entry.corrupt || entry.state !== 'cleaned')))
      .catch(() => undefined);
  }, []);

  if (dismissed || pending.length === 0) return null;

  const finishCleanup = (entry: PendingMove): void => {
    setBusyId(entry.libraryId);
    setFailure(null);
    void window.overlook.libraries
      .finishMoveCleanup({ id: entry.libraryId })
      .then(() => setPending((previous) => previous.filter((candidate) => candidate.libraryId !== entry.libraryId)))
      .catch(() => setFailure({ libraryId: entry.libraryId, detail: intl.formatMessage(messages.actionFailed) }))
      .finally(() => setBusyId(null));
  };

  const resume = (entry: PendingMove): void => {
    setBusyId(entry.libraryId);
    setFailure(null);
    void window.overlook.libraries
      .resumeMove({ id: entry.libraryId })
      .then((result) => {
        if (result.ok) {
          setPending((previous) => previous.filter((candidate) => candidate.libraryId !== entry.libraryId));
        } else {
          setFailure({ libraryId: entry.libraryId, detail: result.detail });
        }
      })
      .catch(() => setFailure({ libraryId: entry.libraryId, detail: intl.formatMessage(messages.actionFailed) }))
      .finally(() => setBusyId(null));
  };

  const discard = (entry: PendingMove): void => {
    setBusyId(entry.libraryId);
    setFailure(null);
    void window.overlook.libraries
      .discardMove({ id: entry.libraryId })
      .then(() => setPending((previous) => previous.filter((candidate) => candidate.libraryId !== entry.libraryId)))
      .catch(() => setFailure({ libraryId: entry.libraryId, detail: intl.formatMessage(messages.actionFailed) }))
      .finally(() => setBusyId(null));
  };

  return (
    <div className="ovl-movebanner" role="status" data-testid="move-resume-banner">
      {pending.map((entry) => (
        <div key={entry.libraryId} className="ovl-movebanner__row">
          <Icon name={entry.corrupt ? 'triangle-alert' : 'hard-drive'} size={16} color="var(--accent-amber)" />
          {entry.corrupt ? (
            <span className="ovl-movebanner__copy">
              <FormattedMessage {...messages.corrupt} />
            </span>
          ) : entry.state === 'committed' ? (
            <>
              <span className="ovl-movebanner__copy">
                <FormattedMessage {...messages.pending} />
                <span className="mono-data ovl-movebanner__paths">
                  <FormattedMessage {...messages.paths} values={{ from: entry.sourcePath, to: entry.destPath }} />
                </span>
                {failure?.libraryId === entry.libraryId ? (
                  <span className="prose-note ovl-libmove__error-detail">{failure.detail}</span>
                ) : null}
              </span>
              <Button size="sm" disabled={busyId !== null} onClick={() => finishCleanup(entry)} data-testid="move-banner-cleanup">
                <FormattedMessage {...messages.finishCleanup} />
              </Button>
            </>
          ) : (
            <>
              <span className="ovl-movebanner__copy">
                <FormattedMessage {...(entry.resumable ? messages.interrupted : messages.notResumable)} />
                <span className="mono-data ovl-movebanner__paths">
                  <FormattedMessage {...messages.paths} values={{ from: entry.sourcePath, to: entry.destPath }} />
                </span>
                {failure?.libraryId === entry.libraryId ? (
                  <span className="prose-note ovl-libmove__error-detail">{failure.detail}</span>
                ) : null}
              </span>
              <span className="ovl-movebanner__actions">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busyId !== null}
                  onClick={() => discard(entry)}
                  data-testid="move-banner-discard"
                >
                  <FormattedMessage {...messages.discard} />
                </Button>
                {entry.resumable ? (
                  <Button size="sm" disabled={busyId !== null} onClick={() => resume(entry)} data-testid="move-banner-resume">
                    <FormattedMessage {...messages.resume} />
                  </Button>
                ) : null}
              </span>
            </>
          )}
        </div>
      ))}
      <IconButton icon="x" label={intl.formatMessage(messages.dismiss)} size="sm" onClick={() => setDismissed(true)} />
    </div>
  );
}
