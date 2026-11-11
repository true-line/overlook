import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { IntlHost } from '../../src/renderer/src/i18n/IntlHost.js';
import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
import type { RestoreStatusSnapshot } from '../../src/shared/backup/restore-contract.js';
import { RestoreLibraryCard } from '../../src/renderer/src/restore/restore-library-card.js';
import { RestoreWorkflow } from '../../src/renderer/src/restore/RestoreWorkflow.js';

function idleRestoreStatus(): RestoreStatusSnapshot {
  return {
    phase: 'idle',
    sessionId: null,
    libraryId: null,
    providerId: null,
    progress: null,
    lastError: null,
    lastResult: null,
    verification: null,
    libraries: [],
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
    root = undefined;
  });
  container?.remove();
  container = undefined;
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const LIBRARY = {
  libraryId: '01KY000QE5PMZR2P66DX0CCR6D',
  generation: 3,
  generatedAt: '2026-07-22T19:32:00.000Z',
  photos: 100,
  totalBytes: 16_200_000,
  excludedCount: 0,
  excludedBytes: 0,
  albums: 1,
  compatibility: 'compatible' as const,
  validation: 'valid' as const,
  fallbackGenerations: 0,
  resumable: false,
};

function installOverlook(status: RestoreStatusSnapshot): {
  restore: () => void;
  emitStatus: (next: RestoreStatusSnapshot) => void;
} {
  const previous = (window as unknown as { overlook?: unknown }).overlook;
  const listeners = new Set<(next: RestoreStatusSnapshot) => void>();
  const providers = [{ id: 'prov-a', label: 'Provider A', available: true, unavailableReason: null }];
  (window as unknown as { overlook: unknown }).overlook = {
    getLocale: () => Promise.resolve('en-US'),
    settings: { get: () => Promise.resolve({ settings: { providerId: 'prov-a' } }), onChanged: () => () => undefined },
    backup: {
      providers: () => Promise.resolve({ providers, defaultProviderId: 'prov-a' }),
      providerStatus: () => Promise.resolve({ connected: true, provider: providers[0], accountLabel: null }),
      connect: () => Promise.resolve({ ok: true, reason: null }),
    },
    restore: {
      status: () => Promise.resolve(status),
      onProgress: () => () => undefined,
      onStatusChanged: (listener: (next: RestoreStatusSnapshot) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      pickKey: () => Promise.resolve({ path: null }),
      discover: () => Promise.resolve({ sessionId: null, libraries: [], error: null }),
      cancel: () => Promise.resolve({}),
    },
  };
  return {
    restore: () => {
      (window as unknown as { overlook?: unknown }).overlook = previous;
    },
    emitStatus: (next) => {
      for (const listener of listeners) listener(next);
    },
  };
}

test('reopening a running restore shows done/total progress instead of setup', async () => {
  const { restore } = installOverlook({
    ...idleRestoreStatus(),
    phase: 'running',
    sessionId: 'session-a',
    libraryId: LIBRARY.libraryId,
    providerId: 'prov-a',
    progress: { stage: 'downloading', done: 42, total: 100, photoId: 'P42' },
    libraries: [LIBRARY],
  });
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();
    assert.match(container.textContent ?? '', /Downloading and verifying originals/u);
    assert.match(container.textContent ?? '', /42 \/ 100 · 42%/u);
    assert.doesNotMatch(container.textContent ?? '', /Discover backups/u);
  } finally {
    restore();
  }
});

test('verify scan shows a progress bar instead of a spinner-only empty state', async () => {
  const { restore } = installOverlook({
    ...idleRestoreStatus(),
    phase: 'verify-scan',
    sessionId: 'session-a',
    libraryId: LIBRARY.libraryId,
    providerId: 'prov-a',
    progress: { stage: 'verifying', done: 7, total: 100, photoId: 'P7' },
    libraries: [LIBRARY],
  });
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();
    assert.match(container.textContent ?? '', /Scanning cloud backup/u);
    assert.match(container.textContent ?? '', /7 \/ 100 · 7%/u);
    assert.ok(container.querySelector('[role="progressbar"]'));
  } finally {
    restore();
  }
});

