import { registerPhotoRepairHandlers } from './library/photo-repair-ipc.js';
import type { RawRepairService } from './import/raw-repair-service.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';

import { events } from '../shared/ipc/channels.js';
import { destructiveActions } from '../shared/destructive-actions.js';
import { createEmitter } from '../shared/ipc/registry.js';
import { createBackupFacade, type BackupFacadeOptions } from './backup/backup-facade.js';
import type { FullService } from './fullres/full-service.js';
import { registerFullProtocol } from './fullres/full-protocol.js';
import type { ImportService } from './import/import-service.js';
import { ulid } from './import/ulid.js';
import type { KeyStore } from './crypto/keystore.js';
import { createLibraryMasterBackup } from './crypto/library-master-native.js';
import { installLibraryMasterBackup } from './crypto/library-master-port.js';
import { registerCustodyHandlers } from './library/custody-ipc.js';
import { readProbedLibraryCustody } from './library/library-custody.js';
import { createRecoveryKeyFacade } from './crypto/recovery-key-facade.js';
import { pickRecoveryKeyPath } from './crypto/recovery-key-picker.js';
import type { DrainableExportFacade } from './export/export-runtime.js';
import { ExportDestinationAuthority } from './export/export-destination-authority.js';
import type { ActivityFacade } from './activity/activity-publication.js';
import type { HistoryService } from './history/history-service.js';
import {
  registerAlbumHandlers,
  registerBoardHandlers,
  registerBackupHandlers,
  registerDiagnosticsHandlers,
  registerExportHandlers,
  registerImportHandlers,
  registerKeysHandlers,
  registerLibraryHandlers,
  registerLibraryRegistryHandlers,
  type LibraryRegistryFacade,
  registerProtectedAlbumHandlers,
  registerPurgeHandlers,
  registerRestoreHandlers,
  registerSettingsHandlers,
} from './ipc.js';
import { registerOriginalPolicyHandlers } from './library/original-deletion-ipc.js';
import { registerLlmHandlers } from './llm/llm-ipc.js';
import { getLlmFacade } from './llm/llm-runtime.js';
import { registerActivityHandlers } from './activity/activity-ipc.js';
import { registerHistoryHandlers } from './history/history-ipc.js';
import type { LibraryService } from './library/library-service.js';
import type { DrainablePurgeFacade } from './library/purge-runtime.js';
import type { ProtectedRuntime } from './library/protected-runtime.js';
import { createRestoreFacade } from './backup/restore-facade.js';
import type { RestoreRuntime } from './backup/restore-runtime.js';
import { getSettingsStore } from './settings/settings-runtime.js';
import { registerThumbProtocol } from './thumbs/thumb-protocol.js';
import type { ThumbService } from './thumbs/thumb-service.js';
import { getDiagnosticsService } from './diagnostics/diagnostics-runtime.js';
import { OriginalDeletionService } from './library/original-deletion-service.js';
import type { AppLockState, AppAuthorizationResult } from './crypto/app-lock-controller.js';
import { registerInboundMoveHandlers } from './interop/inbound-move-ipc.js';
import { getProductionInboundMoveController } from './interop/inbound-move-production.js';
import { registerEmbeddingHandlers } from './embedding/embedding-ipc.js';
import type { EmbeddingService } from './embedding/embedding-service.js';
import type { NativeDragOutService } from './native-drag/native-drag-service.js';
import { registerNativeDragHandlers } from './native-drag/native-drag-ipc.js';
import type { PhotoKitService } from './photo-kit/photo-kit-service.js';
import { registerPhotoKitHandlers } from './photo-kit/photo-kit-ipc.js';
import type { FileProviderService } from './file-provider/file-provider-service.js';
import { registerFileProviderHandlers } from './file-provider/file-provider-ipc.js';
import { EMBEDDING_DIMENSIONS } from './db/embedding-repository.js';
import type { SemanticEmbeddingFacade } from './library/semantic-search.js';
import { registerPhotoEditHandlers } from './library/photo-edit-ipc.js';
import type { PhotoEditService } from './library/photo-edit-service.js';
import { registerProvenanceHandlers } from './library/provenance-ipc.js';
import type { ProvenanceService } from './library/provenance-service.js';
import { registerVariantHandlers } from './library/variant-ipc.js';
import { registerHistogramHandlers } from './library/histogram-ipc.js';
import { registerDuplicateHandlers } from './library/duplicate-ipc.js';
import { registerCoverageHandlers } from './backup/coverage-ipc.js';
import { registerKeyringHandlers } from './crypto/keyring-ipc.js';
import { registerDisclosureHandlers } from './disclosure/disclosure-ipc.js';
import type { DisclosureService } from './disclosure/disclosure-service.js';
import type { KeyringService } from './crypto/keyring-service.js';
import type { CoverageService } from './backup/coverage-service.js';
import type { DuplicateIndexService } from './library/duplicate-index-service.js';
import type { HistogramService } from './library/histogram-service.js';
import type { VariantService } from './library/variant-service.js';
import { registerOriginalRecoveryHandlers } from './library/original-recovery-ipc.js';
import type { OriginalRecoveryService } from './library/original-recovery-service.js';

