/* eslint-disable max-lines -- IPC registration is intentionally large */
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';

import { channels } from '../shared/ipc/channels.js';
import type { ExportDisclosureIntentWire } from '../shared/ipc/export-channels.js';
import { resolveActiveLocale } from './i18n/locale-resolver.js';
import { wrapHandler as createValidatedHandler } from '../shared/ipc/registry.js';
import type { HandlerErrorReport } from '../shared/ipc/registry.js';
import type { AppSettings, SettingsPatch } from '../shared/settings/settings.js';
import type { LibraryDescriptor } from '../shared/library/registry.js';
import type { BoardExportRequest, BoardExportResult } from '../shared/moodboard/export-contract.js';
import type { RelocationRuntime } from './library/relocation-runtime.js';
import { RelocationDestinationAuthority, RelocationDestinationGrantError } from './library/relocation-destination-authority.js';
import type {
  ProviderCapacityStatus,
  ProviderConnectionStatus,
  ProviderConnectResult,
  ProviderDescriptor,
} from '../shared/backup/provider-descriptor.js';
import type { EphemeralFailureReason, PhotoCustodyStatus } from '../shared/backup/custody-status.js';
import type {
  RestoreDiscoverResponse,
  RestoreRunResponse,
  RestoreStatusSnapshot,
  RestoreTrashResponse,
  RestoreVerifyResponse,
} from '../shared/backup/restore-contract.js';
import type { ImportService } from './import/import-service.js';
import { requireMoveImportConfirmation, type ImportMoveSource } from './import/import-move-confirmation.js';
import type { LibraryService } from './library/library-service.js';
import type { SemanticEmbeddingFacade } from './library/semantic-search.js';
import type { ProtectedLibraryService } from './library/protected-library-service.js';
import type { ProtectedExportFacade } from './export/protected-export-runtime.js';
import { ExportDestinationAuthority } from './export/export-destination-authority.js';
import type { ProtectedWorkflowService } from './library/protected-workflow-service.js';
import type { OffloadPreflight, OffloadSummary, RestoreOriginalsSummary } from './backup/offload.js';
import type {
  AppLockState,
  AppSettingsMutationResult,
  AppTouchIdUnlockResult,
  AppUnlockResult,
  LockStateSnapshot,
} from './crypto/app-lock-controller.js';
import type { TouchIdEnableResult, TouchIdStatus } from './crypto/touch-id.js';
import type { DiagnosticEvent } from './diagnostics/event-contract.js';
import type { ThemeService } from './theme/theme-service.js';
import { mutateWithActivity } from './activity/activity-publication.js';
import type { ActivityFacade } from './activity/activity-publication.js';
import { moveCompensationCommand, trashCommand } from './history/command-drafts.js';
import { registerAlbumIpcHandlers } from './library/album-ipc.js';
import { registerBoardIpcHandlers } from './library/board-ipc.js';
import { toggleFavoriteWithActivity, toggleFavoritesWithActivity } from './library/favorite-mutation-handler.js';
import { registerPhotoMetadataHandlers } from './library/photo-metadata-ipc.js';
import { purgeAfterAuthorization, type PurgeAuthorizer, type PurgeFacade } from './library/purge-authorization.js';

let contentAdmission = (): void => undefined;

const reportIpcError = ({ channelName, code, error }: HandlerErrorReport): void => {
  console.error(`[overlook] ${code} on ${channelName}`, error);
};

const validateHandler: typeof createValidatedHandler = (channel, handler) =>
  createValidatedHandler(channel, handler, { reportError: reportIpcError });

export function setContentAdmissionGate(gate: () => void): void {
  contentAdmission = gate;
}

const wrapHandler: typeof validateHandler = (channel, handler) =>
  validateHandler(channel, (request) => {
    contentAdmission();
    return handler(request);
  });

export interface AppLockFacade {
  snapshot(): LockStateSnapshot;
  retryAfterMs(): number;
  attemptsRemaining(): number;
  unlock(password: string): Promise<AppUnlockResult>;
  touchIdStatus(): Promise<TouchIdStatus>;
  touchIdUnlock(): Promise<AppTouchIdUnlockResult>;
  touchIdEnable(password: string): Promise<TouchIdEnableResult>;
  touchIdDisable(): Promise<boolean>;
  configure(password: string): Promise<void>;
  lock(): Promise<void>;
  changePassword(currentPassword: string, nextPassword: string): Promise<AppSettingsMutationResult>;
  anchorPolicy(): 'usability' | 'hardened';
  setAnchorPolicy(password: string, policy: 'usability' | 'hardened', confirmedExport: boolean): Promise<AppSettingsMutationResult>;
  remove(password: string): Promise<AppSettingsMutationResult>;
  pickRecovery(): Promise<string | null>;
  recover(
    path: string,
    recoveryPassword: string,
    nextPassword: string,
  ): Promise<{
    recovered: boolean;
    reason: 'invalid' | 'wrong-password' | 'mismatch' | null;
  }>;
}

function lockStatus(facade: AppLockFacade): {
  state: AppLockState;
  libraryId: string | null;
  retryAfterMs: number;
  attemptsRemaining: number;
} {
  return { ...facade.snapshot(), retryAfterMs: facade.retryAfterMs(), attemptsRemaining: facade.attemptsRemaining() };
}

function settingsMutationStatus(result: AppSettingsMutationResult, facade: AppLockFacade) {
  return {
    reason: result.ok ? null : result.reason,
    retryAfterMs: result.ok ? 0 : (result.retryAfterMs ?? facade.retryAfterMs()),
    attemptsRemaining: result.ok ? 3 : (result.attemptsRemaining ?? facade.attemptsRemaining()),
  };
}

