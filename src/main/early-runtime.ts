import { app, BrowserWindow, ipcMain, session } from 'electron';

import { isInspectorWindow } from './app-window.js';
import { registerDiagnosticsLifecycle } from './diagnostics/diagnostics-runtime.js';
import { processExists, processStartIdentity, startE2eOwnerWatchdog } from './e2e-owner-watchdog.js';
import { installIpcSenderGuard } from './ipc-sender-guard.js';
import { installDenyAllPermissionRequestHandler } from './permission-policy.js';
import { registerSchemePrivileges } from './protocol-privileges.js';

/** Pre-window process wiring that must be installed before app readiness. */
export function registerEarlyRuntime(): void {
  // A hard-killed E2E run must not orphan this instance (and its helpers) forever.
  startE2eOwnerWatchdog({
    packaged: app.isPackaged,
    env: process.env,
    parentPid: () => process.ppid,
    isAlive: (pid) => processExists(pid),
    startIdentity: (pid) => processStartIdentity(pid),
    exit: () => app.exit(1),
    schedule: (tick, intervalMs) => setInterval(tick, intervalMs),
  });
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
