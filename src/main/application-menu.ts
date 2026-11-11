import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';

import { createWindow, isInspectorWindow } from './app-window.js';
import { requestNativeWindowAttention } from './e2e-window-visibility.js';
import { buildApplicationMenuTemplate, commandEnabled } from './application-menu-model.js';
import { channels, events } from '../shared/ipc/channels.js';
import { HELP_URL } from '../shared/commands/help-menu.js';
import { commandById, type CommandId, type CommandPlatform } from '../shared/commands/registry.js';
import { EMPTY_COMMAND_MENU_CONTEXT, type CommandMenuContext } from '../shared/commands/menu-contract.js';
import { createEmitter, wrapHandler } from '../shared/ipc/registry.js';
import { createMenuTranslator } from './i18n/menu-intl.js';
import type { AppLockControllerLike } from './crypto/app-lock-host.js';
import { getSettingsStore } from './settings/settings-runtime.js';
import { resolveActiveLocale } from './i18n/locale-resolver.js';

interface RendererCommandState {
  ready: boolean;
  context: CommandMenuContext;
  pending: CommandId | null;
}

export interface ApplicationMenuOptions {
  readonly lockState: () => string;
  readonly lockNow: () => Promise<unknown>;
  readonly subscribeLock: (listener: () => void) => () => void;
  readonly providerBusy: () => boolean;
  readonly locale: () => string;
  readonly resetAppearance: () => void;
}

function commandPlatform(): CommandPlatform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

function isAuthorized(state: string): boolean {
  return state === 'unconfigured-unlocked' || state === 'unlocked';
}

export class ApplicationMenuController {
  private readonly renderers = new Map<number, RendererCommandState>();

  constructor(private readonly options: ApplicationMenuOptions) {}

  install(): void {
    ipcMain.handle(channels.commandRendererReady.name, (event, request: unknown) =>
      wrapHandler(channels.commandRendererReady, (context) => {
        this.setRendererState(event.sender.id, context, true);
        this.flush(event.sender.id, event.sender.send.bind(event.sender));
        return {};
      })(request),
    );
    ipcMain.handle(channels.commandContextUpdate.name, (event, request: unknown) =>
      wrapHandler(channels.commandContextUpdate, (context) => {
        this.setRendererState(event.sender.id, context, true);
        return {};
      })(request),
    );
    ipcMain.handle(channels.helpOpen.name, (_event, request: unknown) =>
      wrapHandler(channels.helpOpen, () => {
        void shell.openExternal(HELP_URL);
        return {};
      })(request),
    );
    app.on('web-contents-created', (_event, contents) => {
      contents.on('did-start-loading', () => {
        const current = this.renderers.get(contents.id);
        this.renderers.set(contents.id, {
          ready: false,
          context: current?.context ?? this.defaultContext(),
          pending: current?.pending ?? null,
        });
        this.refresh();
      });
      contents.on('destroyed', () => {
        this.renderers.delete(contents.id);
        this.refresh();
      });
    });
    app.on('browser-window-focus', () => this.refresh());
    this.options.subscribeLock(() => this.refresh());
    this.refresh();
  }

  stateChanged(): void {
    this.refresh();
  }

  private defaultContext(): CommandMenuContext {
    return {
      ...EMPTY_COMMAND_MENU_CONTEXT,
      surface: isAuthorized(this.options.lockState()) ? 'onboarding' : 'locked',
      appLockConfigured: this.options.lockState() !== 'unconfigured-unlocked',
      providerBusy: this.options.providerBusy(),
    };
  }

  private activeWindow(): BrowserWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused !== null && !isInspectorWindow(focused)) return focused;
    return BrowserWindow.getAllWindows().find((win) => !isInspectorWindow(win));
  }

  private activeContext(): CommandMenuContext {
    const win = this.activeWindow();
    const context = win === undefined ? this.defaultContext() : (this.renderers.get(win.webContents.id)?.context ?? this.defaultContext());
    return {
      ...context,
      surface: isAuthorized(this.options.lockState()) ? context.surface : 'locked',
      appLockConfigured: this.options.lockState() !== 'unconfigured-unlocked',
      providerBusy: this.options.providerBusy(),
    };
  }

  private refresh(): void {
    if (commandPlatform() !== 'darwin') {
      // Windows/Linux run with no native menu bar (ADR-0024 §5): commands live
      // on the toolbar, sidebar, titlebar, and keyboard, and the two otherwise
      // menu-only Help commands live in the renderer titlebar Help menu.
      Menu.setApplicationMenu(null);
      return;
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenuTemplate(
          commandPlatform(),
          app.name,
          this.activeContext(),
          (id) => this.dispatch(id),
          createMenuTranslator(this.options.locale()),
        ),
      ),
    );
  }

  private setRendererState(id: number, context: CommandMenuContext, ready: boolean): void {
    const current = this.renderers.get(id);
    this.renderers.set(id, { ready, context, pending: current?.pending ?? null });
    const win = this.activeWindow();
    if (win?.webContents.id === id) this.refresh();
  }

  private flush(id: number, send: (name: string, payload: unknown) => void): void {
    const state = this.renderers.get(id);
    if (state?.ready !== true || state.pending === null) return;
    const pending = state.pending;
    state.pending = null;
    createEmitter(events.commandInvoked, send)({ id: pending });
  }

  private dispatch(id: CommandId): void {
    const command = commandById(id);
    if (command.native === undefined) return;
    if (!commandEnabled(id, this.activeContext())) return;
    if (id === 'app.lock.now') {
      if (this.activeContext().appLockConfigured && isAuthorized(this.options.lockState())) void this.options.lockNow();
      return;
    }
    if (id === 'help.open') {
      void shell.openExternal(HELP_URL);
      return;
    }
    if (id === 'view.appearance.reset') {
      this.options.resetAppearance();
      return;
    }

    const win = this.activeWindow() ?? createWindow();
    requestNativeWindowAttention(win, {
      packaged: app.isPackaged,
      harness: process.env['OVERLOOK_E2E'],
      mode: process.env['OVERLOOK_E2E_WINDOW'],
    });
    const current = this.renderers.get(win.webContents.id) ?? {
      ready: false,
      context: this.defaultContext(),
      pending: null,
    };
    this.renderers.set(win.webContents.id, current);
    if (!current.ready) {
      if (command.native.queueable) current.pending = id;
      return;
    }
    createEmitter(events.commandInvoked, (name, payload) => win.webContents.send(name, payload))({ id });
  }
}

let installedController: ApplicationMenuController | undefined;

export function installApplicationMenu(lock: AppLockControllerLike, providerBusy: () => boolean, resetAppearance: () => void): void {
  installedController = new ApplicationMenuController({
    lockState: () => lock.snapshot().state,
    lockNow: () => lock.lock(),
    subscribeLock: (listener) => lock.subscribe(listener),
    providerBusy,
    locale: () => resolveActiveLocale(getSettingsStore().get().language),
    resetAppearance,
  });
  installedController.install();
}

export function refreshApplicationMenu(): void {
  installedController?.stateChanged();
}
