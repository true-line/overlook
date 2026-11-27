import electron from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import type { DisclosureService } from './disclosure-service.js';
import type { DisclosureConsentAuthority } from './disclosure-consent.js';

// Disclosure classes over IPC (#509). Every channel admits through the
// app-lock gate first; the renderer only ever sends intent (a field and a
// class, a scope id, an operation) — main compiles the plan.
export function registerDisclosureHandlersWith(
  getService: () => DisclosureService,
  admit: () => void,
  registrar: IpcHandlerRegistrar,
  consent?: DisclosureConsentAuthority,
): void {
  const reportError = ({ channelName, code, error }: { channelName: string; code: string; error: unknown }): void =>
    console.error(`[overlook] ${code} on ${channelName}`, error);
  const options = { reportError };
  registrar.handle(channels.disclosurePolicy.name, (_event, request: unknown) =>
    wrapHandler(
      channels.disclosurePolicy,
      () => {
        admit();
        const service = getService();
        return { policy: service.policy(), pinned: [...service.pinned()] };
      },
      options,
    )(request),
  );
  registrar.handle(channels.disclosureSetField.name, (_event, request: unknown) =>
    wrapHandler(
      channels.disclosureSetField,
      ({ field, class: cls }) => {
        admit();
        return { policy: getService().setField(field, cls) };
      },
      options,
    )(request),
  );
  registrar.handle(channels.disclosureOverrides.name, (_event, request: unknown) =>
    wrapHandler(
      channels.disclosureOverrides,
      ({ scope, id }) => {
        admit();
        return { overrides: [...getService().overrides(scope, id)] };
      },
      options,
    )(request),
  );
  registrar.handle(channels.disclosureSetOverride.name, (_event, request: unknown) =>
    wrapHandler(
      channels.disclosureSetOverride,
      ({ scope, id, field, class: cls }) => {
        admit();
        return { overrides: [...getService().setOverride(scope, id, field, cls)] };
      },
      options,
    )(request),
  );
  registrar.handle(channels.disclosurePreview.name, (_event, request: unknown) =>
    wrapHandler(
      channels.disclosurePreview,
      (preview) => {
        admit();
        return consent === undefined ? getService().preview(preview) : consent.preview(preview);
      },
      options,
    )(request),
  );
}

export function registerDisclosureHandlers(
  getService: () => DisclosureService,
  admit: () => void,
  consent?: DisclosureConsentAuthority,
): void {
  registerDisclosureHandlersWith(getService, admit, electron.ipcMain, consent);
}