export function registerAppLockHandlers(getFacade: () => AppLockFacade): void {
  ipcMain.handle(channels.appLockStatus.name, (_event, request: unknown) =>
    validateHandler(channels.appLockStatus, () => lockStatus(getFacade()))(request),
  );
  ipcMain.handle(channels.appLockUnlock.name, (_event, request: unknown) =>
    validateHandler(channels.appLockUnlock, async ({ password }) => {
      const result = await getFacade().unlock(password);
      return {
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        retryAfterMs: result.ok ? 0 : (result.retryAfterMs ?? getFacade().retryAfterMs()),
        attemptsRemaining: result.ok ? 3 : (result.attemptsRemaining ?? getFacade().attemptsRemaining()),
      };
    })(request),
  );
  ipcMain.handle(channels.appLockConfigure.name, (_event, request: unknown) =>
    validateHandler(channels.appLockConfigure, async ({ password }) => {
      await getFacade().configure(password);
      return lockStatus(getFacade());
    })(request),
  );
  ipcMain.handle(channels.appLockNow.name, (_event, request: unknown) =>
    validateHandler(channels.appLockNow, async () => {
      await getFacade().lock();
      return lockStatus(getFacade());
    })(request),
  );
  ipcMain.handle(channels.appLockChangePassword.name, (_event, request: unknown) =>
    validateHandler(channels.appLockChangePassword, async ({ currentPassword, nextPassword }) => {
      const facade = getFacade();
      const result = await facade.changePassword(currentPassword, nextPassword);
      return { changed: result.ok, ...settingsMutationStatus(result, facade) };
    })(request),
  );
  ipcMain.handle(channels.appLockAnchorPolicyStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.appLockAnchorPolicyStatus, () => ({ policy: getFacade().anchorPolicy() }))(request),
  );
  ipcMain.handle(channels.appLockSetAnchorPolicy.name, (_event, request: unknown) =>
    wrapHandler(channels.appLockSetAnchorPolicy, async ({ password, policy, confirmedExport }) => {
      const facade = getFacade();
      const result = await facade.setAnchorPolicy(password, policy, confirmedExport);
      return { changed: result.ok, ...settingsMutationStatus(result, facade) };
    })(request),
  );
  ipcMain.handle(channels.appLockRemove.name, (_event, request: unknown) =>
    validateHandler(channels.appLockRemove, async ({ password }) => {
      const facade = getFacade();
      const result = await facade.remove(password);
      return { removed: result.ok, ...settingsMutationStatus(result, facade) };
    })(request),
  );
  ipcMain.handle(channels.appLockPickRecovery.name, (_event, request: unknown) =>
    validateHandler(channels.appLockPickRecovery, async () => ({ path: await getFacade().pickRecovery() }))(request),
  );
  ipcMain.handle(channels.appLockRecover.name, (_event, request: unknown) =>
    validateHandler(channels.appLockRecover, ({ path, recoveryPassword, nextPassword }) =>
      getFacade().recover(path, recoveryPassword, nextPassword),
    )(request),
  );
  ipcMain.handle(channels.appLockTouchIdStatus.name, (_event, request: unknown) =>
    validateHandler(channels.appLockTouchIdStatus, () => getFacade().touchIdStatus())(request),
  );
  ipcMain.handle(channels.appLockTouchIdEnable.name, (_event, request: unknown) =>
    validateHandler(channels.appLockTouchIdEnable, async ({ password }) => {
      const result = await getFacade().touchIdEnable(password);
      return {
        enabled: result.ok,
        reason: result.ok ? null : result.reason,
        retryAfterMs: result.ok ? 0 : (result.retryAfterMs ?? getFacade().retryAfterMs()),
        attemptsRemaining: result.ok ? 3 : (result.attemptsRemaining ?? getFacade().attemptsRemaining()),
      };
    })(request),
  );
  ipcMain.handle(channels.appLockTouchIdDisable.name, (_event, request: unknown) =>
    validateHandler(channels.appLockTouchIdDisable, async () => ({ disabled: await getFacade().touchIdDisable() }))(request),
  );
  ipcMain.handle(channels.appLockTouchIdUnlock.name, (_event, request: unknown) =>
    validateHandler(channels.appLockTouchIdUnlock, async () => {
      const result = await getFacade().touchIdUnlock();
      return {
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        retryAfterMs: result.ok ? 0 : getFacade().retryAfterMs(),
        attemptsRemaining: result.ok ? 3 : getFacade().attemptsRemaining(),
      };
    })(request),
  );
}

function windowFromEvent(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win === null) {
    throw new Error('window channel invoked from a webContents with no BrowserWindow');
  }
  return win;
}

// Registers a main-process handler for every channel in the registry. Called
// once at startup, before any window exists. Handlers stay thin here; domain
// logic gets its own modules as the epics land.
export function registerLibraryHandlers(
  getService: () => LibraryService,
  onDeleted?: (deleted: number) => void,
  getActivity?: () => ActivityFacade,
  getEmbedding?: () => SemanticEmbeddingFacade,
): void {
  const page = (request: unknown): unknown =>
    wrapHandler(channels.libraryPage, (req) =>
      getEmbedding === undefined ? getService().page(req) : getService().searchPage(req, getEmbedding),
    )(request);
  ipcMain.handle(channels.libraryPage.name, (_event, request: unknown) => page(request));
  ipcMain.handle(channels.librarySelectAll.name, (_event, request: unknown) =>
    wrapHandler(channels.librarySelectAll, async (req) => ({
      photoIds: getEmbedding === undefined ? getService().selectAllIds(req) : await getService().searchSelectAllIds(req, getEmbedding),
    }))(request),
  );
  ipcMain.handle(channels.librarySelectionRange.name, (_event, request: unknown) =>
    wrapHandler(channels.librarySelectionRange, (req) =>
      getEmbedding === undefined ? getService().selectionRange(req) : getService().searchSelectionRange(req, getEmbedding),
    )(request),
  );
  ipcMain.handle(channels.libraryPhotoKeySelection.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryPhotoKeySelection, ({ photoIds }) => getService().photoKeySelection(photoIds))(request),
  );
  ipcMain.handle(channels.libraryGet.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryGet, ({ id }) => ({ photo: getService().get(id) ?? null }))(request),
  );
  registerPhotoMetadataHandlers(getService, contentAdmission);
  ipcMain.handle(channels.libraryRepairDimensions.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRepairDimensions, ({ id, width, height }) => getService().repairDimensions(id, width, height))(request),
  );
  ipcMain.handle(channels.libraryToggleFavorite.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryToggleFavorite, ({ id }) => toggleFavoriteWithActivity(getService, getActivity, id))(request),
  );
  ipcMain.handle(channels.libraryToggleFavorites.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryToggleFavorites, ({ photoIds }) => toggleFavoritesWithActivity(getService, getActivity, photoIds))(request),
  );
  ipcMain.handle(channels.libraryCounts.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryCounts, ({ recentSince }) => getService().counts(recentSince))(request),
  );
  ipcMain.handle(channels.libraryGalleryPolicy.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryGalleryPolicy, () => ({ policy: getService().galleryPolicy() }))(request),
  );
  ipcMain.handle(channels.librarySetGalleryPolicy.name, (_event, request: unknown) =>
    wrapHandler(channels.librarySetGalleryPolicy, ({ policy }) => ({ policy: getService().setGalleryPolicy(policy) }))(request),
  );
  ipcMain.handle(channels.libraryStats.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryStats, () => getService().stats())(request),
  );
  ipcMain.handle(channels.libraryAlbums.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryAlbums, () => ({ albums: getService().albums() }))(request),
  );
  ipcMain.handle(channels.libraryDelete.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryDelete, ({ photoIds }) => {
      const result = mutateWithActivity(
        getActivity,
        () => getService().deletePhotos(photoIds),
        (completed) =>
          completed.deleted === 0
            ? undefined
            : {
                eventType: 'photo.trashed',
                entityIds: photoIds,
                outcome: 'succeeded',
                payload: { count: completed.deleted },
              },
        (completed) => trashCommand(completed.changedPhotoIds, 'trash'),
      );
      // Deleting a SYNCED photo changes the manifest with nothing dirty —
      // the host owes the remote a fresh generation (PR #218 review).
      if (result.deleted > 0) {
        onDeleted?.(result.deleted);
      }
      return result;
    })(request),
  );
  ipcMain.handle(channels.libraryRestore.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRestore, ({ photoIds }) => {
      return mutateWithActivity(
        getActivity,
        () => getService().restorePhotos(photoIds),
        (result) =>
          result.restored === 0
            ? undefined
            : {
                eventType: 'photo.restored',
                entityIds: photoIds,
                outcome: 'succeeded',
                payload: { count: result.restored },
              },
        (result) => trashCommand(result.changedPhotoIds, 'restore'),
      );
    })(request),
  );
}

