import type { IpcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import type { wrapHandler as validatedHandler } from '../../shared/ipc/registry.js';
import type { ExportDisclosureIntentWire } from '../../shared/ipc/export-channels.js';
import type { ActivityFacade } from '../activity/activity-publication.js';
import type { ExportFacade } from '../ipc.js';
import type { ExportDestinationAuthority } from './export-destination-authority.js';
import { authorizeDisclosure, type DisclosureConsentAuthority } from '../disclosure/disclosure-consent.js';

/** ADR-0032 §6: consent at operation scope is recorded by field NAME only. */
function disclosurePayload(disclosure: ExportDisclosureIntentWire | undefined): {
  readonly disclosureDestination: string;
  readonly disclosureWidened: string;
  readonly disclosureNarrowed: string;
} {
  return {
    disclosureDestination: disclosure?.destination ?? 'shared',
    disclosureWidened: disclosure?.operation.widen.join(',') ?? '',
    disclosureNarrowed: disclosure?.operation.narrow.join(',') ?? '',
  };
}

export function registerExportHandlersWith(
  getFacade: () => ExportFacade,
  getActivity: (() => ActivityFacade) | undefined,
  destinationAuthority: ExportDestinationAuthority,
  consent: DisclosureConsentAuthority | undefined,
  registrar: Pick<IpcMain, 'handle'>,
  wrapHandler: typeof validatedHandler,
): void {
  registrar.handle(channels.exportRun.name, (event, request: unknown) =>
    wrapHandler(channels.exportRun, async ({ photoIds, authorization, format, metadata, mode, quality, disclosure }) => {
      const authorized = authorizeDisclosure(consent, {
        photoIds,
        boundary: 'export',
        payload: (mode ?? (format === 'jpeg' ? 'baked' : 'original-sidecars')) === 'baked' ? 'baked' : 'original',
        mode: mode ?? (format === 'jpeg' ? 'baked' : 'original-sidecars'),
        metadata,
        disclosure,
      });
      const destination = destinationAuthority.consume(
        event.sender.id,
        { operation: 'selected', photoIds, format, metadata, mode, quality, disclosure },
        authorization,
      );
      const result = await getFacade().run(
        authorized.photoIds ?? photoIds,
        destination,
        format,
        metadata,
        { mode, quality },
        authorized.disclosure,
      );
      const { failures: _failures, ...summary } = result;
      getActivity?.().record({
        eventType: 'photo.exported',
        entityIds: photoIds,
        outcome: result.failed > 0 || result.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          format: format ?? 'original',
          metadata: metadata ?? 'original',
          mode: mode ?? null,
          ...disclosurePayload(authorized.disclosure),
          ...summary,
        },
      });
      return result;
    })(request),
  );
  registrar.handle(channels.exportRunAll.name, (event, request: unknown) =>
    wrapHandler(channels.exportRunAll, async ({ authorization, metadata, mode, quality, disclosure }) => {
      const authorized = authorizeDisclosure(consent, {
        boundary: 'export',
        payload: mode === 'baked' ? 'baked' : 'original',
        mode: mode ?? 'original-sidecars',
        metadata,
        disclosure,
      });
      const destination = destinationAuthority.consume(
        event.sender.id,
        { operation: 'all', metadata, mode, quality, disclosure },
        authorization,
      );
      const result =
        authorized.photoIds === undefined
          ? await getFacade().runAll(destination, metadata, { mode, quality }, authorized.disclosure)
          : await getFacade().run(
              authorized.photoIds,
              destination,
              mode === 'baked' ? 'jpeg' : 'original',
              metadata,
              { mode, quality },
              authorized.disclosure,
            );
      const { failures: _failures, ...summary } = result;
      getActivity?.().record({
        eventType: 'photo.exported',
        entityIds: [],
        outcome: result.failed > 0 || result.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          format: mode === 'baked' ? 'jpeg' : 'original',
          metadata: metadata ?? 'original',
          mode: mode ?? null,
          scope: 'all',
          ...disclosurePayload(authorized.disclosure),
          ...summary,
        },
      });
      return result;
    })(request),
  );
  registrar.handle(channels.exportRunBoard.name, (event, request: unknown) =>
    wrapHandler(channels.exportRunBoard, async ({ authorization, ...input }) => {
      const destination = destinationAuthority.consume(event.sender.id, { operation: 'board', request: input }, authorization);
      const result = await getFacade().runBoard({ ...input, destination });
      getActivity?.().record({
        eventType: 'photo.exported',
        entityIds: input.board.placements.map((placement) => placement.photoId),
        outcome: result.cancelled || result.skipped > 0 ? 'partial' : 'succeeded',
        payload: {
          scope: 'moodboard',
          boardId: input.board.id,
          colorSpace: input.colorSpace,
          width: input.output.width,
          height: input.output.height,
          rendered: result.rendered,
          skipped: result.skipped,
        },
      });
      return result;
    })(request),
  );
  registrar.handle(channels.exportCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.exportCancel, () => {
      getFacade().cancel();
      return {};
    })(request),
  );
  registrar.handle(channels.exportPreflight.name, (_event, request: unknown) =>
    wrapHandler(channels.exportPreflight, async ({ photoIds, mode }) => {
      const report = await getFacade().preflight(photoIds ?? null, mode);
      return { edited: report.edited, losses: [...report.losses] };
    })(request),
  );
  registrar.handle(channels.exportPickDestination.name, (event, request: unknown) =>
    wrapHandler(channels.exportPickDestination, async ({ intent }) => {
      const path = await getFacade().pickDestination();
      return {
        path,
        authorization: path === null ? null : destinationAuthority.issue(event.sender.id, intent, path),
      };
    })(request),
  );
  registrar.handle(channels.exportRevokeDestination.name, (event, request: unknown) =>
    wrapHandler(channels.exportRevokeDestination, ({ authorization }) => ({
      revoked: destinationAuthority.revoke(event.sender.id, authorization),
    }))(request),
  );
}
