import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, type Dispatch, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { TitlebarAppMenu } from '../../src/renderer/src/components/TitlebarMenu.js';
import { useExportDialog } from '../../src/renderer/src/export/use-export-dialog.js';
import { useNativeCommandRouter } from '../../src/renderer/src/shell/use-native-command-router.js';
import { AppStateProvider, useAppDispatch, useAppState } from '../../src/renderer/src/state/app-state-context.js';
import { useCommandDispatcher } from '../../src/renderer/src/state/use-command-dispatcher.js';
import { EMPTY_COMMAND_MENU_CONTEXT, type CommandMenuContext } from '../../src/shared/commands/menu-contract.js';
import type { AppAction, AppState } from '../../src/shared/library/app-state.js';

let root: Root | undefined;
const previous = window.overlook;
let lockCalls = 0;

function installOverlookMock(): void {
  lockCalls = 0;
  (window as unknown as { overlook: unknown }).overlook = {
    appLock: {
      lockNow: () => {
        lockCalls += 1;
        return Promise.resolve({ state: 'locked' });
      },
    },
    library: {
      photoKeySelection: () => Promise.resolve({ photoIds: [], locked: 0, missing: 0 }),
      onChanged: () => () => undefined,
      onPendingCountChanged: () => () => undefined,
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  (window as unknown as { overlook: unknown }).overlook = previous;
  document.body.replaceChildren();
});

let latestState: AppState;
let latestDispatch: Dispatch<AppAction>;

function Harness({ platform, lockConfigured }: { readonly platform: string; readonly lockConfigured: boolean }): ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const exportDialog = useExportDialog();
  latestState = state;
  latestDispatch = dispatch;
  useCommandDispatcher(
    platform,
    () => undefined,
    false,
    () => undefined,
  );
  const runCommand = useNativeCommandRouter({
    nativeCommand: null,
    state,
    dispatch,
    exportDialog,
    onSelectAll: () => undefined,
    setShortcutSurface: () => undefined,
    setSettingsSection: () => undefined,
    setAlbumPickerIds: () => undefined,
    setLibrariesCreating: () => undefined,
    resetInteropEntry: () => undefined,
    resetUnlockAlbum: () => undefined,
    resetDropped: () => undefined,
    closeOffload: () => undefined,
    pcloudEnabled: false,
    lockConfigured,
  });
  const context: CommandMenuContext = {
    ...EMPTY_COMMAND_MENU_CONTEXT,
    surface: state.lightboxId === null ? 'grid' : 'lightbox',
    hasLibrary: true,
    hasPhotos: true,
    appLockConfigured: lockConfigured,
  };
  return <TitlebarAppMenu platform={platform} context={context} onCommand={runCommand} />;
}

function renderHarness(platform: string, lockConfigured = true): void {
  act(() => {
    root?.render(
      <IntlProvider locale="en" defaultLocale="en">
        <AppStateProvider>
          <Harness platform={platform} lockConfigured={lockConfigured} />
        </AppStateProvider>
      </IntlProvider>,
    );
  });
}

test('Windows/Linux TitlebarAppMenu Lock Now invokes appLock.lockNow (#1433)', () => {
  installOverlookMock();
  renderHarness('win32', true);
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Overlook menu"]');
  assert.ok(trigger);
  act(() => {
    trigger.click();
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const lockItem = items.find((item) => item.textContent?.includes('Lock Now'));
  assert.ok(lockItem, 'Lock Now menu item renders when app lock is configured');
  act(() => {
    lockItem.click();
  });
  assert.equal(lockCalls, 1);
});

test('Ctrl+Alt+D opens Review Duplicates on Windows/Linux without double-firing on macOS (#1433)', () => {
  installOverlookMock();
  renderHarness('linux', true);
  assert.equal(latestState.duplicatesOpen, false);
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', ctrlKey: true, altKey: true, cancelable: true }));
  });
  assert.equal(latestState.duplicatesOpen, true);

  // While Activity dialog is open, global shortcuts stay suppressed.
  act(() => {
    latestDispatch({ type: 'dialog/set', dialog: 'duplicates', open: false });
    latestDispatch({ type: 'dialog/set', dialog: 'activity', open: true });
  });
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', ctrlKey: true, altKey: true, cancelable: true }));
  });
  assert.equal(latestState.duplicatesOpen, false);

  // On macOS, the native File menu owns ⌥⌘D so useCommandDispatcher returns false.
  renderHarness('darwin', true);
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', metaKey: true, altKey: true, cancelable: true }));
  });
  assert.equal(latestState.duplicatesOpen, false);
});
