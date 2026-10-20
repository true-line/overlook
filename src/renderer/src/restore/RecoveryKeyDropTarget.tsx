import { useId, useState, type DragEvent, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Icon } from '../components/Icon.js';
import { WORD_SEPARATOR } from '../components/word-separator.js';
import { admitRecoveryKeyDrop, type RecoveryKeyDropFailure } from '../recovery-key-drop.js';

const messages = defineMessages({
  choose: { id: 'restore.recoveryKey.choose', defaultMessage: 'Choose recovery key' },
  none: { id: 'restore.recoveryKey.none', defaultMessage: 'No key selected' },
  dropHint: { id: 'restore.recoveryKey.dropHint', defaultMessage: 'Choose or drop one .key file.' },
  dropEmpty: { id: 'recoveryKey.drop.empty', defaultMessage: 'Drop one Overlook recovery-key file.' },
  dropMultiple: { id: 'recoveryKey.drop.multiple', defaultMessage: 'Choose or drop one recovery-key file at a time.' },
  dropWrongType: { id: 'recoveryKey.drop.wrongType', defaultMessage: 'Choose an Overlook .key recovery file.' },
  dropUnavailable: {
    id: 'recoveryKey.drop.unavailable',
    defaultMessage: 'This dropped file has no readable local path. Use the file picker instead.',
  },
});

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

export function RecoveryKeyDropTarget({
  path,
  onPathChange,
}: {
  readonly path: string | null;
  readonly onPathChange: (path: string | null) => void;
}): ReactElement {
  const intl = useIntl();
  const labelId = useId();
  const selectionId = useId();
  const hintId = useId();
  const [error, setError] = useState<string | null>(null);

  const failureMessage = (reason: RecoveryKeyDropFailure): string => {
    const descriptor = {
      empty: messages.dropEmpty,
      multiple: messages.dropMultiple,
      'wrong-type': messages.dropWrongType,
      unavailable: messages.dropUnavailable,
    }[reason];
    return intl.formatMessage(descriptor);
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    const admission = admitRecoveryKeyDrop(event.dataTransfer.files, window.overlook.import.pathForFile);
    if (admission.reason !== null) {
      onPathChange(null);
      setError(failureMessage(admission.reason));
      return;
    }
    onPathChange(admission.path);
    setError(null);
  };

  return (
    <>
      <button
        type="button"
        className="ovl-restore__keydrop"
        aria-labelledby={`${labelId} ${selectionId} ${hintId}`}
        data-testid="recovery-key-drop-target"
        data-overlook-file-drop-target="recovery-key"
        onClick={() => {
          void window.overlook.restore.pickKey().then(({ path: picked }) => {
            if (picked !== null) {
              onPathChange(picked);
              setError(null);
            }
          });
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={onDrop}
      >
        <Icon name="key-round" size={16} />
        <span className="ovl-restore__keydropText">
          {/* The separators keep the three lines separate words: axe reads the
              visible text of a button by concatenating child text with no
              separator. The hint is part of the name, so its visible words are
              inside the accessible name too (WCAG 2.5.3). */}
          <span id={labelId}>
            {intl.formatMessage(messages.choose)}
            {WORD_SEPARATOR}
          </span>
          <span id={selectionId} className={path === null ? 'prose-note' : 'mono-data'} aria-live="polite" aria-atomic="true">
            {path === null ? intl.formatMessage(messages.none) : fileName(path)}
            {WORD_SEPARATOR}
          </span>
          <span id={hintId} className="ovl-restore__keydropHint">
            {intl.formatMessage(messages.dropHint)}
          </span>
        </span>
      </button>
      {error === null ? null : (
        <div className="ovl-restore__fileError" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