export function registerAlbumHandlers(
  getService: () => LibraryService,
  newId: () => string,
  getActivity?: () => ActivityFacade,
  onManifestChanged?: () => void,
): void {
  registerAlbumIpcHandlers(getService, newId, wrapHandler, getActivity, onManifestChanged);
}

export function registerBoardHandlers(
  getService: () => LibraryService,
  getActivity?: () => ActivityFacade,
  onManifestChanged?: () => void,
): void {
  registerBoardIpcHandlers(getService, wrapHandler, getActivity, onManifestChanged);
}

function registerProtectedAlbumExportHandlers(
  getExport: () => ProtectedExportFacade,
  destinationAuthority: ExportDestinationAuthority,
): void {
  ipcMain.handle(channels.protectedAlbumExportPickDestination.name, (event, request: unknown) =>
    wrapHandler(channels.protectedAlbumExportPickDestination, async (intent) => {
      const path = await getExport().pickDestination();
      return {
        path,
        authorization: path === null ? null : destinationAuthority.issue(event.sender.id, { operation: 'protected', ...intent }, path),
      };
    })(request),
  );
  ipcMain.handle(channels.protectedAlbumExportRevokeDestination.name, (event, request: unknown) =>
    wrapHandler(channels.protectedAlbumExportRevokeDestination, ({ authorization }) => ({
      revoked: destinationAuthority.revoke(event.sender.id, authorization),
    }))(request),
  );
  ipcMain.handle(channels.protectedAlbumExportRun.name, (event, request: unknown) =>
    wrapHandler(channels.protectedAlbumExportRun, ({ albumId, photoIds, authorization, format }) => {
      const destination = destinationAuthority.consume(
        event.sender.id,
        { operation: 'protected', albumId, photoIds, format },
        authorization,
      );
      return getExport().run(albumId, photoIds, destination, format);
    })(request),
  );
  ipcMain.handle(channels.protectedAlbumExportCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumExportCancel, () => {
      getExport().cancel();
      return {};
    })(request),
  );
}

export function registerProtectedAlbumHandlers(
  getLibrary: () => ProtectedLibraryService,
  getExport: () => ProtectedExportFacade,
  getWorkflow: () => ProtectedWorkflowService,
  pickRecovery: () => Promise<string | null>,
  readRecovery: (path: string) => Promise<Buffer>,
  destinationAuthority = new ExportDestinationAuthority(),
): void {
  ipcMain.handle(channels.protectedAlbumsList.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumsList, () => ({ albums: getLibrary().listOpaque() }))(request),
  );
  ipcMain.handle(channels.protectedAlbumProtect.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumProtect, async ({ albumId, password }) => {
      const result = await getWorkflow().protect(albumId, password);
      return result.ok ? { ok: true, albumId: result.albumId, reason: null } : { ok: false, albumId: null, reason: result.reason };
    })(request),
  );
  ipcMain.handle(channels.protectedAlbumUnprotect.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumUnprotect, async ({ albumId, password }) => {
      const result = await getWorkflow().unprotect(albumId, password);
      return result.ok ? { ok: true, albumId: result.albumId, reason: null } : { ok: false, albumId: null, reason: result.reason };
    })(request),
  );
  ipcMain.handle(channels.protectedAlbumChangePassword.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumChangePassword, async ({ albumId, currentPassword, nextPassword }) => ({
      changed: await getWorkflow().changePassword(albumId, currentPassword, nextPassword),
    }))(request),
  );
  ipcMain.handle(channels.protectedAlbumPickRecovery.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumPickRecovery, async () => ({ path: await pickRecovery() }))(request),
  );
  ipcMain.handle(channels.protectedAlbumRecover.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumRecover, async ({ albumId, path, recoveryPassword, nextPassword }) =>
      getWorkflow().recoverPassword({ albumId, recoveryFile: await readRecovery(path), recoveryPassword, nextPassword }),
    )(request),
  );
  ipcMain.handle(channels.protectedAlbumCancelWorkflow.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumCancelWorkflow, () => ({ cancelled: getWorkflow().cancel() }))(request),
  );
  ipcMain.handle(channels.protectedAlbumUnlock.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumUnlock, async ({ albumId, password }) => {
      const result = await getWorkflow().unlock(albumId, password);
      return result.ok ? { ok: true, outcome: result.outcome } : { ok: false, outcome: null };
    })(request),
  );
  ipcMain.handle(channels.protectedAlbumRelock.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumRelock, ({ albumId }) => ({ relocked: getWorkflow().relock(albumId) }))(request),
  );
  ipcMain.handle(channels.protectedAlbumSummary.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumSummary, ({ albumId }) => getLibrary().summary(albumId))(request),
  );
  ipcMain.handle(channels.protectedAlbumPage.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumPage, (input) => getLibrary().page(input))(request),
  );
  ipcMain.handle(channels.protectedAlbumGet.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumGet, ({ albumId, photoId }) => ({ photo: getLibrary().get(albumId, photoId) }))(request),
  );
  ipcMain.handle(channels.protectedAlbumToggleFavorite.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumToggleFavorite, ({ albumId, photoId }) => getLibrary().toggleFavorite(albumId, photoId))(request),
  );
  ipcMain.handle(channels.protectedAlbumDelete.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumDelete, ({ albumId, photoIds }) => getLibrary().softDelete(albumId, photoIds))(request),
  );
  ipcMain.handle(channels.protectedAlbumRestore.name, (_event, request: unknown) =>
    wrapHandler(channels.protectedAlbumRestore, ({ albumId, photoIds }) => getLibrary().restore(albumId, photoIds))(request),
  );
  registerProtectedAlbumExportHandlers(getExport, destinationAuthority);
}

export function registerPurgeHandlers(getFacade: () => PurgeFacade, authorize: PurgeAuthorizer, getActivity?: () => ActivityFacade): void {
  ipcMain.handle(channels.libraryPurge.name, (event, request: unknown) =>
    wrapHandler(channels.libraryPurge, ({ photoIds }) =>
      purgeAfterAuthorization(photoIds, BrowserWindow.fromWebContents(event.sender), getFacade, authorize, getActivity),
    )(request),
  );
}

