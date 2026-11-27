import { app } from 'electron';
import type { EphemeralOriginalService } from './backup/ephemeral-originals.js';
import { PhotosRepository } from './db/photos-repository.js';
import { createExportFacade } from './export/export-facade-factory.js';
import type { DrainableExportFacade } from './export/export-runtime.js';
import type { LibraryParts } from './library/library-parts.js';
import { createNativeDragBridge } from './native-drag/native-drag-bridge.js';
import { NativeDragOutService } from './native-drag/native-drag-service.js';
import { TestNativeDragBridge } from './native-drag/test-native-drag-bridge.js';
import type { ImportService } from './import/import-service.js';
import { createPhotoKitBridge } from './photo-kit/photo-kit-bridge.js';
import { PhotoKitService } from './photo-kit/photo-kit-service.js';
import { TestPhotoKitBridge } from './photo-kit/test-photo-kit-bridge.js';
import { cleanupPhotoKitStage } from './photo-kit/photo-kit-staging.js';
import { pickExportDestination } from './export/export-destination.js';
import { applicationEvents } from './application-events.js';
import type { FileProviderService } from './file-provider/file-provider-service.js';
import { createFileProviderService } from './file-provider/file-provider-runtime-factory.js';
import type { ActivityFacade } from './activity/activity-publication.js';
import { createDisclosureService } from './disclosure/disclosure-factory.js';
import type { DisclosureService } from './disclosure/disclosure-service.js';

export interface EgressRuntimeOptions {
  readonly parts: () => LibraryParts;
  readonly ephemeral: () => EphemeralOriginalService;
  readonly imports: () => ImportService;
  readonly dataDir: () => string;
  readonly harnessEnv: (name: string) => string | undefined;
  readonly unlocked: () => boolean;
  readonly library: () => { readonly id: string; readonly name: string };
  /** Activity history for disclosure-policy changes (#509), by field name only. */
  readonly activity: () => ActivityFacade | undefined;
}

export class EgressRuntime {
  private exportFacade: DrainableExportFacade | undefined;
  private dragOut: NativeDragOutService | undefined;
  private photoKitService: PhotoKitService | undefined;
  private fileProviderService: FileProviderService | undefined;
  private fileProviderClose: Promise<void> = Promise.resolve();
  private disclosureService: DisclosureService | undefined;

  constructor(private readonly options: EgressRuntimeOptions) {}

  activateLibrary(openLibrary: () => unknown): void {
    openLibrary();
    this.fileProvider();
  }

  exports(): DrainableExportFacade {
    const parts = this.options.parts();
    this.exportFacade ??= createExportFacade({
      db: parts.db,
      blobStore: parts.blobStore,
      resolveKey: parts.keyStore.resolver(),
      ephemeral: this.options.ephemeral,
      pickDestination: () => pickExportDestination(this.options.harnessEnv),
      progress: (done, total) => applicationEvents.exportProgress({ done, total }),
      disclosure: (photoId, intent) => this.disclosure().plan(photoId, 'export', intent.destination, intent.operation),
    });
    return this.exportFacade;
  }

  nativeDrag(): NativeDragOutService {
    if (this.dragOut !== undefined) return this.dragOut;
    const parts = this.options.parts();
    const repo = new PhotosRepository(parts.db);
    const testDestination = this.options.harnessEnv('OVERLOOK_NATIVE_DRAG_DESTINATION');
    this.dragOut = new NativeDragOutService({
      bridge:
        testDestination === undefined
          ? createNativeDragBridge({ platform: process.platform, packaged: app.isPackaged, enabled: false })
          : new TestNativeDragBridge(testDestination),
      getPhoto: (photoId) => repo.get(photoId),
      isMigrating: (photoId) => repo.isInProtectedMigration(photoId),
      openOriginal: async (photo, _signal) => {
        const service = this.options.ephemeral();
        const opened = await service.open(photo.id, 'export');
        return { stream: opened.stream, release: opened.custody === 'ephemeral' ? () => service.release(photo.id, 'export') : undefined };
      },
      admit: () => this.options.unlocked() && this.options.parts() === parts,
    });
    return this.dragOut;
  }