test('a reopened running dialog follows status-changed to the complete screen', async () => {
  const { restore, emitStatus } = installOverlook({
    ...idleRestoreStatus(),
    phase: 'running',
    sessionId: 'session-a',
    libraryId: LIBRARY.libraryId,
    providerId: 'prov-a',
    progress: { stage: 'downloading', done: 42, total: 100, photoId: 'P42' },
    libraries: [LIBRARY],
  });
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();
    act(() => {
      emitStatus({
        ...idleRestoreStatus(),
        phase: 'complete',
        libraryId: LIBRARY.libraryId,
        providerId: 'prov-a',
        progress: { stage: 'complete', done: 1, total: 1, photoId: null },
        lastResult: {
          libraryId: LIBRARY.libraryId,
          generation: 3,
          photos: 100,
          coverage: { excludedCount: 2, excludedBytes: 4096 },
          resumed: false,
          missing: [],
        },
        libraries: [LIBRARY],
      });
    });
    assert.match(container.textContent ?? '', /Restore complete/u);
    assert.match(container.textContent ?? '', /100 photos restored/u);
    assert.match(container.querySelector('[data-testid="restore-excluded"]')?.textContent ?? '', /2 photos \(4\.1 kB\)/u);
    assert.doesNotMatch(container.textContent ?? '', /Downloading and verifying originals/u);
  } finally {
    restore();
  }
});

test('a finished verify stays on the results screen even when nothing is missing (#994)', async () => {
  const { restore } = installOverlook({
    ...idleRestoreStatus(),
    phase: 'session',
    sessionId: 'session-a',
    libraryId: LIBRARY.libraryId,
    providerId: 'prov-a',
    verification: {
      verificationId: 'plan-a',
      libraryId: LIBRARY.libraryId,
      generation: 3,
      photos: 100,
      verifiedCount: 100,
      missingCount: 0,
      corruptCount: 0,
      missing: [],
    },
    libraries: [LIBRARY],
  });
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();
    assert.ok(container.querySelector('[data-testid="restore-verify"]'));
    assert.match(container.textContent ?? '', /0 missing, 0 corrupt/u);
    assert.match(container.textContent ?? '', /Heal/u);
    assert.match(container.textContent ?? '', /Discard this backup/u);
    assert.match(container.textContent ?? '', /Do nothing/u);
    assert.match(container.textContent ?? '', /Export missing\/corrupt list/u);
    assert.match(container.textContent ?? '', /Save corrupt copies/u);
    assert.doesNotMatch(container.textContent ?? '', /This replaces the active library/u);
  } finally {
    restore();
  }
});

test('Do nothing dismisses the verify plan instead of only hiding the results (#994)', async () => {
  const { restore } = installOverlook({
    ...idleRestoreStatus(),
    phase: 'session',
    sessionId: 'session-a',
    libraryId: LIBRARY.libraryId,
    providerId: 'prov-a',
    verification: {
      verificationId: 'plan-a',
      libraryId: LIBRARY.libraryId,
      generation: 3,
      photos: 100,
      verifiedCount: 100,
      missingCount: 0,
      corruptCount: 0,
      missing: [],
    },
    libraries: [LIBRARY],
  });
  try {
    let cancelled = 0;
    const api = (window as unknown as { overlook: { restore: { cancel: (request: object) => Promise<object> } } }).overlook;
    api.restore.cancel = () => {
      cancelled += 1;
      return Promise.resolve({});
    };
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();
    const button = [...container.querySelectorAll('button')].find((element) => element.textContent === 'Do nothing');
    assert.ok(button);
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(cancelled, 1);
    assert.doesNotMatch(container.textContent ?? '', /0 missing, 0 corrupt/u);
    assert.match(container.textContent ?? '', /Available libraries/u);
  } finally {
    restore();
  }
});

test('SettingsDialog no longer nests RestoreWorkflow, so closing Settings cannot unmount a running job', () => {
  const source = readFileSync(join(process.cwd(), 'src/renderer/src/settings/SettingsDialog.tsx'), 'utf8');
  assert.doesNotMatch(source, /RestoreWorkflow/u);
  assert.match(source, /onRestore\?:/u);
});

test('backup selection names identify each exclusion notice without dangling references (#1125)', async () => {
  const { restore } = installOverlook(idleRestoreStatus());
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            {[0, 2, 3].map((excludedCount) => (
              <RestoreLibraryCard
                key={excludedCount}
                library={{ ...LIBRARY, excludedCount, excludedBytes: excludedCount * 2048 }}
                selected={false}
                onSelect={() => undefined}
              />
            ))}
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();
    const buttons = [...container.querySelectorAll('.ovl-restore__librarySelect')];
    assert.equal(buttons.length, 3);
    // The notice is visible inside the button, so the button's name carries it
    // (WCAG 2.5.3) and the reference can never dangle.
    assert.equal(buttons[0]?.querySelector('[data-testid="restore-excluded"]'), null);
    const notices = buttons.slice(1).map((button) => {
      const notice = button.querySelector('[data-testid="restore-excluded"]');
      assert.ok(notice);
      assert.match(notice.textContent ?? '', /deliberately not held by this backup/u);
      // The button names its notice: the notice lives inside the button, so
      // the accessible name carries its words.
      assert.match(button.textContent ?? '', /deliberately not held by this backup/u);
      return notice;
    });
    assert.equal(new Set(notices).size, 2, 'each card names its own exclusion totals');
  } finally {
    restore();
  }
});