export interface SettingsFacade {
  get(): AppSettings;
  set(patch: SettingsPatch): AppSettings;
}

export interface DiagnosticsFacade {
  list(): readonly {
    readonly event: Pick<DiagnosticEvent, 'eventId' | 'capturedAt' | 'kind'>;
    readonly payload: string;
    readonly encryptedBytes: number;
  }[];
  remove(eventId: string): boolean;
  purge(): number;
  export(destination: string, eventIds: readonly string[]): number;
}

export type LibraryOpenOutcome = z.output<typeof channels.libraryRegistryOpen.response>;
export type LibraryAddOutcome = z.output<typeof channels.libraryRegistryAdd.response>;

export interface LibraryRegistryFacade {
  list(): LibraryDescriptor[];
  create(name: string, path: string | null): LibraryDescriptor;
  open(id: string): LibraryOpenOutcome | Promise<LibraryOpenOutcome>;
  remove(id: string): boolean;
  current(): LibraryDescriptor;
  setDisplayName(id: string, name: string): LibraryDescriptor;
  resetDisplayName(id: string): LibraryDescriptor;
  add(path: string | null): Promise<LibraryAddOutcome>;
  pickLocation(): Promise<{ path: string | null }>;
  pickCreateLocation(): Promise<{ path: string | null }>;
}

// Multi-library registry (#384, #847, #1436): `list`, `current`, and `open`
// remain available while the active library is app-locked so LockScreen
// `switchOnly` can switch away; management mutations require content admission
// and cannot unregister a locked active library.
export function registerLibraryRegistryHandlers(
  getFacade: () => LibraryRegistryFacade,
  lockedLibraryId: () => string | null = () => null,
): void {
  ipcMain.handle(channels.libraryRegistryList.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRegistryList, () => ({ libraries: getFacade().list() }))(request),
  );
  ipcMain.handle(channels.libraryRegistryCreate.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRegistryCreate, ({ name, path }) => ({ library: getFacade().create(name, path) }))(request),
  );
  ipcMain.handle(channels.libraryRegistryOpen.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRegistryOpen, ({ id }) => getFacade().open(id))(request),
  );
  ipcMain.handle(channels.libraryRegistryRemove.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRegistryRemove, ({ id }) => {
      if (id === lockedLibraryId()) {
        throw new Error('cannot remove the active library while it is locked');
      }
      return { removed: getFacade().remove(id) };
    })(request),
  );
  ipcMain.handle(channels.libraryRegistryCurrent.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRegistryCurrent, () => ({ library: getFacade().current() }))(request),
  );
  ipcMain.handle(channels.libraryRegistrySetDisplayName.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRegistrySetDisplayName, ({ id, name }) => ({ library: getFacade().setDisplayName(id, name) }))(request),
  );
  ipcMain.handle(channels.libraryRegistryResetDisplayName.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRegistryResetDisplayName, ({ id }) => ({ library: getFacade().resetDisplayName(id) }))(request),
  );
  ipcMain.handle(channels.libraryRegistryAdd.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRegistryAdd, ({ path }) => getFacade().add(path))(request),
  );
  ipcMain.handle(channels.libraryRegistryPickLocation.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRegistryPickLocation, () => getFacade().pickLocation())(request),
  );
  ipcMain.handle(channels.libraryRegistryPickCreateLocation.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryRegistryPickCreateLocation, () => getFacade().pickCreateLocation())(request),
  );
}

export type RelocationFacade = Pick<
  RelocationRuntime,
  'move' | 'rename' | 'resume' | 'discard' | 'cancel' | 'finishCleanup' | 'pending' | 'probe'
>;

function relocationAuthorizationFailure(error: unknown): {
  readonly ok: false;
  readonly reason: 'authorization-denied';
  readonly detail: string;
} {
  if (!(error instanceof RelocationDestinationGrantError)) throw error;
  return { ok: false, reason: 'authorization-denied', detail: error.message };
}

// Library relocation (#483, ADR-0022). Like the registry handlers these use
// validateHandler directly. The runtime refuses OVLK custody without an
// authenticated open and refuses a locked active library; other inactive
// libraries may move while the active library is app-locked.
export function registerRelocationHandlers(
  getRuntime: () => RelocationFacade,
  pickDestination: () => Promise<string | null>,
  destinationAuthority = new RelocationDestinationAuthority(),
): void {
  const boundSenders = new WeakSet<Electron.WebContents>();
  ipcMain.handle(channels.libraryRelocationPickDestination.name, (event, request: unknown) =>
    validateHandler(channels.libraryRelocationPickDestination, async () => {
      const selected = await pickDestination();
      if (selected === null) return { path: null, authorization: null };
      const grant = await destinationAuthority.issue(event.sender.id, selected);
      if (!boundSenders.has(event.sender)) {
        boundSenders.add(event.sender);
        event.sender.once('destroyed', () => destinationAuthority.revokeSender(event.sender.id));
      }
      return { path: grant.root, authorization: grant.authorization };
    })(request),
  );
  ipcMain.handle(channels.libraryRelocationRevokeDestination.name, (event, request: unknown) =>
    validateHandler(channels.libraryRelocationRevokeDestination, ({ authorization }) => ({
      revoked: destinationAuthority.revoke(event.sender.id, authorization),
    }))(request),
  );
  ipcMain.handle(channels.libraryRelocationMove.name, (event, request: unknown) =>
    validateHandler(channels.libraryRelocationMove, async ({ id, destPath, authorization }) => {
      const lease = await destinationAuthority.acquire(event.sender.id, authorization, destPath).catch(relocationAuthorizationFailure);
      if ('ok' in lease) return lease;
      try {
        return await getRuntime().move(id, lease.destination);
      } finally {
        lease.release();
      }
    })(request),
  );
  ipcMain.handle(channels.libraryRelocationRename.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRelocationRename, ({ id, newName }) => getRuntime().rename(id, newName))(request),
  );
  ipcMain.handle(channels.libraryRelocationCancel.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRelocationCancel, ({ id }) => ({ cancelled: getRuntime().cancel(id) }))(request),
  );
  ipcMain.handle(channels.libraryRelocationResume.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRelocationResume, ({ id }) => getRuntime().resume(id))(request),
  );
  ipcMain.handle(channels.libraryRelocationDiscard.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRelocationDiscard, async ({ id }) => ({ result: await getRuntime().discard(id) }))(request),
  );
  ipcMain.handle(channels.libraryRelocationPreflight.name, (event, request: unknown) =>
    validateHandler(channels.libraryRelocationPreflight, async ({ id, destPath, authorization }) => {
      const lease = await destinationAuthority.acquire(event.sender.id, authorization, destPath).catch(relocationAuthorizationFailure);
      if ('ok' in lease) return lease;
      try {
        return await getRuntime().probe(id, lease.destination);
      } finally {
        lease.release();
      }
    })(request),
  );
  ipcMain.handle(channels.libraryRelocationFinishCleanup.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRelocationFinishCleanup, async ({ id }) => ({ result: await getRuntime().finishCleanup(id) }))(request),
  );
  ipcMain.handle(channels.libraryRelocationPending.name, (_event, request: unknown) =>
    validateHandler(channels.libraryRelocationPending, () => ({ pending: getRuntime().pending() }))(request),
  );
}