export interface AppServicesOptions {
  readonly getOriginalRecovery: () => OriginalRecoveryService;
  readonly dataDir: () => string;
  readonly libraryOpen: () => boolean;
  readonly harnessEnv: (name: string) => string | undefined;
  readonly requireContentAccess: () => void;
  readonly allowKeyImport: () => boolean;
  readonly onRecoveryKeyExported?: (() => void) | undefined;
  readonly onRecoveryKeyImported?: (() => void) | undefined;
  readonly getLibrary: () => LibraryService;
  readonly getPhotoRepair: () => Pick<RawRepairService, 'repairPhoto'>;
  readonly getActivity: () => ActivityFacade;
  readonly getHistory: () => HistoryService;
  readonly libraries: LibraryRegistryFacade;
  readonly getProtected: () => ProtectedRuntime;
  readonly getThumbs: () => ThumbService;
  readonly getEdits: () => PhotoEditService;
  readonly getProvenance: () => ProvenanceService;
  readonly getVariants: () => VariantService;
  readonly getHistogram: () => HistogramService;
  readonly getDuplicates: () => DuplicateIndexService;
  readonly getCoverage: () => CoverageService;
  readonly getKeyring: () => KeyringService;
  readonly getDisclosure: () => DisclosureService;
  readonly getFull: () => FullService;
  readonly getImport: () => ImportService;
  readonly getEmbedding: () => EmbeddingService;
  readonly getExport: () => DrainableExportFacade;
  readonly getNativeDrag: () => NativeDragOutService;
  readonly getPhotoKit: () => PhotoKitService;
  readonly getFileProvider: () => FileProviderService;
  readonly getKeyStore: () => KeyStore;
  readonly safeStorage: Parameters<typeof createRecoveryKeyFacade>[0]['safeStorage'];
  readonly getRestore: () => RestoreRuntime;
  readonly getPurge: () => DrainablePurgeFacade;
  readonly activeLibraryId: () => string;
  readonly authorizationEpoch: () => number;
  readonly lockState: () => AppLockState;
  readonly authorizePassword: (password: string) => Promise<AppAuthorizationResult>;
  readonly backup: BackupFacadeOptions;
  readonly providerBusy: () => boolean;
  readonly pcloudEnabled: boolean;
  readonly liveLocalEnabled: boolean;
  readonly onManifestChanged: () => void;
  readonly onImported: () => void;
  readonly onImportRendererReady: () => void;
  readonly broadcast: (name: string, payload: unknown) => void;
}

function getSearchEmbeddings(options: AppServicesOptions): SemanticEmbeddingFacade {
  const fixtureDimension = options.harnessEnv('OVERLOOK_SEMANTIC_QUERY_DIMENSION');
  if (fixtureDimension === undefined || options.harnessEnv('OVERLOOK_E2E') === undefined) return options.getEmbedding();
  const dimension = Number(fixtureDimension);
  if (!Number.isSafeInteger(dimension) || dimension < 0 || dimension >= EMBEDDING_DIMENSIONS) {
    throw new Error('OVERLOOK_SEMANTIC_QUERY_DIMENSION must identify a vector dimension');
  }
  const service = options.getEmbedding();
  return {
    status: () => service.status(),
    query: () => {
      const embedding = new Int8Array(EMBEDDING_DIMENSIONS);
      embedding[dimension] = 127;
      return Promise.resolve({ embedding, fallback: null });
    },
  };
}

