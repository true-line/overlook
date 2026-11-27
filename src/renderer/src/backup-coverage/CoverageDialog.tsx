import { useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import { destructiveActions, REMOVE_CLOUD_COPY_AUTHORIZATION } from '../../../shared/destructive-actions.js';
import { useFormats } from '../i18n/use-formats.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';

import './coverage.css';

type Preflight = Awaited<ReturnType<OverlookApi['coverage']['preflight']>>;
type ExcludeResult = Awaited<ReturnType<OverlookApi['coverage']['exclude']>>;
type SkipReason = NonNullable<Preflight['items'][number]['reason']>;

// "Keep on this device only" (#506, ADR-0033 §7): preflight, then act. The
// ceremony escalates to ADR-0023 Tier D — an exact count, bytes, provider and
// account, and the shared-bytes exception — whenever a provider copy would be
// removed; without one it is the structural Tier M statement that nothing is
// destroyed. The confirm label is the registry's verb, never a softer one.

const messages = defineMessages({
  titleKeep: { id: 'coverage.dialog.title.keep', defaultMessage: 'Keep on this device only' },
  titleRemove: { id: 'coverage.dialog.title.remove', defaultMessage: 'Remove the cloud copy?' },
  loading: { id: 'coverage.dialog.loading', defaultMessage: 'Checking cloud copies…' },
  reasonRow: { id: 'coverage.dialog.reasonRow', defaultMessage: '{count} · {reason}' },
  summary: {
    id: 'coverage.dialog.summary',
    defaultMessage:
      '{count, plural, one {# photo} other {# photos}} ({bytes}) will stay in the library on this device and stop being backed up automatically.',
  },
  remote: {
    id: 'coverage.dialog.remote',
    defaultMessage: '{count, plural, one {# encrypted copy} other {# encrypted copies}} ({bytes}) will be removed from {provider}.',
  },
  remoteAccount: {
    id: 'coverage.dialog.remote.account',
    defaultMessage:
      '{count, plural, one {# encrypted copy} other {# encrypted copies}} ({bytes}) will be removed from {provider} ({account}).',
  },
  downloads: {
    id: 'coverage.dialog.downloads',
    defaultMessage:
      '{count, plural, one {# cloud-only original is} other {# cloud-only originals are}} downloaded and verified on this device first.',
  },
  shared: {
    id: 'coverage.dialog.shared',
    defaultMessage:
      '{count, plural, one {# copy stays} other {# copies stay}} in the cloud because another backed-up photo uses the same original.',
  },
  skips: { id: 'coverage.dialog.skips', defaultMessage: '{count, plural, one {# will be skipped} other {# will be skipped}}' },
  reasonNotFound: { id: 'coverage.reason.notFound', defaultMessage: 'no longer in the library' },
  reasonDeleted: { id: 'coverage.reason.deleted', defaultMessage: 'in Trash' },
  reasonAlreadyExcluded: { id: 'coverage.reason.alreadyExcluded', defaultMessage: 'already on this device only' },
  reasonAlreadyIncluded: { id: 'coverage.reason.alreadyIncluded', defaultMessage: 'already backed up automatically' },
  reasonInFlight: { id: 'coverage.reason.inFlight', defaultMessage: 'uploading right now' },
  reasonDisconnected: { id: 'coverage.reason.disconnected', defaultMessage: 'cloud copy exists but the provider is not connected' },
  reasonRestoreFailed: { id: 'coverage.reason.restoreFailed', defaultMessage: 'the cloud-only original could not be downloaded' },
  reasonLocalMissing: { id: 'coverage.reason.localMissing', defaultMessage: 'no original on this device' },
  reasonLocalCorrupt: { id: 'coverage.reason.localCorrupt', defaultMessage: 'the local original failed verification' },
  cancel: { id: 'coverage.dialog.cancel', defaultMessage: 'Cancel' },
  confirmKeep: { id: 'coverage.dialog.confirm.keep', defaultMessage: 'Keep on this device only' },
  confirmRemove: { id: 'coverage.dialog.confirm.remove', defaultMessage: 'Remove cloud copy permanently' },
  running: { id: 'coverage.dialog.running', defaultMessage: 'Working…' },
  preflightError: { id: 'coverage.dialog.error.preflight', defaultMessage: 'Could not check the cloud copies. Try again.' },
  actionError: {
    id: 'coverage.dialog.error.action',
    defaultMessage: 'Nothing changed. Your photos are still backed up as before.',
  },
});

const REASON_MESSAGES = {
  'not-found': 'reasonNotFound',
  deleted: 'reasonDeleted',
  'already-excluded': 'reasonAlreadyExcluded',
  'already-included': 'reasonAlreadyIncluded',
  'in-flight': 'reasonInFlight',
  'provider-disconnected': 'reasonDisconnected',
  'restore-failed': 'reasonRestoreFailed',
  'local-missing': 'reasonLocalMissing',
  'local-corrupt': 'reasonLocalCorrupt',
} as const satisfies Record<SkipReason, keyof typeof messages>;

export interface CoverageDialogProps {
  readonly photoIds: readonly string[];
  readonly onClose: () => void;
  readonly onComplete: (result: ExcludeResult) => void;
}

export function CoverageDialog({ photoIds, onClose, onComplete }: CoverageDialogProps): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCount } = useFormats();
  const [plan, setPlan] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let active = true;
    void window.overlook.coverage
      .preflight({ photoIds: [...photoIds] })
      .then((loaded) => {
        if (active) setPlan(loaded);
      })
      .catch(() => {
        if (active) setError(intl.formatMessage(messages.preflightError));
      });
    return () => {
      active = false;
    };
  }, [intl, photoIds]);

  const reasons = new Map<SkipReason, number>();
  for (const item of plan?.items ?? []) {
    if (item.reason !== null) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
  }
  const irreversible = plan?.tier === 'irreversible';
  const safety = irreversible ? destructiveActions.removeCloudCopy.sideEffects : destructiveActions.keepOnThisDeviceOnly.survival;
  const confirmLabel = intl.formatMessage(irreversible ? messages.confirmRemove : messages.confirmKeep);

  return (
    <Dialog
      open
      title={intl.formatMessage(irreversible ? messages.titleRemove : messages.titleKeep)}
      icon={irreversible ? 'cloud-off' : 'hard-drive'}
      {...(running ? {} : { onClose })}
      footer={
        <>
          <Button variant="secondary" disabled={running} onClick={onClose}>
            {intl.formatMessage(messages.cancel)}
          </Button>
          <Button
            variant={irreversible ? 'danger' : 'primary'}
            icon={irreversible ? 'cloud-off' : 'hard-drive'}
            disabled={plan === null || plan.eligible === 0 || running}
            onClick={() => {
              setRunning(true);
              setError(null);
              void window.overlook.coverage
                .exclude({ photoIds: [...photoIds], ...(irreversible ? { authorization: REMOVE_CLOUD_COPY_AUTHORIZATION } : {}) })
                .then(onComplete)
                .catch(() => {
                  setRunning(false);
                  setError(intl.formatMessage(messages.actionError));
                });
            }}
          >
            {running ? intl.formatMessage(messages.running) : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="ovl-coverage" aria-live="polite">
        {plan === null && error === null ? (
          <div className="ovl-coverage__loading prose-note">{intl.formatMessage(messages.loading)}</div>
        ) : null}
        {plan === null ? null : (
          <>
            <div className="ovl-coverage__summary">
              {intl.formatMessage(messages.summary, { count: plan.eligible, bytes: formatBytes(plan.bytes) })}
            </div>
            {plan.remoteCopies > 0 ? (
              <div className="ovl-coverage__remote" data-testid="coverage-remote">
                {intl.formatMessage(plan.account === null ? messages.remote : messages.remoteAccount, {
                  count: plan.remoteCopies,
                  bytes: formatBytes(plan.remoteBytes),
                  provider: plan.provider ?? '',
                  account: plan.account ?? '',
                })}
              </div>
            ) : null}
            {plan.downloads > 0 ? (
              <div className="ovl-coverage__line">{intl.formatMessage(messages.downloads, { count: plan.downloads })}</div>
            ) : null}
            {plan.sharedRetained > 0 ? (
              <div className="ovl-coverage__line">{intl.formatMessage(messages.shared, { count: plan.sharedRetained })}</div>
            ) : null}
            <div className="ovl-coverage__safety">{safety}</div>
            {reasons.size === 0 ? null : (
              <div className="ovl-coverage__skips">
                <div className="prose-note">{intl.formatMessage(messages.skips, { count: plan.ineligible })}</div>
                <ul>
                  {[...reasons].map(([reason, count]) => (
                    <li key={reason}>
                      {intl.formatMessage(messages.reasonRow, {
                        count: formatCount(count),
                        reason: intl.formatMessage(messages[REASON_MESSAGES[reason]]),
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {error === null ? null : <div className="ovl-coverage__error">{error}</div>}
      </div>
    </Dialog>
  );
}
