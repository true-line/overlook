import electron from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { ActivityFacade } from '../activity/activity-publication.js';
import type { PhotoKitService } from './photo-kit-service.js';
import { authorizeDisclosure, type DisclosureConsentAuthority } from '../disclosure/disclosure-consent.js';

type IpcHandler = (event: unknown, request: unknown) => unknown;

export interface PhotoKitIpcHandlerRegistrar {
  readonly handle: (channel: string, handler: IpcHandler) => void;
}

export function registerPhotoKitHandlersWith(
  getService: () => PhotoKitService,
  admit: () => void,
  registrar: PhotoKitIpcHandlerRegistrar,
  onImported?: () => void,
  getActivity?: () => ActivityFacade,
  consent?: DisclosureConsentAuthority,
): void {
  registrar.handle(channels.photoKitStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitStatus, () => getService().status())(request),
  );
  registrar.handle(channels.photoKitImportReview.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitImportReview, () => {
      admit();
      return getService().reviewImport();
    })(request),
  );
  registrar.handle(channels.photoKitImportRun.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitImportRun, async ({ reviewId, assetIds }) => {
      admit();
      const summary = await getService().runImport(reviewId, assetIds);
      if (summary.imported > 0) onImported?.();
      getActivity?.().record({
        eventType: 'import.completed',
        outcome: summary.failed > 0 || summary.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          source: 'apple-photos',
          mode: 'copy',
          imported: summary.imported,
          duplicates: summary.duplicates,
          failed: summary.failed,
          cancelled: summary.cancelled,
        },
      });
      const { photoIds: _photoIds, moveCompensations: _moveCompensations, ...result } = summary;
      return result;
    })(request),
  );
  registrar.handle(channels.photoKitExportRun.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitExportRun, async ({ photoIds, disclosure }) => {
      admit();
      const authorized = authorizeDisclosure(consent, {
        photoIds,
        boundary: 'photo-kit',
        payload: 'original',
        metadata: 'original',
        disclosure,
      });
      const result = await getService().runExport(photoIds, authorized.disclosure);
      getActivity?.().record({
        eventType: 'photo.exported',
        entityIds: photoIds,
        outcome: result.failed > 0 || result.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          destination: 'apple-photos',
          format: 'original',
          metadata: 'embedded-supported',
          disclosureDestination: disclosure?.destination ?? 'shared',
          disclosureWidened: authorized.disclosure?.operation.widen.join(',') ?? '',
          disclosureNarrowed: authorized.disclosure?.operation.narrow.join(',') ?? '',
          exported: result.exported,
          failed: result.failed,
          cancelled: result.cancelled,
        },
      });
      return { ...result, failures: [...result.failures] };
    })(request),
  );
  registrar.handle(channels.photoKitCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitCancel, () => {
      getService().cancel();
      return {};
    })(request),
  );
}

export function registerPhotoKitHandlers(
  getService: () => PhotoKitService,
  admit: () => void,
  onImported?: () => void,
  getActivity?: () => ActivityFacade,
  consent?: DisclosureConsentAuthority,
): void {
  registerPhotoKitHandlersWith(getService, admit, electron.ipcMain, onImported, getActivity, consent);
}
