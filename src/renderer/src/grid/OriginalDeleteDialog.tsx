import { useEffect, useState, type ReactElement } from 'react';
import { useIntl } from 'react-intl';

import { ORIGINAL_DELETE_AUTHORIZATION, destructiveActions } from '../../../shared/destructive-actions.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { PasswordField } from '../components/PasswordField';

type Preflight = Awaited<ReturnType<typeof window.overlook.library.originalDeletePreflight>>;

export interface OriginalDeleteDialogProps {
  readonly photoIds: readonly string[];
  readonly onClose: () => void;
  readonly onDeleted: (result: { readonly purged: number; readonly remoteFailures: number }) => void;
}

export function OriginalDeleteDialog({ photoIds, onClose, onDeleted }: OriginalDeleteDialogProps): ReactElement {
  const intl = useIntl();
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [password, setPassword] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.overlook.library
      .originalDeletePreflight({ photoIds: [...photoIds] })
      .then((result) => {
        if (active) {
          setPreflight(result);
          setAuthorized(!result.passwordRequired);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : intl.formatMessage({ id: 'originalDelete.error.preflight', defaultMessage: 'Deletion authorization failed' }),
          );
      });
    return () => {
      active = false;
    };
  }, [intl, photoIds]);

  const cancel = (): void => {
    if (preflight !== null) void window.overlook.library.originalDeleteCancel({ challengeId: preflight.challengeId });
    onClose();
  };
  const count = preflight?.count ?? photoIds.length;
  const target =
    preflight?.fileName ??
    intl.formatMessage({ id: 'originalDelete.target', defaultMessage: '{count, plural, one {# photo} other {# photos}}' }, { count });
  const action = destructiveActions.deleteProtectedOriginals;
  return (
    <Dialog
      open
      title={
        authorized
          ? intl.formatMessage({ id: 'originalDelete.title.confirm', defaultMessage: 'Delete {target} permanently?' }, { target })
          : intl.formatMessage({ id: 'originalDelete.title.authenticate', defaultMessage: 'Authenticate Original deletion' })
      }
      icon="shield-check"
      width={440}
      onClose={busy ? undefined : cancel}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {intl.formatMessage({ id: 'common.cancel', defaultMessage: 'Cancel' })}
          </Button>
          {authorized ? (
            <Button
              variant="danger"
              icon="trash-2"
              disabled={busy || preflight === null}
              onClick={() => {
                if (preflight === null) return;
                setBusy(true);
                setError(null);
                void window.overlook.library
                  .originalDeleteCommit({ challengeId: preflight.challengeId, authorization: ORIGINAL_DELETE_AUTHORIZATION })
                  .then(onDeleted)
                  .catch((reason: unknown) => {
                    setBusy(false);
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : intl.formatMessage({ id: 'originalDelete.error.commit', defaultMessage: 'Deletion failed' }),
                    );
                  });
              }}
            >
              {intl.formatMessage({ id: 'originalDelete.action.delete', defaultMessage: 'Delete permanently' })}
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={busy || preflight === null || password.length === 0}
              onClick={() => {
                if (preflight === null) return;
                setBusy(true);
                setError(null);
                void window.overlook.library
                  .originalDeleteAuthorize({ challengeId: preflight.challengeId, password })
                  .then((result) => {
                    setBusy(false);
                    if (result.ok) {
                      setPassword('');
                      setAuthorized(true);
                    } else if (result.reason === 'wrong-password') {
                      setError(
                        intl.formatMessage({ id: 'originalDelete.error.password', defaultMessage: 'The app password is incorrect.' }),
                      );
                    } else if (result.reason === 'throttled') {
                      const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
                      setError(
                        intl.formatMessage(
                          {
                            id: 'originalDelete.error.throttled',
                            defaultMessage: 'Too many attempts. Try again in {seconds, plural, one {# second} other {# seconds}}.',
                          },
                          { seconds },
                        ),
                      );
                    } else {
                      setError(
                        intl.formatMessage({
                          id: 'originalDelete.error.unavailable',
                          defaultMessage: 'Authorization is unavailable.',
                        }),
                      );
                    }
                  })
                  .catch((reason: unknown) => {
                    setBusy(false);
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : intl.formatMessage({
                            id: 'originalDelete.error.unavailable',
                            defaultMessage: 'Authorization is unavailable.',
                          }),
                    );
                  });
              }}
            >
              {intl.formatMessage({ id: 'originalDelete.action.authenticate', defaultMessage: 'Authenticate' })}
            </Button>
          )}
        </>
      }
    >
      {preflight === null && error === null ? (
        <p>{intl.formatMessage({ id: 'originalDelete.preparing', defaultMessage: 'Preparing protected deletion…' })}</p>
      ) : null}
      {!authorized && preflight !== null ? (
        <>
          <p>
            {intl.formatMessage({
              id: 'originalDelete.authenticate.help',
              defaultMessage: 'Confirm your app password before overriding Original protection.',
            })}
          </p>
          <PasswordField
            value={password}
            onChange={setPassword}
            label={intl.formatMessage({ id: 'appLock.password', defaultMessage: 'App password' })}
            autoComplete="current-password"
          />
        </>
      ) : null}
      {authorized && preflight !== null ? (
        <p>
          {intl.formatMessage(
            {
              id: 'originalDelete.confirm.help',
              defaultMessage:
                'This overrides Original protection for {count, plural, one {# protected photo} other {# protected photos}}. {sideEffects} This cannot be undone.',
            },
            { count: preflight.protected, sideEffects: action.sideEffects },
          )}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="prose-note" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
