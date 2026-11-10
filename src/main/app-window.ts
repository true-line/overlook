import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { events } from '../shared/ipc/channels.js';
import { createEmitter } from '../shared/ipc/registry.js';
import { withAppearanceBootstrapQuery } from './appearance-runtime.js';
import { reloadWebContentsForLock, type ReloadableWebContents } from './crypto/renderer-lock-reload.js';
import { initialWindowBehavior, requestNativeWindowAttention } from './e2e-window-visibility.js';
import { createInspectorWindowController } from './inspector-window-controller.js';
import { installWindowNavigationPolicy } from './window-navigation-policy.js';
import type { InspectorWindowState } from '../shared/inspector-window-contract.js';

let windowAppearance: 'dark' | 'light' = 'dark';
let windowBackgroundColor = '#050708';

interface ThemedReloadableWebContents extends ReloadableWebContents {
  getURL(): string;
  loadURL(url: string): Promise<void>;
}

export function applyWindowAppearance(appearance: 'dark' | 'light', backgroundColor: string): void {
  windowAppearance = appearance;
  windowBackgroundColor = backgroundColor;
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(backgroundColor);
}

export function broadcast(send: (win: BrowserWindow) => void): void {
  for (const win of BrowserWindow.getAllWindows()) send(win);
}

export function createWindow(): BrowserWindow {
  return createContentWindow('primary');
}

const inspectorController = createInspectorWindowController<BrowserWindow>({
  createWindow: () => createContentWindow('inspector'),
  allWindows: () => BrowserWindow.getAllWindows(),
  isDestroyed: (win) => win.isDestroyed(),
  isLoading: (win) => win.webContents.isLoading(),
  onClosed: (win, listener) => win.once('closed', listener),
  onDidFinishLoad: (win, listener) => win.webContents.on('did-finish-load', listener),
  send: (win, name, payload) => win.webContents.send(name, payload),
  close: (win) => win.close(),
  requestAttention: (win) =>
    requestNativeWindowAttention(win, {
      packaged: app.isPackaged,
      harness: process.env['OVERLOOK_E2E'],
      mode: process.env['OVERLOOK_E2E_WINDOW'],
    }),
});

export function openInspectorWindow(state: InspectorWindowState): void {
  inspectorController.open(state);
}

export function updateInspectorWindow(state: InspectorWindowState): void {
  inspectorController.update(state);
}

export function closeInspectorWindow(): void {
  inspectorController.close();
}

export function inspectorWindowSnapshot(): InspectorWindowState {
  return inspectorController.snapshot();
}

export function isInspectorWindow(win: BrowserWindow): boolean {
  return inspectorController.isInspectorWindow(win);
}

function createContentWindow(surface: 'primary' | 'inspector'): BrowserWindow {
  const devIcon = app.isPackaged ? undefined : path.join(import.meta.dirname, '../../build/icon.png');
  if (devIcon !== undefined && process.platform === 'darwin') app.dock?.setIcon(devIcon);
  const windowBehavior = initialWindowBehavior({
    packaged: app.isPackaged,
    harness: process.env['OVERLOOK_E2E'],
    mode: process.env['OVERLOOK_E2E_WINDOW'],
  });
  const win = new BrowserWindow({
    ...(devIcon !== undefined && process.platform !== 'darwin' ? { icon: devIcon } : {}),
    width: surface === 'inspector' ? 360 : 1280,
    height: surface === 'inspector' ? 720 : 800,
    minWidth: surface === 'inspector' ? 320 : 960,
    minHeight: surface === 'inspector' ? 480 : 600,
    ...(surface === 'inspector' ? { title: 'Inspector' } : {}),
    backgroundColor: windowBackgroundColor,
    show: windowBehavior.show,
    ...(surface === 'inspector' ? {} : process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: windowBehavior.backgroundThrottling,
    },
  });
  const emitFocusChanged = createEmitter(events.focusChanged, (name, payload) => win.webContents.send(name, payload));
  installWindowNavigationPolicy(win.webContents);
  win.on('focus', () => emitFocusChanged({ focused: true }));
  win.on('blur', () => emitFocusChanged({ focused: false }));
  if (surface === 'primary') win.once('closed', closeInspectorWindow);
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl !== undefined) {
    const url = new URL(devServerUrl);
    if (surface === 'inspector') url.searchParams.set('surface', 'inspector');
    url.searchParams.set('theme', windowAppearance);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), {
      query: {
        ...(surface === 'inspector' ? { surface: 'inspector' } : {}),
        theme: windowAppearance,
      },
    });
  }
  return win;
}

export function registerWindowAllClosedQuit(): void {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

export function relaunchLocked(): void {
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.relaunch();
  app.exit(0);
}

/** Destroy the current document so decoded media and stale renderer state
 * cannot survive a lock transition. The replacement document boots only the
 * locking/locked surface because main-process authority is already revoked. */
export function reloadContentWindowsForLock(): Promise<void> {
  const contents = BrowserWindow.getAllWindows().map((win) => win.webContents as unknown as ThemedReloadableWebContents);
  return reloadWebContentsForLock(contents, (target) => {
    void target.loadURL(withAppearanceBootstrapQuery(target.getURL(), windowAppearance)).catch(() => undefined);
  });
}
