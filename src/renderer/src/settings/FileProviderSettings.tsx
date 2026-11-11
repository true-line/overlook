import { useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { FILE_PROVIDER_CONSENT_VERSION } from '../../../shared/file-provider/contract';
import { Button } from '../components/Button';
import { Segmented } from '../components/Segmented';
import { Field } from './Field';

type Snapshot = Awaited<ReturnType<typeof window.overlook.fileProvider.status>>;

const messages = defineMessages({
  label: { id: 'settings.fileProvider.label', defaultMessage: 'Finder access' },
  hint: {
    id: 'settings.fileProvider.hint',
    defaultMessage: 'Expose explicitly selected ordinary photos as a read-only macOS File Provider location.',
  },
  enabledDisclosure: {
    id: 'settings.fileProvider.enabledDisclosure',
    defaultMessage:
      'Finder access is on. macOS may retain downloaded copies after Overlook locks; disabling requests eviction but cannot guarantee immediate deletion from every system cache.',
  },
  disable: { id: 'settings.fileProvider.disable', defaultMessage: 'Disable Finder access' },
  disabling: { id: 'settings.fileProvider.disabling', defaultMessage: 'Disabling…' },
  scope: { id: 'settings.fileProvider.scope', defaultMessage: 'Finder access scope' },
  wholeLibrary: { id: 'settings.fileProvider.wholeLibrary', defaultMessage: 'Whole library' },
  selectedAlbums: { id: 'settings.fileProvider.selectedAlbums', defaultMessage: 'Selected albums' },
  albums: { id: 'settings.fileProvider.albums', defaultMessage: 'Albums available to Finder' },
  album: { id: 'settings.fileProvider.album', defaultMessage: '{name} ({count})' },
  consent: {
    id: 'settings.fileProvider.consent',
    defaultMessage: 'I understand that Finder decrypts originals on demand and macOS may cache those plaintext copies outside Overlook.',
  },
  enable: { id: 'settings.fileProvider.enable', defaultMessage: 'Enable Finder access' },
  enabling: { id: 'settings.fileProvider.enabling', defaultMessage: 'Enabling…' },
  unavailable: {
    id: 'settings.fileProvider.unavailable',
    defaultMessage: 'Finder access requires the signed macOS app and its bundled File Provider extension.',
  },
  statusError: { id: 'settings.fileProvider.statusError', defaultMessage: 'File Provider status could not be loaded.' },
  enableError: { id: 'settings.fileProvider.enableError', defaultMessage: 'Finder access could not be enabled.' },
  disableError: { id: 'settings.fileProvider.disableError', defaultMessage: 'Finder access could not be disabled.' },
});

export function FileProviderSettings(): ReactElement {
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scopeKind, setScopeKind] = useState<'library' | 'albums'>('library');
  const [albumIds, setAlbumIds] = useState<ReadonlySet<string>>(() => new Set());
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.overlook.fileProvider
      .status()
      .then((value) => {
        if (!live) return;
        setSnapshot(value);
        setScopeKind(value.config.scope.kind);
        setAlbumIds(new Set(value.config.scope.kind === 'albums' ? value.config.scope.albumIds : []));
      })
      .catch(() => live && setError(intl.formatMessage(messages.statusError)));
    return () => {
      live = false;
    };
  }, [intl]);

  const enable = (): void => {
    if (!consented || (scopeKind === 'albums' && albumIds.size === 0)) return;
    setBusy(true);
    setError(null);
    const scope = scopeKind === 'library' ? ({ kind: 'library' } as const) : { kind: 'albums' as const, albumIds: [...albumIds] };
    void window.overlook.fileProvider
      .enable({ scope, consentVersion: FILE_PROVIDER_CONSENT_VERSION })
      .then(setSnapshot)
      .catch(() => setError(intl.formatMessage(messages.enableError)))
      .finally(() => setBusy(false));
  };

  const disable = (): void => {
    setBusy(true);
    setError(null);
    void window.overlook.fileProvider
      .disable()
      .then((value) => {
        setSnapshot(value);
        setConsented(false);
      })
      .catch(() => setError(intl.formatMessage(messages.disableError)))
      .finally(() => setBusy(false));
  };

  const unavailable = snapshot !== null && !snapshot.available;
  const enabled = snapshot?.config.enabled === true;
  return (
    <Field label={intl.formatMessage(messages.label)} hint={intl.formatMessage(messages.hint)} layout="stacked">
      <div className="ovl-settings__fileProvider">
        {enabled ? (
          <>
            <p>{intl.formatMessage(messages.enabledDisclosure)}</p>
            <Button variant="secondary" disabled={busy} onClick={disable}>
              {intl.formatMessage(busy ? messages.disabling : messages.disable)}
            </Button>
          </>
        ) : (
          <>
            <Segmented
              label={intl.formatMessage(messages.scope)}
              value={scopeKind}
              options={[
                { value: 'library', label: intl.formatMessage(messages.wholeLibrary) },
                { value: 'albums', label: intl.formatMessage(messages.selectedAlbums) },
              ]}
              onChange={setScopeKind}
            />
            {scopeKind === 'albums' ? (
              <div role="group" aria-label={intl.formatMessage(messages.albums)}>
                {snapshot?.albums.map((album) => (
                  <label key={album.id}>
                    <input
                      type="checkbox"
                      checked={albumIds.has(album.id)}
                      onChange={(event) => {
                        const next = new Set(albumIds);
                        if (event.currentTarget.checked) next.add(album.id);
                        else next.delete(album.id);
                        setAlbumIds(next);
                      }}
                    />
                    {intl.formatMessage(messages.album, { name: album.name, count: album.count })}
                  </label>
                ))}
              </div>
            ) : null}
            <label>
              <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.currentTarget.checked)} />
              {intl.formatMessage(messages.consent)}
            </label>
            <Button disabled={busy || unavailable || !consented || (scopeKind === 'albums' && albumIds.size === 0)} onClick={enable}>
              {intl.formatMessage(busy ? messages.enabling : messages.enable)}
            </Button>
            {unavailable ? <p>{intl.formatMessage(messages.unavailable)}</p> : null}
          </>
        )}
        {error === null ? null : (
          <p className="prose-note" role="alert">
            {error}
          </p>
        )}
      </div>
    </Field>
  );
}
