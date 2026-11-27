import { BrowserWindow, ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { NativeDragOutService } from './native-drag-service.js';

export function registerNativeDragHandlers(getService: () => NativeDragOutService, admit: () => void): void {
  ipcMain.handle(channels.nativeDragStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.nativeDragStatus, () => getService().status())(request),
  );
  ipcMain.handle(channels.nativeDragStart.name, (event, request: unknown) =>
    wrapHandler(channels.nativeDragStart, ({ photoIds, sourceAlbumId }) => {
      admit();
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null) return { started: false as const, reason: 'content-unavailable' as const };
      const { withheld, ...result } = getService().start(window.getNativeWindowHandle(), { photoIds, sourceAlbumId });
      return { ...result, ...(withheld === undefined ? {} : { withheld: [...withheld] }) };
    })(request),
  );
}
