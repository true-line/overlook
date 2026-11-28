import { useState, type ReactElement } from 'react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';
import { commandById } from '../../../shared/commands/registry.js';
import { photoCommandAvailability, LOCKED_PHOTO_COMMAND_REASON } from '../../../shared/commands/photo-availability.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import type { AppAction } from '../../../shared/library/app-state.js';
import { Button } from '../components/Button.js';

const messages = defineMessages({
  missing: { id: 'photo.recovery.missing', defaultMessage: 'The original is missing. Select the matching original file to recover it.' },
  corrupt: {
    id: 'photo.recovery.corrupt',
    defaultMessage: 'The local original is corrupt. Select the matching original file to recover it.',
  },
  recovered: { id: 'photo.recovery.recovered', defaultMessage: 'Original recovered.' },
  failed: {
    id: 'photo.recovery.failed',
    defaultMessage: 'Recovery failed. Select the exact original file and make sure its key is available.',
  },
  unavailable: { id: 'photo.recovery.unavailable', defaultMessage: 'This photo no longer needs original recovery, or is unavailable.' },
});

export async function recoverOriginalWithMessage(photo: PhotoRecord, intl: IntlShape): Promise<string | null> {
  if (!photoCommandAvailability('photo.recoverOriginal', photo.locked).enabled) {
    return intl.formatMessage(LOCKED_PHOTO_COMMAND_REASON, { id: String(photo.missingKeyId ?? photo.keyId) });
  }
  try {
    const { status } = await window.overlook.library.recoverOriginal({ photoId: photo.id });
    return status === 'cancelled' ? null : intl.formatMessage(messages[status]);
  } catch {
    return intl.formatMessage(messages.failed);
  }
}

export function recoverOriginalWithToast(photo: PhotoRecord, intl: IntlShape, dispatch: (action: AppAction) => void): void {
  void recoverOriginalWithMessage(photo, intl).then((title) => {
    if (title !== null) dispatch({ type: 'toast/shown', toast: { title, tone: 'neutral' } });
  });
}

export function OriginalRecoveryAction({ photo }: { readonly photo: PhotoRecord }): ReactElement | null {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if ((photo.originalFailure !== 'missing-original' && photo.localCustodyFailure !== 'local-missing') || photo.deletedAt !== null)
    return null;
  const enabled = photoCommandAvailability('photo.recoverOriginal', photo.locked).enabled;
  const reason = enabled ? undefined : intl.formatMessage(LOCKED_PHOTO_COMMAND_REASON, { id: String(photo.missingKeyId ?? photo.keyId) });
  return (
    <div>
      <p className="prose-note">
        {intl.formatMessage(photo.localCustodyFailure === 'local-corrupt' ? messages.corrupt : messages.missing)}
      </p>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || !enabled}
        title={reason}
        onClick={() => {
          setBusy(true);
          setResult(null);
          void recoverOriginalWithMessage(photo, intl)
            .then(setResult)
            .finally(() => setBusy(false));
        }}
      >
        {intl.formatMessage(commandById('photo.recoverOriginal').label)}
      </Button>
      {reason === undefined ? null : <p className="prose-note">{reason}</p>}
      {result === null ? null : (
        <p role="status" className="prose-note">
          {result}
        </p>
      )}
    </div>
  );
}