async function pickImportFolder(options: AppServicesOptions): Promise<string | null> {
  const fixture = options.harnessEnv('OVERLOOK_IMPORT_FOLDER');
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function confirmImportMove(
  options: AppServicesOptions,
  source: { path?: string | undefined; files?: readonly string[] | undefined },
  parent: BrowserWindow | null,
): Promise<boolean> {
  // Browser tests cannot operate native dialogs; this switch is fixed by the
  // main-process test harness environment and is unavailable to the renderer.
  if (!app.isPackaged && options.harnessEnv('OVERLOOK_E2E') !== undefined) return true;
  if (parent === null) return false;
  const lineBreak = String.fromCharCode(10);
  const sourceDescription = source.path ?? source.files?.join(lineBreak) ?? '';
  const result = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['Cancel', 'Move originals'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Confirm moving originals',
    message: 'Move these originals into Overlook?',
    detail: [
      'Requested source paths:',
      sourceDescription,
      '',
      'The originals will be deleted only after their encrypted copies are verified.',
    ].join(lineBreak),
  });
  return result.response === 1;
}

async function confirmManualPurge(
  options: AppServicesOptions,
  photoIds: readonly string[],
  parent: BrowserWindow | null,
): Promise<boolean> {
  // Browser tests cannot operate native dialogs; this switch is fixed by the
  // main-process test harness environment and is unavailable to the renderer.
  if (!app.isPackaged && options.harnessEnv('OVERLOOK_E2E') !== undefined) return true;
  if (parent === null) return false;
  const count = photoIds.length;
  const noun = count === 1 ? 'photo' : 'photos';
  const action = destructiveActions.deletePhotosPermanently;
  const result = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['Cancel', 'Delete permanently'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Confirm permanent deletion',
    message: `Delete ${String(count)} ${noun} permanently?`,
    detail: `${action.sideEffects} This cannot be undone.`,
  });
  return result.response === 1;
}

async function pickKeyExport(options: AppServicesOptions): Promise<string | null> {
  const fixture = options.harnessEnv('OVERLOOK_KEY_EXPORT_DESTINATION');
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showSaveDialog({ defaultPath: 'overlook-recovery.key' });
  return result.canceled ? null : (result.filePath ?? null);
}

async function pickDiagnosticsExport(options: AppServicesOptions): Promise<string | null> {
  const fixture = options.harnessEnv('OVERLOOK_DIAGNOSTICS_EXPORT_DESTINATION');
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showSaveDialog({ defaultPath: 'overlook-diagnostics.jsonl' });
  return result.canceled ? null : (result.filePath ?? null);
}

