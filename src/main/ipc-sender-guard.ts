import { channels } from '../shared/ipc/channels.js';
import type { IpcFailureEnvelope, IpcHandlerRegistrar } from '../shared/ipc/registry.js';

export const DETACHED_INSPECTOR_ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
  channels.ping.name,
  channels.getPlatform.name,
  channels.getLocale.name,
  channels.settingsGet.name,
  channels.themeActive.name,
  channels.appLockStatus.name,
  channels.appLockUnlock.name,
  channels.appLockTouchIdStatus.name,
  channels.appLockTouchIdUnlock.name,
  channels.libraryCustody.name,
  channels.restoreProfileStatus.name,
  channels.commandRendererReady.name,
  channels.commandContextUpdate.name,
  channels.libraryRegistryList.name,
  channels.libraryRegistryCurrent.name,
  channels.libraryRegistryOpen.name,
  channels.inspectorWindowSnapshot.name,
  channels.inspectorWindowStep.name,
  channels.clipboardWrite.name,
  channels.libraryGet.name,
  channels.libraryMetadataSummary.name,
  channels.libraryMetadataUpdate.name,
  channels.libraryTagSuggestions.name,
  channels.libraryTagManage.name,
  channels.backupPhotoCustodyStatus.name,
  channels.photoEditHead.name,
  channels.photoHistogram.name,
  channels.photoProvenance.name,
  channels.photoProvenanceRefresh.name,
  channels.photoVariants.name,
  channels.photoDuplicate.name,
  channels.photoPromoteVariant.name,
  channels.photoRepair.name,
  channels.photoRecoverOriginal.name,
  channels.windowClose.name,
  channels.windowMinimize.name,
  channels.windowToggleMaximize.name,
]);

export interface IpcSenderEventLike {
  readonly sender?: { readonly mainFrame?: unknown } | null;
  readonly senderFrame?: unknown;
}

export interface IpcSenderGuardOptions<TEvent extends IpcSenderEventLike = IpcSenderEventLike> {
  readonly isInspectorSender: (event: TEvent) => boolean;
  readonly reportBlocked?: (channelName: string, reason: 'subframe' | 'inspector-channel') => void;
}

const UNAUTHORIZED_FAILURE: IpcFailureEnvelope = {
  __overlookIpcFailure: true,
  error: { code: 'IPC_HANDLER_FAILED' },
};

export function isTrustedMainFrameEvent(event: IpcSenderEventLike): boolean {
  const mainFrame = event.sender?.mainFrame;
  if (mainFrame === undefined || mainFrame === null) return false;
  if (event.senderFrame === undefined || event.senderFrame === null) return false;
  return event.senderFrame === mainFrame;
}

function defaultReportBlocked(channelName: string, reason: 'subframe' | 'inspector-channel'): void {
  console.error(`[overlook] IPC_UNAUTHORIZED_SENDER (${reason}) on ${channelName}`);
}

export function createGuardedIpcRegistrar<TEvent extends IpcSenderEventLike = IpcSenderEventLike>(
  target: IpcHandlerRegistrar,
  options: IpcSenderGuardOptions<TEvent>,
): IpcHandlerRegistrar {
  const report = options.reportBlocked ?? defaultReportBlocked;
  return {
    handle(channelName, handler) {
      target.handle(channelName, (rawEvent, request) => {
        const event = (typeof rawEvent === 'object' && rawEvent !== null ? rawEvent : {}) as TEvent;
        if (!isTrustedMainFrameEvent(event)) {
          report(channelName, 'subframe');
          return UNAUTHORIZED_FAILURE;
        }
        if (options.isInspectorSender(event) && !DETACHED_INSPECTOR_ALLOWED_CHANNELS.has(channelName)) {
          report(channelName, 'inspector-channel');
          return UNAUTHORIZED_FAILURE;
        }
        return handler(rawEvent, request);
      });
    },
  };
}

const guardedTargets = new WeakSet<object>();

export function installIpcSenderGuard<TEvent extends IpcSenderEventLike>(
  ipcMainTarget: { handle: (channel: string, listener: (event: TEvent, ...args: unknown[]) => unknown) => void },
  options: IpcSenderGuardOptions<TEvent>,
): void {
  if (guardedTargets.has(ipcMainTarget)) return;
  guardedTargets.add(ipcMainTarget);
  const originalHandle = ipcMainTarget.handle.bind(ipcMainTarget);
  const guarded = createGuardedIpcRegistrar(
    {
      handle(channel, handler) {
        originalHandle(channel, (event, request) => handler(event, request));
      },
    },
    options,
  );
  ipcMainTarget.handle = (channel, listener) => {
    guarded.handle(channel, (event, request) => listener(event as TEvent, request));
  };
}
