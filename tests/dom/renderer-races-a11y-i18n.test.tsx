import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { act, useRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { StatusGlyph } from '../../src/renderer/src/components/StatusGlyph.js';
import { useDialogKeyboard } from '../../src/renderer/src/components/use-dialog-keyboard.js';
import { PhotoMetadataEditor } from '../../src/renderer/src/inspector/PhotoMetadataEditor.js';
import { QuickActionsSettings } from '../../src/renderer/src/settings/QuickActionsSettings.js';
import { AppStateProvider, useAppDispatch, useAppState } from '../../src/renderer/src/state/app-state-context.js';
import { useLibraryPhotos } from '../../src/renderer/src/state/use-library-photos.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

let root: Root | undefined;
const previous = window.overlook;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  (window as unknown as { overlook: unknown }).overlook = previous;
  document.body.replaceChildren();
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function makePhoto(id: string, title: string | null = null): PhotoRecord {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1600,
    height: 1200,
    bytes: 4096,
    contentHash: `hash-${id}`,
    derivativeKey: `hash-${id}`,
    variantSourceId: null,
    assetOwnerId: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: '2026-07-01T12:00:00.000Z',
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-01T12:00:00.000Z',
    importSource: 'folder',
    favorite: false,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    mediaInfo: null,
    syncState: 'local',
    coverage: 'included',
    locked: false,
    title,
    description: null,
    tags: [],
    userTags: [],
    importedKeywords: [],
    suppressedKeywords: [],
    metadataVersion: 0,
  };
}

test('PhotoMetadataEditor sequences tagSuggestions and syncs untouched drafts on library.onChanged (#1441)', async () => {
  type SummaryResult = Awaited<ReturnType<typeof window.overlook.library.metadataSummary>>;
  type SuggestionsResult = Awaited<ReturnType<typeof window.overlook.library.tagSuggestions>>;

  let currentTitle = 'Initial title';
  let currentDesc = 'Initial description';
  const suggestionResolvers: ((value: SuggestionsResult) => void)[] = [];
  let emitChanged = (_event: { photoIds: string[]; derivativeOnly: boolean; membership: 'none' }): void => {};

  (window as unknown as { overlook: unknown }).overlook = {
    library: {
      metadataSummary: (): Promise<SummaryResult> =>
        Promise.resolve({
          found: 1,
          missing: 0,
          title: { value: currentTitle, mixed: false },
          description: { value: currentDesc, mixed: false },
          commonTags: [],
          varyingTags: [],
        }),
      tagSuggestions: (): Promise<SuggestionsResult> =>
        new Promise((resolve) => {
          suggestionResolvers.push(resolve);
        }),
      onChanged: (listener: typeof emitChanged) => {
        emitChanged = listener;
        return () => {
          emitChanged = () => {};
        };
      },
    },
  };

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  const photo = makePhoto('P1', 'Initial title');
  act(() => {
    root?.render(
      <IntlProvider locale="en" defaultLocale="en">
        <PhotoMetadataEditor photo={photo} photoIds={['P1']} />
      </IntlProvider>,
    );
  });
  await flush();

  const titleInput = container.querySelector<HTMLInputElement>('#photo-metadata-title');
  const descInput = container.querySelector<HTMLTextAreaElement>('#photo-metadata-description');
  const tagInput = container.querySelector<HTMLInputElement>('input[list="photo-tag-suggestions"]');
  assert.ok(titleInput && descInput && tagInput);
  assert.equal(titleInput.value, 'Initial title');
  assert.equal(descInput.value, 'Initial description');

  const setNativeInputValue = (input: HTMLInputElement, value: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') as
      { set?: (this: HTMLInputElement, next: string) => void } | undefined;
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Trigger a second tagSuggestions query, then resolve the newer request BEFORE the older one.
  act(() => {
    setNativeInputValue(tagInput, 'sun');
  });
  assert.equal(suggestionResolvers.length, 2);
  suggestionResolvers[1]?.({ tags: [{ name: 'sunset', count: 3 }] });
  await flush();
  suggestionResolvers[0]?.({ tags: [{ name: 'stale-tag', count: 9 }] });
  await flush();
  const options = [...container.querySelectorAll('datalist option')].map((opt) => opt.getAttribute('value'));
  assert.deepEqual(options, ['sunset']);

  // Touch title locally, then emit an external library.onChanged (e.g. Undo / Feed edit):
  // untouched description refreshes while touched title draft is preserved.
  act(() => {
    setNativeInputValue(titleInput, 'Draft in progress');
  });
  currentTitle = 'External title';
  currentDesc = 'External description';
  act(() => {
    emitChanged({ photoIds: ['P1'], derivativeOnly: false, membership: 'none' });
  });
  await flush();
  assert.equal(titleInput.value, 'Draft in progress');
  assert.equal(descInput.value, 'External description');
});

test('useLibraryPhotos keeps a stable onChanged subscription across photo updates and drops stale get() patches (#1441)', async () => {
  let onChangedSubCount = 0;
  let emitChanged = (_event: { photoIds: string[]; derivativeOnly: boolean; membership: 'none'; albumIds: string[] }): void => {};
  const getResolvers: ((value: { photo: PhotoRecord | null }) => void)[] = [];
  let setSourceRef: ((source: 'all' | 'favorites') => void) | undefined;

  (window as unknown as { overlook: unknown }).overlook = {
    library: {
      page: ({ source }: { source: string }) =>
        Promise.resolve({
          photos: source === 'all' ? [makePhoto('P1', 'Old')] : [makePhoto('P2', 'Fav')],
          nextCursor: null,
          search: { mode: 'keyword', effective: 'keyword', fallbackReason: null },
        }),
      get: () =>
        new Promise<{ photo: PhotoRecord | null }>((resolve) => {
          getResolvers.push(resolve);
        }),
      onChanged: (listener: typeof emitChanged) => {
        onChangedSubCount += 1;
        emitChanged = listener;
        return () => {
          emitChanged = () => {};
        };
      },
      onSyncStateChanged: () => () => {},
      onPendingCountChanged: () => () => {},
    },
  };

  function Probe(): ReactElement {
    useLibraryPhotos();
    const state = useAppState();
    const dispatch = useAppDispatch();
    setSourceRef = (source) => dispatch({ type: 'source/set', source });
    return <output data-testid="titles">{state.photos.map((p) => `${p.id}:${p.title ?? ''}`).join(',')}</output>;
  }

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AppStateProvider>
        <Probe />
      </AppStateProvider>,
    );
  });
  await flush();

  assert.equal(container.querySelector('[data-testid="titles"]')?.textContent, 'P1:Old');
  assert.equal(onChangedSubCount, 1, 'loading photos must not tear down and re-subscribe onChanged');

  // Start an in-flight record patch for P1, then switch views before get() resolves.
  act(() => {
    emitChanged({ photoIds: ['P1'], derivativeOnly: false, membership: 'none', albumIds: [] });
  });
  assert.equal(getResolvers.length, 1);
  act(() => {
    setSourceRef?.('favorites');
  });
  await flush();
  assert.equal(container.querySelector('[data-testid="titles"]')?.textContent, 'P2:Fav');

  // Resolve the stale get() from the old view; P2 must remain untouched.
  getResolvers[0]?.({ photo: makePhoto('P1', 'Stale patch') });
  await flush();
  assert.equal(container.querySelector('[data-testid="titles"]')?.textContent, 'P2:Fav');
});