export function registerSettingsHandlers(getFacade: () => SettingsFacade): void {
  ipcMain.handle(channels.settingsGet.name, (_event, request: unknown) =>
    wrapHandler(channels.settingsGet, () => ({ settings: getFacade().get() }))(request),
  );
  ipcMain.handle(channels.settingsSet.name, (_event, request: unknown) =>
    wrapHandler(channels.settingsSet, ({ patch }) => ({ settings: getFacade().set(patch) }))(request),
  );
}

export function registerThemeHandlers(service: ThemeService): void {
  const boundSenders = new WeakSet<Electron.WebContents>();
  const bindSender = (sender: Electron.WebContents): void => {
    if (boundSenders.has(sender)) return;
    boundSenders.add(sender);
    const cancel = (): void => service.cancelForSender(sender.id);
    sender.on('render-process-gone', cancel);
    sender.on('unresponsive', cancel);
    sender.once('destroyed', cancel);
  };
  ipcMain.handle(channels.themeList.name, (event, request: unknown) =>
    wrapHandler(channels.themeList, async () => {
      bindSender(event.sender);
      return service.list();
    })(request),
  );
  ipcMain.handle(channels.themePickImport.name, (event, request: unknown) =>
    wrapHandler(channels.themePickImport, async () => {
      const steeredPath = app.isPackaged ? undefined : process.env['OVERLOOK_THEME_IMPORT_SOURCE'];
      if (steeredPath !== undefined) return service.importPath(steeredPath);
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.OpenDialogOptions = {
        title: 'Import theme',
        properties: ['openFile'],
        filters: [{ name: 'Overlook themes', extensions: ['json'] }],
      };
      const selection = owner === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
      const sourcePath = selection.filePaths[0];
      return selection.canceled || sourcePath === undefined ? { status: 'cancelled' as const } : service.importPath(sourcePath);
    })(request),
  );
  ipcMain.handle(channels.themeImportPath.name, (_event, request: unknown) =>
    wrapHandler(channels.themeImportPath, ({ path: sourcePath }) => service.importPath(sourcePath))(request),
  );
  ipcMain.handle(channels.themeExportTemplate.name, (event, request: unknown) =>
    wrapHandler(channels.themeExportTemplate, async ({ base, tokens }) => {
      const steeredPath = app.isPackaged ? undefined : process.env['OVERLOOK_THEME_EXPORT_DESTINATION'];
      if (steeredPath !== undefined && steeredPath !== '') return service.exportTemplate(steeredPath, { base, tokens });
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.SaveDialogOptions = {
        title: 'Export theme template',
        defaultPath: `overlook-${base}-template.overlook-theme.json`,
        filters: [{ name: 'Overlook themes', extensions: ['json'] }],
      };
      const selection = owner === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options);
      const destination = selection.filePath;
      if (selection.canceled || destination === undefined || destination === '') return { status: 'cancelled' as const };
      return service.exportTemplate(destination, { base, tokens });
    })(request),
  );
  ipcMain.handle(channels.themeActive.name, (_event, request: unknown) =>
    wrapHandler(channels.themeActive, () => service.active())(request),
  );
  ipcMain.handle(channels.themePreview.name, (event, request: unknown) =>
    wrapHandler(channels.themePreview, ({ id }) => {
      bindSender(event.sender);
      return service.preview(id, event.sender.id);
    })(request),
  );
  ipcMain.handle(channels.themePreviewHealthy.name, (event, request: unknown) =>
    wrapHandler(channels.themePreviewHealthy, ({ previewId }) => ({ accepted: service.healthy(previewId, event.sender.id) }))(request),
  );
  ipcMain.handle(channels.themeConfirm.name, (event, request: unknown) =>
    wrapHandler(channels.themeConfirm, ({ previewId }) => service.confirm(previewId, event.sender.id))(request),
  );
  ipcMain.handle(channels.themeCancel.name, (event, request: unknown) =>
    wrapHandler(channels.themeCancel, ({ previewId }) => ({ cancelled: service.cancel(previewId, event.sender.id) }))(request),
  );
  ipcMain.handle(channels.themeRemove.name, (_event, request: unknown) =>
    wrapHandler(channels.themeRemove, ({ id }) => service.remove(id))(request),
  );
  ipcMain.handle(channels.themeReset.name, (_event, request: unknown) =>
    validateHandler(channels.themeReset, () => ({ settings: service.reset() }))(request),
  );
}

export function registerDiagnosticsHandlers(getFacade: () => DiagnosticsFacade, pickExportDestination: () => Promise<string | null>): void {
  ipcMain.handle(channels.diagnosticsList.name, (_event, request: unknown) =>
    wrapHandler(channels.diagnosticsList, () => ({
      reports: getFacade()
        .list()
        .map(({ event, payload, encryptedBytes }) => ({
          eventId: event.eventId,
          capturedAt: event.capturedAt,
          kind: event.kind,
          payload,
          encryptedBytes,
        })),
    }))(request),
  );
  ipcMain.handle(channels.diagnosticsDelete.name, (_event, request: unknown) =>
    wrapHandler(channels.diagnosticsDelete, ({ eventId }) => ({ deleted: getFacade().remove(eventId) }))(request),
  );
  ipcMain.handle(channels.diagnosticsPurge.name, (_event, request: unknown) =>
    wrapHandler(channels.diagnosticsPurge, () => ({ deleted: getFacade().purge() }))(request),
  );
  ipcMain.handle(channels.diagnosticsExport.name, (_event, request: unknown) =>
    wrapHandler(channels.diagnosticsExport, async ({ eventIds }) => {
      const destination = await pickExportDestination();
      if (destination === null) return { exported: false, count: 0 };
      return { exported: true, count: getFacade().export(destination, eventIds) };
    })(request),
  );
}