export function registerAppServices(options: AppServicesOptions): void {
  installLibraryMasterBackup(createLibraryMasterBackup({ platform: process.platform }));
  registerCustodyHandlers(() => readProbedLibraryCustody(options.libraryOpen(), options.dataDir(), options.safeStorage()));
  registerOriginalRecoveryHandlers(options.getOriginalRecovery, options.requireContentAccess, options.authorizationEpoch, async () => {
    const fixture = options.harnessEnv('OVERLOOK_RECOVER_ORIGINAL_SOURCE');
    if (fixture !== undefined && fixture !== '') return fixture;
    const selected = await dialog.showOpenDialog({ title: 'Recover original', properties: ['openFile'] });
    return selected.canceled ? null : (selected.filePaths[0] ?? null);
  });
  const exportDestinationAuthority = new ExportDestinationAuthority();
  const originalDeletion = new OriginalDeletionService({
    getPhoto: (photoId) => options.getLibrary().get(photoId),
    activeLibraryId: options.activeLibraryId,
    authorizationEpoch: options.authorizationEpoch,
    lockState: options.lockState,
    authorizePassword: options.authorizePassword,
    deletePermanently: (photoIds) => options.getPurge().deletePermanently(photoIds),
  });
  registerLibraryHandlers(options.getLibrary, options.onManifestChanged, options.getActivity, () => getSearchEmbeddings(options));
  registerAlbumHandlers(options.getLibrary, ulid, options.getActivity, options.onManifestChanged);
  registerBoardHandlers(options.getLibrary, options.getActivity, options.onManifestChanged);
  registerPhotoEditHandlers(options.getEdits, options.requireContentAccess, options.getActivity, options.onManifestChanged);
  registerProvenanceHandlers(options.getProvenance, options.requireContentAccess, options.onManifestChanged);
  registerVariantHandlers(options.getVariants, options.requireContentAccess, options.onManifestChanged);
  registerPhotoRepairHandlers(() => {
    const library = options.getLibrary();
    const repair = options.getPhotoRepair();
    const libraryId = options.activeLibraryId();
    const epoch = options.authorizationEpoch();
    return {
      getPhoto: (photoId) => library.get(photoId),
      repairPhoto: (photoId) => repair.repairPhoto(photoId),
      isCurrent: () => options.activeLibraryId() === libraryId && options.authorizationEpoch() === epoch,
    };
  }, options.requireContentAccess);
  registerHistogramHandlers(options.getHistogram, options.requireContentAccess);
  registerDuplicateHandlers(options.getDuplicates, options.requireContentAccess);
  registerActivityHandlers(options.getActivity, options.requireContentAccess);
  registerHistoryHandlers(options.getHistory, options.requireContentAccess);
  registerProtectedAlbumHandlers(
    () => options.getProtected().library,
    () => options.getProtected().exports(),
    () => options.getProtected().workflow,
    () => pickRecoveryKeyPath(options.harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
    readFile,
    exportDestinationAuthority,
  );
  registerThumbProtocol(options.getThumbs, options.requireContentAccess, () => options.getProtected().media());
  registerFullProtocol(options.getFull, options.requireContentAccess, () => options.getProtected().media());
  registerImportHandlers(
    options.getImport,
    () => pickImportFolder(options),
    options.onImported,
    options.onImportRendererReady,
    options.getActivity,
    (source, parent) => confirmImportMove(options, source, parent),
  );
  registerEmbeddingHandlers(options.getEmbedding, options.requireContentAccess);
  registerExportHandlers(options.getExport, options.getActivity, exportDestinationAuthority);
  registerNativeDragHandlers(options.getNativeDrag, options.requireContentAccess);
  registerPhotoKitHandlers(options.getPhotoKit, options.requireContentAccess, options.onImported, options.getActivity);
  registerFileProviderHandlers(options.getFileProvider, options.requireContentAccess);
  registerKeysHandlers(() =>
    createRecoveryKeyFacade({
      keyStore: options.getKeyStore,
      safeStorage: options.safeStorage,
      dataDir: options.dataDir,
      allowImport: options.allowKeyImport,
      pickExportDestination: () => pickKeyExport(options),
      pickImportSource: () => pickRecoveryKeyPath(options.harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
      onExported: options.onRecoveryKeyExported,
      onImported: options.onRecoveryKeyImported,
    }),
  );
  registerRestoreHandlers(() =>
    createRestoreFacade({
      coordinator: () => options.getRestore().coordinator,
      fresh: () => !existsSync(path.join(options.dataDir(), 'library.db')),
      pickKey: () => pickRecoveryKeyPath(options.harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
      busy: options.providerBusy,
      lockState: options.lockState,
      authorizePassword: options.authorizePassword,
      recordDiagnostic: (occurrence) => getDiagnosticsService().record(occurrence),
    }),
  );
  registerPurgeHandlers(
    () => ({ purge: (photoIds) => options.getPurge().purge(photoIds) }),
    (photoIds, parent) => confirmManualPurge(options, photoIds, parent),
    options.getActivity,
  );
  registerOriginalPolicyHandlers(options.getLibrary, () => originalDeletion);
  registerLibraryRegistryHandlers(
    () => options.libraries,
    () => {
      const state = options.lockState();
      return state === 'unconfigured-unlocked' || state === 'unlocked' ? null : options.activeLibraryId();
    },
  );
  registerSettingsHandlers(() => getSettingsStore());
  registerLlmHandlers(getLlmFacade);
  registerDiagnosticsHandlers(getDiagnosticsService, () => pickDiagnosticsExport(options));
  const emitSettingsChanged = createEmitter(events.settingsChanged, options.broadcast);
  getSettingsStore().subscribe((settings) => emitSettingsChanged({ settings }));
  registerBackupHandlers(() => createBackupFacade(options.backup));
  registerKeyringHandlers(options.getKeyring, options.requireContentAccess);
  registerDisclosureHandlers(options.getDisclosure, options.requireContentAccess);
  registerCoverageHandlers(options.getCoverage, options.requireContentAccess, async (operation) => {
    options.backup.workChanged(1);
    try {
      return await operation();
    } finally {
      options.backup.workChanged(-1);
    }
  });
  if (options.pcloudEnabled || options.liveLocalEnabled) {
    registerInboundMoveHandlers(getProductionInboundMoveController, options.requireContentAccess);
  }
}