test('useDialogKeyboard reclaims Tab and Shift+Tab focus when activeElement escapes the panel (#1441)', () => {
  function TrapHarness(): ReactElement {
    const panelRef = useRef<HTMLDivElement>(null);
    useDialogKeyboard(true, panelRef, () => {});
    return (
      <div>
        <button type="button" id="outside-btn">
          Outside
        </button>
        <div ref={panelRef} tabIndex={-1}>
          <button type="button" id="first-btn">
            First
          </button>
          <button type="button" id="last-btn">
            Last
          </button>
        </div>
      </div>
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<TrapHarness />);
  });

  const outside = container.querySelector<HTMLButtonElement>('#outside-btn');
  const first = container.querySelector<HTMLButtonElement>('#first-btn');
  const last = container.querySelector<HTMLButtonElement>('#last-btn');
  assert.ok(outside && first && last);

  outside.focus();
  assert.equal(document.activeElement, outside);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, first);

  outside.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, last);
});

test('QuickActionsSettings, StatusGlyph, and error stylesheets satisfy a11y, i18n, and user-select contracts (#1441)', () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <IntlProvider
        locale="fr"
        defaultLocale="en"
        messages={{
          'statusGlyph.synced': 'Sauvegardé (chiffré)',
          'settings.general.quickActions.up': 'Haut',
          'settings.general.quickActions.moveUp': ' — Monter {action}',
          'commands.photo.favorite.toggle': 'Favori',
        }}
      >
        <StatusGlyph state="synced" />
        <QuickActionsSettings value={['photo.favorite.toggle', 'photo.export']} onChange={() => {}} />
      </IntlProvider>,
    );
  });

  const glyph = container.querySelector('[role="img"]');
  assert.equal(glyph?.getAttribute('aria-label'), 'Sauvegardé (chiffré)');

  const buttons = [...container.querySelectorAll('button')];
  const upButton = buttons.find((btn) => btn.textContent?.startsWith('Haut'));
  assert.ok(upButton, 'Up button starts with visible localized text');
  assert.equal(upButton.getAttribute('aria-label'), null, 'Up button relies on content + .ovl-sr-only rather than aria-label override');
  assert.equal(upButton.textContent, 'Haut — Monter Favori');

  const repoRoot = process.cwd();
  for (const relPath of [
    'src/renderer/src/export/export.css',
    'src/renderer/src/import/import.css',
    'src/renderer/src/shell/shell.css',
    'src/renderer/src/shell/library-switcher.css',
    'src/renderer/src/shell/move-library.css',
  ]) {
    const css = readFileSync(path.join(repoRoot, relPath), 'utf8');
    assert.match(css, /user-select:\s*text;/u, `${relPath} enables text selection on error diagnostics`);
  }
});
