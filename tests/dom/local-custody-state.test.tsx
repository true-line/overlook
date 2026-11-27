import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
import { glyphStateOf, StatusGlyph } from '../../src/renderer/src/components/StatusGlyph.js';
import { OriginalRecoveryAction } from '../../src/renderer/src/inspector/original-recovery-action.js';
import { StatusBar } from '../../src/renderer/src/shell/StatusBar.js';
import { AppStateProvider } from '../../src/renderer/src/state/app-state-context.js';
import type { LibraryStats, PhotoRecord } from '../../src/shared/library/types.js';

test('excluded local loss has its own glyph, independently of cloud sync progress (#1135)', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const failure of ['local-missing', 'local-corrupt'] as const) {
      const state = glyphStateOf({ syncState: 'local', coverage: 'excluded', localCustodyFailure: failure });
      assert.equal(state, failure);
      act(() =>
        root.render(
          <IntlProvider locale="en">
            <StatusGlyph state={state} />
          </IntlProvider>,
        ),
      );
      assert.equal(
        container.querySelector('[role="img"]')?.getAttribute('aria-label'),
        failure === 'local-missing' ? 'Local original missing' : 'Local original corrupt',
      );
    }
    assert.equal(glyphStateOf({ syncState: 'local', coverage: 'excluded', localCustodyFailure: null }), 'excluded');
    assert.equal(glyphStateOf({ syncState: 'synced', coverage: 'included', localCustodyFailure: 'local-missing' }), 'synced');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test('coverage statistics disclose missing/corrupt local custody even offline and clear after recheck (#1135)', () => {
  const previous = window.overlook;
  Object.defineProperty(window, 'overlook', { configurable: true, value: { library: { onPendingCountChanged: () => () => undefined } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const stats: LibraryStats = {
    photos: 2,
    bytes: 200,
    pending: 0,
    lastBackupAt: null,
    offloadedBytes: 0,
    excludedCount: 2,
    excludedBytes: 200,
    pendingRemovals: 0,
    localMissingCount: 1,
    localCorruptCount: 1,
    localMissingBytes: 100,
  };
  const render = (value: LibraryStats) =>
    act(() =>
      root.render(
        <IntlProvider locale="en">
          <AppStateProvider>
            <AnnouncerProvider>
              <StatusBar stats={value} />
            </AnnouncerProvider>
          </AppStateProvider>
        </IntlProvider>,
      ),
    );
  try {
    render(stats);
    assert.equal(container.querySelector('[data-testid="sync-state"]')?.textContent, '1 local original missing · 1 local original corrupt');
    assert.ok(!container.textContent?.includes('All backed up'));
    render({ ...stats, localMissingCount: 0, localCorruptCount: 0, localMissingBytes: 0 });
    assert.ok(!container.querySelector('[data-testid="sync-state"]')?.textContent?.includes('local original'));
    assert.equal(stats.excludedCount, 2, 'a healthy recheck changes evidence, not the user decision');
  } finally {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, 'overlook', { configurable: true, value: previous });
  }
});

test('a missing excluded original offers exact-file recovery with the existing key-lock boundary (#1135)', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const photo = {
    id: 'excluded',
    originalFailure: null,
    localCustodyFailure: 'local-missing',
    coverage: 'excluded',
    deletedAt: null,
    keyId: 1,
    missingKeyId: 2,
    locked: false,
  } as PhotoRecord;
  const render = (value: PhotoRecord) =>
    act(() =>
      root.render(
        <IntlProvider locale="en">
          <OriginalRecoveryAction photo={value} />
        </IntlProvider>,
      ),
    );
  try {
    render(photo);
    assert.match(container.textContent ?? '', /original is missing/u);
    assert.equal(container.querySelector('button')?.disabled, false);
    render({ ...photo, locked: true });
    assert.equal(container.querySelector('button')?.disabled, true);
    assert.match(container.textContent ?? '', /KEY #2/u);
    render({ ...photo, localCustodyFailure: null });
    assert.equal(container.querySelector('button'), null);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