export function registerImportHandlers(
  getService: () => ImportService,
  pickFolder: () => Promise<string | null>,
  onImported?: () => void,
  onExternalReady?: () => void,
  getActivity?: () => ActivityFacade,
  confirmMove?: (source: ImportMoveSource, parent: BrowserWindow | null) => Promise<boolean>,
): void {
  ipcMain.handle(channels.importListSources.name, (_event, request: unknown) =>
    wrapHandler(channels.importListSources, async () => ({ sources: await getService().listSources() }))(request),
  );
  ipcMain.handle(channels.importScanSource.name, (_event, request: unknown) =>
    wrapHandler(channels.importScanSource, async ({ path }) => getService().scanSource(path))(request),
  );
  ipcMain.handle(channels.importPickFolder.name, (_event, request: unknown) =>
    wrapHandler(channels.importPickFolder, async () => ({ path: await pickFolder() }))(request),
  );
  ipcMain.handle(channels.importScanFiles.name, (_event, request: unknown) =>
    wrapHandler(channels.importScanFiles, async ({ paths }) => getService().scanDropped(paths))(request),
  );
  ipcMain.handle(channels.importGoogleDrivePick.name, (_event, request: unknown) =>
    wrapHandler(channels.importGoogleDrivePick, () => getService().pickGoogleDrive())(request),
  );
  ipcMain.handle(channels.importGoogleDriveCancelPick.name, (_event, request: unknown) =>
    wrapHandler(channels.importGoogleDriveCancelPick, () => {
      getService().cancelGoogleDrivePick();
      return {};
    })(request),
  );
  ipcMain.handle(channels.importGoogleDriveRun.name, (_event, request: unknown) =>
    wrapHandler(channels.importGoogleDriveRun, async ({ selectionId }) => {
      const summary = await getService().runGoogleDrive(selectionId);
      if (summary.imported > 0) onImported?.();
      getActivity?.().record({
        eventType: 'import.completed',
        outcome: summary.failed > 0 || summary.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          mode: 'copy',
          imported: summary.imported,
          moved: summary.moved,
          retained: summary.retained,
          duplicates: summary.duplicates,
          failed: summary.failed,
          cancelled: summary.cancelled,
        },
      });
      return {
        imported: summary.imported,
        moved: summary.moved,
        retained: summary.retained,
        duplicates: summary.duplicates,
        failed: summary.failed,
        cancelled: summary.cancelled,
        sidecars: summary.sidecars,
      };
    })(request),
  );
  ipcMain.handle(channels.importGoogleDriveDiscard.name, (_event, request: unknown) =>
    wrapHandler(channels.importGoogleDriveDiscard, async ({ selectionId }) => {
      await getService().discardGoogleDrive(selectionId);
      return {};
    })(request),
  );
  ipcMain.handle(channels.importExternalReady.name, (_event, request: unknown) =>
    wrapHandler(channels.importExternalReady, () => {
      onExternalReady?.();
      return {};
    })(request),
  );
  ipcMain.handle(channels.importRun.name, (event, request: unknown) =>
    wrapHandler(channels.importRun, async ({ path, files, mode }) => {
      const confirmForSender =
        confirmMove === undefined
          ? undefined
          : (source: ImportMoveSource) => confirmMove(source, BrowserWindow.fromWebContents(event.sender));
      if (!(await requireMoveImportConfirmation(mode, { path, files }, confirmForSender, contentAdmission))) {
        return {
          imported: 0,
          moved: 0,
          retained: 0,
          duplicates: 0,
          failed: 0,
          cancelled: 0,
          sidecars: 0,
          confirmationCancelled: true as const,
        };
      }
      // The zod refinement guarantees exactly one of path/files. Both paths
      // use the engine's verified per-file Move boundary (#489).
      const summary = files !== undefined ? await getService().runFiles(files, mode) : await getService().run(path ?? '', mode);
      // The auto-backup-on-import subscription seam (#105/#111): fires only
      // when the batch actually landed photos.
      if (summary.imported > 0) {
        onImported?.();
      }
      getActivity?.().record(
        {
          eventType: 'import.completed',
          outcome: summary.failed > 0 || summary.cancelled > 0 ? 'partial' : 'succeeded',
          payload: {
            mode,
            imported: summary.imported,
            moved: summary.moved,
            retained: summary.retained,
            duplicates: summary.duplicates,
            failed: summary.failed,
            cancelled: summary.cancelled,
          },
        },
        summary.moveCompensations.map(moveCompensationCommand),
      );
      return {
        imported: summary.imported,
        moved: summary.moved,
        retained: summary.retained,
        duplicates: summary.duplicates,
        failed: summary.failed,
        cancelled: summary.cancelled,
        sidecars: summary.sidecars,
      };
    })(request),
  );
  ipcMain.handle(channels.importCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.importCancel, () => {
      getService().cancel();
      return {};
    })(request),
  );
}

export interface KeysFacade {
  fingerprint(): string;
  exportKey(password: string): Promise<string | null>;
  pickFile(): Promise<string | null>;
  importKey(
    path: string,
    password: string,
  ): Promise<{ installed: boolean; fingerprint: string | null; reason: 'invalid' | 'wrong-password' | 'mismatch' | 'no-library' | null }>;
}

export function registerKeysHandlers(getFacade: () => KeysFacade): void {
  ipcMain.handle(channels.keysStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.keysStatus, () => ({ fingerprint: getFacade().fingerprint() }))(request),
  );
  ipcMain.handle(channels.keysExport.name, (_event, request: unknown) =>
    wrapHandler(channels.keysExport, async ({ password }) => ({ path: await getFacade().exportKey(password) }))(request),
  );
  ipcMain.handle(channels.keysPickFile.name, (_event, request: unknown) =>
    wrapHandler(channels.keysPickFile, async () => ({ path: await getFacade().pickFile() }))(request),
  );
  ipcMain.handle(channels.keysImport.name, (_event, request: unknown) =>
    wrapHandler(channels.keysImport, async ({ path, password }) => getFacade().importKey(path, password))(request),
  );
}

export interface RestoreFacade {
  profileStatus(): { fresh: boolean };
  pickKey(): Promise<string | null>;
  discover(
    providerId: string,
    key: { keyPath: string; password: string } | { localKey: true; password?: string | undefined },
  ): Promise<RestoreDiscoverResponse>;
  run(sessionId: string, libraryId: string, verificationId: string, allowReplace: boolean): Promise<RestoreRunResponse>;
  verify(sessionId: string, libraryId: string): Promise<RestoreVerifyResponse>;
  trash(sessionId: string, libraryId: string, verificationId: string, confirmation: string): Promise<RestoreTrashResponse>;
  exportCsv(
    sessionId: string,
    libraryId: string,
    verificationId: string,
  ): Promise<{ exported: boolean; path: string | null; error: string | null }>;
  exportCorrupt(
    sessionId: string,
    libraryId: string,
    verificationId: string,
  ): Promise<{ exported: boolean; count: number; unavailable: number; error: string | null }>;
  cancel(): void;
  status(): RestoreStatusSnapshot;
}