  photoKit(): PhotoKitService {
    if (this.photoKitService !== undefined) return this.photoKitService;
    const parts = this.options.parts();
    const repo = new PhotosRepository(parts.db);
    const fixtureImport = this.options.harnessEnv('OVERLOOK_PHOTOKIT_IMPORT_SOURCE');
    const fixtureExport = this.options.harnessEnv('OVERLOOK_PHOTOKIT_EXPORT_DESTINATION');
    this.photoKitService = new PhotoKitService({
      disclosure: {
        plan: (photoId, boundary, destination, operation) => this.disclosure().plan(photoId, boundary, destination, operation),
      },
      bridge:
        fixtureImport !== undefined || fixtureExport !== undefined
          ? new TestPhotoKitBridge(fixtureImport, fixtureExport)
          : createPhotoKitBridge({ platform: process.platform, packaged: app.isPackaged }),
      dataDir: this.options.dataDir(),
      getPhoto: (photoId) => repo.get(photoId),
      openOriginal: async (photo) => {
        const service = this.options.ephemeral();
        const opened = await service.open(photo.id, 'export');
        return { stream: opened.stream, release: opened.custody === 'ephemeral' ? () => service.release(photo.id, 'export') : undefined };
      },
      importFiles: (assets, cleanupPath, onJournaled) =>
        this.options
          .imports()
          .runPhotoKitFiles(assets, cleanupPath, onJournaled, () => cleanupPhotoKitStage(this.options.dataDir(), cleanupPath)),
      cancelImport: () => this.options.imports().cancel(),
      admit: () => this.options.unlocked() && this.options.parts() === parts,
      progress: applicationEvents.photoKitProgress,
    });
    return this.photoKitService;
  }

  fileProvider(): FileProviderService {
    if (this.fileProviderService !== undefined) return this.fileProviderService;
    const parts = this.options.parts();
    const service = createFileProviderService({
      parts,
      currentParts: this.options.parts,
      ephemeral: this.options.ephemeral,
      dataDir: this.options.dataDir(),
      harnessEnv: this.options.harnessEnv,
      unlocked: this.options.unlocked,
      library: this.options.library(),
      platform: process.platform,
      packaged: app.isPackaged,
      onLibraryChanged: applicationEvents.onLibraryChanged,
      disclosure: {
        plan: (photoId, boundary, destination, operation) => this.disclosure().plan(photoId, boundary, destination, operation),
      },
    });
    this.fileProviderService = service;
    void service.reconcile().catch(() => undefined);
    return service;
  }

  /** ADR-0032 §6 policy every egress surface compiles its plan from (#509).
   * Fails closed: with no open library there is no policy and no crossing. */
  disclosure(): DisclosureService {
    const parts = this.options.parts();
    this.disclosureService ??= createDisclosureService({
      db: parts.db,
      activity: this.options.activity,
      blobStore: parts.blobStore,
      resolveKey: parts.keyStore.resolver(),
    });
    return this.disclosureService;
  }

  close(): void {
    this.exportFacade?.close();
    this.dragOut?.close();
    this.photoKitService?.close();
    this.fileProviderClose = this.fileProviderService?.close() ?? Promise.resolve();
  }

  drain(): Promise<void> {
    return Promise.all([
      this.exportFacade?.drain() ?? Promise.resolve(),
      this.dragOut?.drain() ?? Promise.resolve(),
      this.photoKitService?.drain() ?? Promise.resolve(),
      this.fileProviderClose,
    ]).then(() => undefined);
  }

  reset(): void {
    this.exportFacade = undefined;
    this.dragOut = undefined;
    this.photoKitService = undefined;
    this.fileProviderService = undefined;
    this.fileProviderClose = Promise.resolve();
    this.disclosureService = undefined;
  }
}
