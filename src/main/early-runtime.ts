import { app, BrowserWindow, ipcMain, session } from 'electron';

import { isInspectorWindow } from './app-window.js';
import { registerDiagnosticsLifecycle } from './diagnostics/diagnostics-runtime.js';
import { installIpcSenderGuard } from './ipc-sender-guard.js';
import { installDenyAllPermissionRequestHandler } from './permission-policy.js';
import { registerSchemePrivileges } from './protocol-privileges.js';

/** Pre-window process wiring that must be installed before app readiness. */
export function registerEarlyRuntime(): void {
  installIpcSenderGuard(ipcMain, {
    isInspectorSender: (event) => {
      const win = event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
      return win !== null && isInspectorWindow(win);
    },
  });
  registerSchemePrivileges();
  registerDiagnosticsLifecycle();
  app.once('ready', () => {
    installDenyAllPermissionRequestHandler(session.defaultSession);
  });
}