export function registerRestoreHandlers(getFacade: () => RestoreFacade): void {
  ipcMain.handle(channels.restoreProfileStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreProfileStatus, () => getFacade().profileStatus())(request),
  );
  ipcMain.handle(channels.restorePickKey.name, (_event, request: unknown) =>
    wrapHandler(channels.restorePickKey, async () => ({ path: await getFacade().pickKey() }))(request),
  );
  ipcMain.handle(channels.restoreDiscover.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreDiscover, (parsed) =>
      getFacade().discover(
        parsed.providerId,
        'localKey' in parsed ? { localKey: true, password: parsed.password } : { keyPath: parsed.keyPath, password: parsed.password },
      ),
    )(request),
  );
  ipcMain.handle(channels.restoreRun.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreRun, ({ sessionId, libraryId, verificationId, allowReplace }) =>
      getFacade().run(sessionId, libraryId, verificationId, allowReplace),
    )(request),
  );
  ipcMain.handle(channels.restoreVerify.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreVerify, ({ sessionId, libraryId }) => getFacade().verify(sessionId, libraryId))(request),
  );
  ipcMain.handle(channels.restoreTrash.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreTrash, ({ sessionId, libraryId, verificationId, confirmation }) =>
      getFacade().trash(sessionId, libraryId, verificationId, confirmation),
    )(request),
  );
  ipcMain.handle(channels.restoreExportCsv.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreExportCsv, ({ sessionId, libraryId, verificationId }) =>
      getFacade().exportCsv(sessionId, libraryId, verificationId),
    )(request),
  );
  ipcMain.handle(channels.restoreExportCorrupt.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreExportCorrupt, ({ sessionId, libraryId, verificationId }) =>
      getFacade().exportCorrupt(sessionId, libraryId, verificationId),
    )(request),
  );
  ipcMain.handle(channels.restoreCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreCancel, () => {
      getFacade().cancel();
      return {};
    })(request),
  );
  ipcMain.handle(channels.restoreStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.restoreStatus, () => getFacade().status())(request),
  );
}

export interface ExportEditsIntent {
  readonly mode?: 'baked' | 'original-sidecars' | 'original' | undefined;
  readonly quality?: number | undefined;
}

export interface ExportFacade {
  run(
    photoIds: readonly string[],
    destination: string,
    format?: 'original' | 'jpeg',
    metadata?: 'original' | 'overlook' | 'none',
    edits?: ExportEditsIntent,
    disclosure?: ExportDisclosureIntentWire,
  ): Promise<ExportRunResult>;
  runAll(
    destination: string,
    metadata?: 'original' | 'overlook' | 'none',
    edits?: ExportEditsIntent,
    disclosure?: ExportDisclosureIntentWire,
  ): Promise<ExportRunResult>;
  /** §6 loss report; null photoIds = every exportable photo. */
  preflight(
    photoIds: readonly string[] | null,
    mode: 'baked' | 'original-sidecars' | 'original',
  ): Promise<{ readonly edited: number; readonly losses: readonly { photoId: string; fileName: string; reason: string }[] }>;
  runBoard(request: BoardExportRequest): Promise<BoardExportResult>;
  cancel(): void;
  pickDestination(): Promise<string | null>;
}

export interface ExportRunResult {
  readonly exported: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly previewTranscodes: number;
  readonly bakedEdits: number;
  readonly editSidecars: number;
  readonly failures: { photoId: string; fileName: string; reason: string }[];
}

/** ADR-0032 §6: consent at operation scope is recorded by field NAME only. */
export function disclosurePayload(disclosure: ExportDisclosureIntentWire | undefined): {
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

export function registerExportHandlers(
  getFacade: () => ExportFacade,
  getActivity?: () => ActivityFacade,
  destinationAuthority = new ExportDestinationAuthority(),
): void {
  ipcMain.handle(channels.exportRun.name, (event, request: unknown) =>
    wrapHandler(channels.exportRun, async ({ photoIds, authorization, format, metadata, mode, quality, disclosure }) => {
      const destination = destinationAuthority.consume(
        event.sender.id,
        { operation: 'selected', photoIds, format, metadata, mode, quality, disclosure },
        authorization,
      );
      const result = await getFacade().run(photoIds, destination, format, metadata, { mode, quality }, disclosure);
      const { failures: _failures, ...summary } = result;
      getActivity?.().record({
        eventType: 'photo.exported',
        entityIds: photoIds,
        outcome: result.failed > 0 || result.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          format: format ?? 'original',
          metadata: metadata ?? 'original',
          mode: mode ?? null,
          ...disclosurePayload(disclosure),
          ...summary,
        },
      });
      return result;
    })(request),
  );
  ipcMain.handle(channels.exportRunAll.name, (event, request: unknown) =>
    wrapHandler(channels.exportRunAll, async ({ authorization, metadata, mode, quality, disclosure }) => {
      const destination = destinationAuthority.consume(
        event.sender.id,
        { operation: 'all', metadata, mode, quality, disclosure },
        authorization,
      );
      const result = await getFacade().runAll(destination, metadata, { mode, quality }, disclosure);
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
          ...disclosurePayload(disclosure),
          ...summary,
        },
      });
      return result;
    })(request),
  );
  ipcMain.handle(channels.exportRunBoard.name, (event, request: unknown) =>
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
  ipcMain.handle(channels.exportCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.exportCancel, () => {
      getFacade().cancel();
      return {};
    })(request),
  );
  ipcMain.handle(channels.exportPreflight.name, (_event, request: unknown) =>
    wrapHandler(channels.exportPreflight, async ({ photoIds, mode }) => {
      const report = await getFacade().preflight(photoIds ?? null, mode);
      return { edited: report.edited, losses: [...report.losses] };
    })(request),
  );
  ipcMain.handle(channels.exportPickDestination.name, (event, request: unknown) =>
    wrapHandler(channels.exportPickDestination, async ({ intent }) => {
      const path = await getFacade().pickDestination();
      return {
        path,
        authorization: path === null ? null : destinationAuthority.issue(event.sender.id, intent, path),
      };
    })(request),
  );
  ipcMain.handle(channels.exportRevokeDestination.name, (event, request: unknown) =>
    wrapHandler(channels.exportRevokeDestination, ({ authorization }) => ({
      revoked: destinationAuthority.revoke(event.sender.id, authorization),
    }))(request),
  );
}

