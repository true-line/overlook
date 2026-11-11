import { events } from '../shared/ipc/channels.js';
import type { InspectorWindowState } from '../shared/inspector-window-contract.js';

export interface InspectorWindowControllerDependencies<TWindow> {
  createWindow(): TWindow;
  allWindows(): readonly TWindow[];
  isDestroyed(win: TWindow): boolean;
  isLoading(win: TWindow): boolean;
  onClosed(win: TWindow, listener: () => void): void;
  onDidFinishLoad(win: TWindow, listener: () => void): void;
  send(win: TWindow, name: string, payload: unknown): void;
  close(win: TWindow): void;
  requestAttention(win: TWindow): void;
}

export interface InspectorWindowController<TWindow> {
  open(state: InspectorWindowState): void;
  update(state: InspectorWindowState): void;
  close(): void;
  snapshot(): InspectorWindowState;
  isInspectorWindow(win: TWindow): boolean;
}

const initialState: InspectorWindowState = { photoId: null, providerLabel: 'Cloud', selectionPosition: null };

export function createInspectorWindowController<TWindow>(
  dependencies: InspectorWindowControllerDependencies<TWindow>,
): InspectorWindowController<TWindow> {
  let inspectorWindow: TWindow | undefined;
  let inspectorState = initialState;

  const isInspectorWindow = (win: TWindow): boolean => win === inspectorWindow;
  const sendState = (): void => {
    const win = inspectorWindow;
    if (win === undefined || dependencies.isDestroyed(win) || dependencies.isLoading(win)) return;
    dependencies.send(win, events.inspectorWindowChanged.name, inspectorState);
  };

  return {
    open(state) {
      inspectorState = state;
      if (inspectorWindow === undefined || dependencies.isDestroyed(inspectorWindow)) {
        const win = dependencies.createWindow();
        inspectorWindow = win;
        dependencies.onClosed(win, () => {
          if (inspectorWindow !== win) return;
          inspectorWindow = undefined;
          for (const candidate of dependencies.allWindows()) {
            if (candidate !== win) dependencies.send(candidate, events.inspectorWindowClosed.name, {});
          }
        });
        dependencies.onDidFinishLoad(win, sendState);
      } else {
        sendState();
      }
      if (inspectorWindow !== undefined) {
        dependencies.requestAttention(inspectorWindow);
      }
    },
    update(state) {
      inspectorState = state;
      sendState();
    },
    close() {
      if (inspectorWindow !== undefined) dependencies.close(inspectorWindow);
    },
    snapshot() {
      return inspectorState;
    },
    isInspectorWindow,
  };
}