export interface BackupFacade {
  run(): Promise<{
    uploaded: number;
    failed: number;
    skipped: 'wifi' | 'disconnected' | null;
    integrity: { checked: number; repaired: number; unrecoverable: number; recoveryRepaired: boolean; failed: boolean };
  }>;
  offloadPreflight(photoIds: readonly string[]): Promise<OffloadPreflight>;
  offload(photoIds: readonly string[]): Promise<OffloadSummary>;
  rehydrate(photoId: string): Promise<void>;
  keepDownloaded(photoId: string): Promise<void>;
  releaseEphemeral(photoId: string): Promise<void>;
  ephemeralStatus(photoId: string): {
    readonly stage: 'fetching' | 'verifying' | 'ready' | 'released' | 'error';
    readonly reason?: EphemeralFailureReason | undefined;
  } | null;
  photoCustodyStatus(photoId: string): Promise<PhotoCustodyStatus>;
  prepareEphemeral(photoId: string): Promise<'durable' | 'ephemeral'>;
  restoreOriginals(photoIds?: readonly string[]): Promise<RestoreOriginalsSummary>;
  providers(): Promise<{ providers: readonly ProviderDescriptor[]; defaultProviderId: string }>;
  providerStatus(providerId: string): Promise<ProviderConnectionStatus>;
  providerStorage(providerId: string): Promise<ProviderCapacityStatus>;
  /** Runs the addressed provider's instant or interactive handshake. */
  connect(providerId: string): Promise<ProviderConnectResult>;
  disconnectPreflight(providerId: string): Promise<ProviderConnectResult>;
  disconnect(providerId: string): Promise<{ ok: boolean; reason: string | null }>;
  removeAuthorizationAnyway(providerId: string): Promise<ProviderConnectResult>;
  openCapacitySettings(providerId: string): Promise<{ ok: boolean }>;
}

export function registerBackupHandlers(getFacade: () => BackupFacade): void {
  ipcMain.handle(channels.backupRun.name, (_event, request: unknown) =>
    wrapHandler(channels.backupRun, async () => getFacade().run())(request),
  );
  ipcMain.handle(channels.backupOffloadPreflight.name, (_event, request: unknown) =>
    wrapHandler(channels.backupOffloadPreflight, async ({ photoIds }) => getFacade().offloadPreflight(photoIds))(request),
  );
  ipcMain.handle(channels.backupOffload.name, (_event, request: unknown) =>
    wrapHandler(channels.backupOffload, async ({ photoIds }) => getFacade().offload(photoIds))(request),
  );
  ipcMain.handle(channels.backupRehydrate.name, (_event, request: unknown) =>
    wrapHandler(channels.backupRehydrate, async ({ photoId }) => {
      await getFacade().rehydrate(photoId);
      return { ok: true };
    })(request),
  );
  ipcMain.handle(channels.backupKeepDownloaded.name, (_event, request: unknown) =>
    wrapHandler(channels.backupKeepDownloaded, async ({ photoId }) => {
      await getFacade().keepDownloaded(photoId);
      return { ok: true };
    })(request),
  );
  ipcMain.handle(channels.backupReleaseEphemeral.name, (_event, request: unknown) =>
    wrapHandler(channels.backupReleaseEphemeral, async ({ photoId }) => {
      await getFacade().releaseEphemeral(photoId);
      return { ok: true };
    })(request),
  );
  ipcMain.handle(channels.backupEphemeralStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.backupEphemeralStatus, ({ photoId }) => getFacade().ephemeralStatus(photoId) ?? { stage: null })(request),
  );
  ipcMain.handle(channels.backupPhotoCustodyStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.backupPhotoCustodyStatus, async ({ photoId }) => getFacade().photoCustodyStatus(photoId))(request),
  );
  ipcMain.handle(channels.backupPrepareEphemeral.name, (_event, request: unknown) =>
    wrapHandler(channels.backupPrepareEphemeral, async ({ photoId }) => ({ custody: await getFacade().prepareEphemeral(photoId) }))(
      request,
    ),
  );
  ipcMain.handle(channels.backupRestoreOriginals.name, (_event, request: unknown) =>
    wrapHandler(channels.backupRestoreOriginals, async ({ photoIds }) => getFacade().restoreOriginals(photoIds))(request),
  );
  ipcMain.handle(channels.backupProviders.name, (_event, request: unknown) =>
    wrapHandler(channels.backupProviders, () => getFacade().providers())(request),
  );
  ipcMain.handle(channels.backupProviderStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.backupProviderStatus, async ({ providerId }) => getFacade().providerStatus(providerId))(request),
  );
  ipcMain.handle(channels.backupProviderStorage.name, (_event, request: unknown) =>
    wrapHandler(channels.backupProviderStorage, async ({ providerId }) => getFacade().providerStorage(providerId))(request),
  );
  ipcMain.handle(channels.backupConnect.name, (_event, request: unknown) =>
    wrapHandler(channels.backupConnect, async ({ providerId }) => getFacade().connect(providerId))(request),
  );
  ipcMain.handle(channels.backupDisconnectPreflight.name, (_event, request: unknown) =>
    wrapHandler(channels.backupDisconnectPreflight, async ({ providerId }) => getFacade().disconnectPreflight(providerId))(request),
  );
  ipcMain.handle(channels.backupDisconnect.name, (_event, request: unknown) =>
    wrapHandler(channels.backupDisconnect, async ({ providerId }) => getFacade().disconnect(providerId))(request),
  );
  ipcMain.handle(channels.backupRemoveAuthorizationAnyway.name, (_event, request: unknown) =>
    wrapHandler(channels.backupRemoveAuthorizationAnyway, async ({ providerId }) => getFacade().removeAuthorizationAnyway(providerId))(
      request,
    ),
  );
  ipcMain.handle(channels.backupOpenCapacitySettings.name, (_event, request: unknown) =>
    wrapHandler(channels.backupOpenCapacitySettings, async ({ providerId }) => getFacade().openCapacitySettings(providerId))(request),
  );
}

export function registerIpcHandlers(getLanguage: () => string | null): void {
  const ping = validateHandler(channels.ping, ({ message }) => ({ echoed: message }));
  ipcMain.handle(channels.ping.name, (_event, request: unknown) => ping(request));

  const getPlatform = validateHandler(channels.getPlatform, () => ({ platform: process.platform }));
  ipcMain.handle(channels.getPlatform.name, (_event, request: unknown) => getPlatform(request));

  const getLocale = validateHandler(channels.getLocale, () => ({ locale: resolveActiveLocale(getLanguage()) }));
  ipcMain.handle(channels.getLocale.name, (_event, request: unknown) => getLocale(request));

  const clipboardWrite = validateHandler(channels.clipboardWrite, async ({ text }) => {
    // Electron 44 made clipboard.writeText asynchronous; surface its failure
    // to the renderer instead of letting the promise float.
    await clipboard.writeText(text);
    return {};
  });
  ipcMain.handle(channels.clipboardWrite.name, (_event, request: unknown) => clipboardWrite(request));

  // Window controls need the calling window, so validation wraps a handler
  // built per invocation.
  ipcMain.handle(channels.windowMinimize.name, (event, request: unknown) =>
    validateHandler(channels.windowMinimize, () => {
      windowFromEvent(event).minimize();
      return {};
    })(request),
  );

  ipcMain.handle(channels.windowToggleMaximize.name, (event, request: unknown) =>
    validateHandler(channels.windowToggleMaximize, () => {
      const win = windowFromEvent(event);
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
      return { maximized: win.isMaximized() };
    })(request),
  );

  ipcMain.handle(channels.windowClose.name, (event, request: unknown) =>
    validateHandler(channels.windowClose, () => {
      windowFromEvent(event).close();
      return {};
    })(request),
  );
}
