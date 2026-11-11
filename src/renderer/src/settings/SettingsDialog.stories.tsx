import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { DEFAULT_DISCLOSURE_POLICY, PINNED_PRIVATE } from '../../../shared/disclosure/policy.js';
/* eslint-disable max-lines -- story stub file, large setup */
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import { useState, type ReactElement } from 'react';

import { Dialog } from '../components/Dialog';
import { RestoreWorkflow } from '../restore/RestoreWorkflow';
import { SettingsDialog, type SettingsDialogProps } from './SettingsDialog';
import { defaultSettings, mergeSettings, type AppSettings } from '../../../shared/settings/settings.js';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { ProviderConnectResult, ProviderConnectionStatus } from '../../../shared/backup/provider-descriptor.js';
import { PROVIDER_AUTHORIZATION_REMOVAL } from '../../../shared/destructive-actions.js';
import { AppStateProvider } from '../state/app-state-context';
import type { QuickActionCommandId } from '../../../shared/commands/registry.js';
import { createEmbeddingStoryController } from '../../../../.storybook/embedding-story-controller';
import { documentThemeLayer } from '../theme/document-theme-layer';
import { installApplicationThemeLayer } from '../theme/user-theme-layer';

// #112–#114 exit criteria: the 640px two-pane frame (Storage & Backup opens
// by default, nav switches panes, keyboard-operable, Esc closes), the
// General section (sort segmented and appearance wired to the store stub,
// thumbnails locked on), and the Storage & Backup
// section (connection card + disconnected-disables-everything). The
// decorator installs in-memory window.overlook settings + backup stubs.

interface StoryWindow extends Window {
  backupCompletedListener: Parameters<OverlookApi['backup']['onCompleted']>[0] | undefined;
  disconnectCalls?: number;
  removeAuthorizationRequests?: readonly { readonly providerId: string; readonly authorization: string }[];
  providerStorageCalls?: Readonly<Record<string, number>>;
  quickActionPatches?: readonly (readonly QuickActionCommandId[])[];
  releaseInitialProviderStatus?: () => void;
  releaseProviderDisconnect?: () => void;
  releaseInteropUnlock?: () => void;
}

function installStub(options?: {
  readonly deferInitialProviderStatus?: boolean;
  readonly deferProviderDisconnect?: boolean;
  readonly deferQuickActionSettings?: boolean;
  readonly deferInteropUnlock?: boolean;
  readonly iCloudAvailable?: boolean;
  readonly appLockConfigured?: boolean;
  readonly accountLabel?: string | null;
  readonly custodyRequirements?: ProviderConnectionStatus['custodyRequirements'];
  readonly disconnectPreflight?: ProviderConnectResult;
}): void {
  installApplicationThemeLayer(documentThemeLayer(document));
  let current: AppSettings = { ...defaultSettings };
  const nonInteractiveIdentity = { interactiveAuth: false, reconnectRequired: false, accountIdentity: 'stable-subject' } as const;
  const mockProvider = {
    id: 'mock',
    label: 'Local mock',
    capabilities: {
      quota: 'known' as const,
      verification: 'server-checksum' as const,
      resumableUpload: false,
      platforms: ['darwin' as const],
      ...nonInteractiveIdentity,
    },
    available: true,
    unavailableReason: null,
  };
  const iCloudDriveProvider = {
    id: 'icloud-drive',
    label: 'iCloud Drive',
    capabilities: {
      quota: 'unknown' as const,
      verification: 'download-hash' as const,
      resumableUpload: false,
      platforms: ['darwin' as const],
      ...nonInteractiveIdentity,
    },
    available: options?.iCloudAvailable !== false,
    unavailableReason: options?.iCloudAvailable === false ? 'iCloud Drive requires a provisioned signed macOS build.' : null,
  };
  const googleDriveProvider = {
    id: 'google-drive',
    label: 'Google Drive',
    capabilities: {
      quota: 'known' as const,
      verification: 'server-checksum' as const,
      resumableUpload: true,
      platforms: ['darwin' as const, 'win32' as const, 'linux' as const],
      interactiveAuth: true,
      reconnectRequired: true,
      accountIdentity: 'stable-subject' as const,
    },
    available: true,
    unavailableReason: null,
  };
  // connect/disconnect (#254) mutate settings OUTSIDE the set() round-trip,
  // exactly like main does — so the stub must deliver change pushes too.
  const listeners = new Set<(payload: { settings: AppSettings }) => void>();
  const apply = (patch: Parameters<typeof mergeSettings>[1]): void => {
    current = mergeSettings(current, patch);
    for (const listener of listeners) {
      listener({ settings: current });
    }
  };
  const settingsApi: OverlookApi['settings'] = {
    get: () => Promise.resolve({ settings: current }),
    set: ({ patch }) => {
      if (options?.deferQuickActionSettings === true && patch.quickActions !== undefined) {
        const storyWindow = globalThis as unknown as StoryWindow;
        storyWindow.quickActionPatches = [...(storyWindow.quickActionPatches ?? []), patch.quickActions];
        return Promise.resolve({ settings: current });
      }
      apply(patch);
      return Promise.resolve({ settings: current });
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const initialProviderStatus =
    options?.deferInitialProviderStatus === true
      ? new Promise<void>((resolve) => {
          (globalThis as unknown as StoryWindow).releaseInitialProviderStatus = resolve;
        })
      : Promise.resolve();
  const providerDisconnect =
    options?.deferProviderDisconnect === true
      ? new Promise<void>((resolve) => {
          (globalThis as unknown as StoryWindow).releaseProviderDisconnect = resolve;
        })
      : Promise.resolve();
  const storyWindow = globalThis as unknown as StoryWindow;
  storyWindow.backupCompletedListener = undefined;
  storyWindow.disconnectCalls = 0;
  storyWindow.removeAuthorizationRequests = [];
  storyWindow.providerStorageCalls = {};
  storyWindow.quickActionPatches = [];
  let providerStatusRequests = 0;
  const backupApi: OverlookApi['backup'] = {
    run: () =>
      Promise.resolve({
        uploaded: 0,
        failed: 0,
        skipped: null,
        integrity: { checked: 0, repaired: 0, unrecoverable: 0, recoveryRepaired: false, failed: false },
      }),
    onProgress: () => () => undefined,
    onCompleted: (listener) => {
      storyWindow.backupCompletedListener = listener;
      return () => {
        if (storyWindow.backupCompletedListener === listener) storyWindow.backupCompletedListener = undefined;
      };
    },
    offloadPreflight: () => Promise.resolve({ eligible: 0, ineligible: 0, estimatedFreedBytes: 0, items: [] }),
    offload: () => Promise.resolve({ offloaded: 0, skipped: 0, failed: 0, freedBytes: 0, results: [] }),
    rehydrate: () => Promise.resolve({ ok: true }),
    keepDownloaded: () => Promise.resolve({ ok: true }),
    releaseEphemeral: () => Promise.resolve({ ok: true }),
    ephemeralStatus: () => Promise.resolve({ stage: null }),
    photoCustodyStatus: () =>
      Promise.resolve({ state: 'available', providerId: 'mock', providerLabel: 'Local mock', accountLabel: 'Mock account' }),
    prepareEphemeral: () => Promise.resolve({ custody: 'ephemeral' }),
    onEphemeralState: () => () => undefined,
    restoreOriginals: ({ photoIds }) =>
      Promise.resolve({
        restored: photoIds?.length ?? 2,
        skipped: 0,
        failed: 0,
        results: (photoIds ?? ['offloaded-1', 'offloaded-2']).map((photoId) => ({
          photoId,
          outcome: 'restored' as const,
          bytes: 6_300_000_000,
          reason: null,
        })),
      }),
    providers: () => Promise.resolve({ providers: [mockProvider, googleDriveProvider, iCloudDriveProvider], defaultProviderId: 'mock' }),
    // The card's truth follows the stub store's providerId, like main does.
    providerStatus: async ({ providerId }) => {
      // Keep status observably asynchronous so the story proves the pane's
      // unresolved state without relying on a same-microtask response.
      const initialRequest = providerStatusRequests === 0;
      providerStatusRequests += 1;
      if (initialRequest) await initialProviderStatus;
      const provider =
        providerId === iCloudDriveProvider.id
          ? iCloudDriveProvider
          : providerId === googleDriveProvider.id
            ? googleDriveProvider
            : mockProvider;
      return {
        provider,
        connected: current.providerId === providerId,
        accountLabel:
          current.providerId !== providerId
            ? null
            : providerId === iCloudDriveProvider.id
              ? 'm.rivera@icloud.com'
              : providerId === googleDriveProvider.id
                ? 'm.rivera@gmail.com'
                : (options?.accountLabel ?? null),
        ...(options?.custodyRequirements === undefined ? {} : { custodyRequirements: options.custodyRequirements }),
      };
    },
    providerStorage: ({ providerId }) => {
      storyWindow.providerStorageCalls = {
        ...storyWindow.providerStorageCalls,
        [providerId]: (storyWindow.providerStorageCalls?.[providerId] ?? 0) + 1,
      };
      return Promise.resolve(
        providerId === iCloudDriveProvider.id
          ? {
              capacity: null,
              capacityRoute: 'system-settings' as const,
            }
          : providerId === googleDriveProvider.id
            ? {
                capacity: { usedBytes: 42_000_000_000, totalBytes: 100_000_000_000 },
                capacityRoute: 'none' as const,
              }
            : {
                capacity: { usedBytes: 380_000_000_000, totalBytes: 500_000_000_000 },
                capacityRoute: 'none' as const,
              },
      );
    },
    // Connect/disconnect (#254) mirror main's mock policy: flip providerId.
    connect: ({ providerId }) => {
      apply({ providerId });
      return Promise.resolve({ ok: true, reason: null });
    },
    disconnectPreflight: () =>
      Promise.resolve(
        options?.disconnectPreflight ?? {
          ok: true,
          reason: null,
          custody: {
            credential: { providerId: 'mock', accountId: 'mock-account' },
            totalItems: 0,
            totalBytes: 0,
            libraries: [],
          },
        },
      ),
    disconnect: async () => {
      storyWindow.disconnectCalls = (storyWindow.disconnectCalls ?? 0) + 1;
      await providerDisconnect;
      apply({ providerId: null });
      return { ok: true, reason: null };
    },
    removeAuthorizationAnyway: (request) => {
      storyWindow.removeAuthorizationRequests = [...(storyWindow.removeAuthorizationRequests ?? []), request];
      apply({ providerId: null });
      return Promise.resolve({ ok: true, reason: null });
    },
    openCapacitySettings: () => Promise.resolve({ ok: true }),
  };
  const keysApi = {
    status: () => Promise.resolve({ fingerprint: '9F2C·4A81·D0E7·5B3A' }),
    export: () => Promise.resolve({ path: null }),
    pickFile: () => Promise.resolve({ path: null }),
    import: () => Promise.resolve({ installed: false, fingerprint: null, reason: 'invalid' as const }),
  } as unknown as OverlookApi['keys'];
  const keyringApi: OverlookApi['keyring'] = {
    list: () =>
      Promise.resolve({
        keys: [
          {
            id: 1,
            keyRef: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
            version: 1,
            kind: 'library' as const,
            origin: 'local' as const,
            label: null,
            fingerprint: '9F2C·4A81·D0E7·5B3A',
            createdAt: '2026-07-01T00:00:00.000Z',
            present: true,
            active: false,
            databaseKey: true,
            usage: { photos: 0, sidecars: 0, bytes: 0 },
          },
          {
            id: 2,
            keyRef: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
            version: 1,
            kind: 'library' as const,
            origin: 'local' as const,
            label: null,
            fingerprint: '7C0A·11F4·9B2E·D6A3',
            createdAt: '2026-07-02T00:00:00.000Z',
            present: true,
            active: true,
            databaseKey: false,
            usage: { photos: 48, sidecars: 2, bytes: 1_240_000 },
          },
        ],
      }),
    export: () => Promise.resolve({ path: null }),
    pickFile: () => Promise.resolve({ path: null }),
    import: () => Promise.resolve({ outcome: 'refused' as const, keyId: null, fingerprint: null, unlocked: 0, reason: 'invalid' as const }),
    removePreflight: () =>
      Promise.resolve({
        allowed: false,
        reason: 'write-key' as const,
        tier: 'irreversible' as const,
        usage: { photos: 48, sidecars: 2, bytes: 1_240_000 },
        entry: null,
      }),
    remove: () => Promise.resolve({ removed: false, reason: 'write-key' as const, locked: 0 }),
    setLabel: () => Promise.resolve({}),
  };
  const restoreApi: OverlookApi['restore'] = {
    profileStatus: () => Promise.resolve({ fresh: false }),
    pickKey: () => Promise.resolve({ path: '/Users/ansel/Desktop/overlook-recovery.key' }),
    discover: () =>
      Promise.resolve({
        sessionId: 'story-session',
        libraries: [
          {
            libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
            generation: 7,
            generatedAt: '2026-07-14T23:00:00.000Z',
            photos: 1542,
            totalBytes: 48_000_000_000,
            excludedCount: 0,
            excludedBytes: 0,
            albums: 12,
            compatibility: 'compatible',
            validation: 'valid',
            fallbackGenerations: 1,
            resumable: true,
          },
        ],
        error: null,
      }),
    run: () =>
      Promise.resolve({
        result: {
          libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
          generation: 7,
          photos: 1542,
          resumed: true,
          fallbackFromGeneration: 9,
          relaunching: true,
          missing: [],
        },
        error: null,
      }),
    verify: () =>
      Promise.resolve({
        result: {
          verificationId: 'story-verification',
          libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
          generation: 7,
          photos: 1542,
          verifiedCount: 1542,
          missingCount: 0,
          corruptCount: 0,
          missing: [],
        },
        error: null,
      }),
    trash: () => Promise.resolve({ trashed: false, error: null }),
    exportCsv: () => Promise.resolve({ exported: false, path: null, error: null }),
    exportCorrupt: () => Promise.resolve({ exported: false, count: 0, unavailable: 0, error: null }),
    cancel: () => Promise.resolve({}),
    status: () =>
      Promise.resolve({
        phase: 'idle',
        sessionId: null,
        libraryId: null,
        providerId: null,
        progress: null,
        lastError: null,
        lastResult: null,
        verification: null,
        libraries: [],
      }),
    onProgress: () => () => undefined,
    onStatusChanged: () => () => undefined,
  };
  const appLockListeners = new Set<Parameters<OverlookApi['appLock']['onChanged']>[0]>();
  const appLockApi: OverlookApi['appLock'] = {
    status: () =>
      Promise.resolve({
        state: options?.appLockConfigured === true ? ('unlocked' as const) : ('unconfigured-unlocked' as const),
        libraryId: options?.appLockConfigured === true ? 'story-library' : null,
        retryAfterMs: 0,
        attemptsRemaining: 3,
      }),
    unlock: () => Promise.resolve({ ok: true, reason: null, retryAfterMs: 0, attemptsRemaining: 3 }),
    configure: () => Promise.resolve({ state: 'locked', libraryId: 'story-library', retryAfterMs: 0, attemptsRemaining: 3 }),
    lockNow: () => Promise.resolve({ state: 'locked', libraryId: 'story-library', retryAfterMs: 0, attemptsRemaining: 3 }),
    changePassword: () => Promise.resolve({ changed: true, reason: null, retryAfterMs: 0, attemptsRemaining: 3 }),
    anchorPolicyStatus: () => Promise.resolve({ policy: 'usability' }),
    setAnchorPolicy: () => Promise.resolve({ changed: true, reason: null, retryAfterMs: 0, attemptsRemaining: 3 }),
    remove: () => Promise.resolve({ removed: true, reason: null, retryAfterMs: 0, attemptsRemaining: 3 }),
    pickRecovery: () => Promise.resolve({ path: null }),
    recover: () => Promise.resolve({ recovered: false, reason: 'invalid' }),
    touchIdStatus: () => Promise.resolve({ available: false, reason: 'unsigned-build', enabled: false, reenrollmentRequired: false }),
    touchIdEnable: () => Promise.resolve({ enabled: false, reason: 'unsigned-build', retryAfterMs: 0, attemptsRemaining: 3 }),
    touchIdDisable: () => Promise.resolve({ disabled: true }),
    touchIdUnlock: () => Promise.resolve({ ok: false, reason: 'not-enabled', retryAfterMs: 0, attemptsRemaining: 3 }),
    onChanged: (listener) => {
      appLockListeners.add(listener);
      return () => appLockListeners.delete(listener);
    },
    onTouchIdChanged: () => () => undefined,
  };
  let diagnosticReports: Awaited<ReturnType<OverlookApi['diagnostics']['list']>>['reports'] = [
    {
      eventId: '98f581d6-ef9a-45e2-ae19-8b90099aef2e',
      capturedAt: '2026-07-17T10:00:00.000Z',
      kind: 'renderer-process-gone',
      payload:
        '{"schemaVersion":1,"eventId":"98f581d6-ef9a-45e2-ae19-8b90099aef2e","capturedAt":"2026-07-17T10:00:00.000Z","appVersion":"0.27.0","platform":"darwin","arch":"arm64","kind":"renderer-process-gone","reason":"crashed","exitCode":5}',
      encryptedBytes: 384,
    },
  ];
  const diagnosticsApi: OverlookApi['diagnostics'] = {
    list: () => Promise.resolve({ reports: diagnosticReports }),
    delete: ({ eventId }) => {
      const deleted = diagnosticReports.some((report) => report.eventId === eventId);
      diagnosticReports = diagnosticReports.filter((report) => report.eventId !== eventId);
      return Promise.resolve({ deleted });
    },
    purge: () => {
      const deleted = diagnosticReports.length;
      diagnosticReports = [];
      return Promise.resolve({ deleted });
    },
    export: () => Promise.resolve({ exported: true, count: diagnosticReports.length }),
  };
  const fileProviderSnapshot: Awaited<ReturnType<OverlookApi['fileProvider']['status']>> = {
    available: false,
    reason: 'unsigned-build',
    config: { version: 1, enabled: false, consentVersion: 1, scope: { kind: 'library' } },
    albums: [],
  };
  const fileProviderApi: OverlookApi['fileProvider'] = {
    status: () => Promise.resolve(fileProviderSnapshot),
    enable: () => Promise.resolve(fileProviderSnapshot),
    disable: () => Promise.resolve(fileProviderSnapshot),
  };
  let interopStatus: Awaited<ReturnType<OverlookApi['interop']['status']>> = {
    provider: { provider: 'pcloud', status: 'not-connected', busy: false },
    pairing: { status: 'not-configured', pairingId: null, keyId: null, createdAt: null },
    batches: [],
    selectedTransferId: null,
    progress: { transferId: null, phase: 'queued', processed: 0, total: 0, accepted: 0, retained: 0 },
    error: null,
  };
  const interopListeners = new Set<Parameters<OverlookApi['interop']['onChanged']>[0]>();
  const interopUnlock =
    options?.deferInteropUnlock === true
      ? new Promise<void>((resolve) => {
          storyWindow.releaseInteropUnlock = resolve;
        })
      : Promise.resolve();
  const setInterop = (next: typeof interopStatus): Promise<typeof interopStatus> => {
    interopStatus = next;
    for (const listener of interopListeners) listener(next);
    return Promise.resolve(next);
  };
  const interopApi: OverlookApi['interop'] = {
    status: () => Promise.resolve(interopStatus),
    localStatus: () =>
      Promise.resolve({ status: 'unavailable', operation: null, operationId: null, remoteSessionId: null, retryable: true }),
    connectProvider: () => setInterop({ ...interopStatus, provider: { provider: 'pcloud', status: 'connected', busy: false } }),
    disconnectProvider: () => setInterop({ ...interopStatus, provider: { provider: 'pcloud', status: 'not-connected', busy: false } }),
    selectPairing: () =>
      setInterop({
        ...interopStatus,
        pairing: {
          status: 'locked',
          pairingId: 'd9afc67d-781c-4e8b-a396-bcf8c4fc9739',
          keyId: 'interop:81ad4f06-0ecf-4a24-8c65-fcd34075cf15',
          createdAt: '2026-07-21T12:00:00.000Z',
        },
      }),
    unlockPairing: async () => {
      await interopUnlock;
      return setInterop({ ...interopStatus, pairing: { ...interopStatus.pairing, status: 'unlocked' } });
    },
    refresh: () =>
      setInterop({
        ...interopStatus,
        selectedTransferId: 'fc0b0b81-114f-480b-8ff6-a1531e57b605',
        batches: [
          {
            transferId: 'fc0b0b81-114f-480b-8ff6-a1531e57b605',
            counts: {
              total: 2,
              eligible: 1,
              duplicate: 0,
              conflict: 0,
              metadataOnly: 1,
              unsupported: 0,
              skipped: 0,
              failed: 0,
              acknowledged: 0,
              finalized: 0,
            },
            items: [
              {
                interopId: '665fc4f8-8287-42db-b195-f7828d530da8',
                label: 'Mountain',
                reviewCategory: 'eligible',
                original: 'available',
                outcome: 'pending',
                reason: null,
              },
            ],
          },
        ],
        progress: {
          transferId: 'fc0b0b81-114f-480b-8ff6-a1531e57b605',
          phase: 'reviewing',
          processed: 0,
          total: 2,
          accepted: 0,
          retained: 0,
        },
      }),
    start: () => Promise.resolve(interopStatus),
    pause: () => Promise.resolve(interopStatus),
    resume: () => Promise.resolve(interopStatus),
    cancel: () => Promise.resolve(interopStatus),
    retry: () => Promise.resolve(interopStatus),
    onChanged: (listener) => {
      interopListeners.add(listener);
      return () => interopListeners.delete(listener);
    },
    onLocalChanged: () => () => undefined,
  };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = {
    settings: settingsApi,
    themes: {
      list: () => Promise.resolve({ themes: [], activeId: current.userTheme }),
      pickImport: () => Promise.resolve({ status: 'cancelled' }),
      importPath: () => Promise.resolve({ status: 'cancelled' }),
      exportTemplate: () => Promise.resolve({ status: 'cancelled' }),
      active: () => Promise.resolve({ theme: null, notice: null }),
      preview: () => Promise.reject(new Error('No story theme installed')),
      previewHealthy: () => Promise.resolve({ accepted: false }),
      confirm: () => Promise.resolve({ confirmed: false, settings: current }),
      cancel: () => Promise.resolve({ cancelled: false }),
      remove: () => Promise.resolve({ removed: false, settings: current }),
      reset: () => {
        apply({ appearance: 'dark', userTheme: null });
        return Promise.resolve({ settings: current });
      },
    },
    embedding: createEmbeddingStoryController().api,
    backup: backupApi,
    keys: keysApi,
    keyring: keyringApi,
    disclosure: {
      policy: () => Promise.resolve({ policy: DEFAULT_DISCLOSURE_POLICY, pinned: [...PINNED_PRIVATE] }),
      setField: ({ field, class: cls }) =>
        Promise.resolve({ policy: { ...DEFAULT_DISCLOSURE_POLICY, fields: { ...DEFAULT_DISCLOSURE_POLICY.fields, [field]: cls } } }),
      overrides: () => Promise.resolve({ overrides: [] }),
      setOverride: () => Promise.resolve({ overrides: [] }),
      preview: () => Promise.reject(new Error('unused')),
    },
    restore: restoreApi,
    appLock: appLockApi,
    diagnostics: diagnosticsApi,
    fileProvider: fileProviderApi,
    interop: interopApi,
    import: {
      pathForFile: (file: File) => `/Users/ansel/Desktop/${file.name}`,
    } as unknown as OverlookApi['import'],
    library: {
      albums: () => Promise.resolve({ albums: [{ id: 'family', name: 'Family', count: 4 }] }),
      stats: () =>
        Promise.resolve({
          photos: 1542,
          bytes: 48_000_000_000,
          pending: 0,
          lastBackupAt: null,
          offloadedBytes: 12_600_000_000,
          excludedCount: 0,
          excludedBytes: 0,
          pendingRemovals: 0,
        }),
      galleryPolicy: () => Promise.resolve({ policy: { showUnavailable: true, minimumMegapixels: null } }),
      setGalleryPolicy: ({ policy }: { policy: { showUnavailable: boolean; minimumMegapixels: number | null } }) =>
        Promise.resolve({ policy }),
      onChanged: () => () => undefined,
      onPendingCountChanged: () => () => undefined,
      onStorageChanged: () => () => undefined,
    } as unknown as OverlookApi['library'],
    protectedAlbums: {
      list: () => Promise.resolve({ albums: [] }),
      onChanged: () => () => undefined,
    } as unknown as OverlookApi['protectedAlbums'],
  };
}

function SettingsRestoreHost(props: SettingsDialogProps): ReactElement {
  const [restoreOpen, setRestoreOpen] = useState(false);
  return (
    <>
      <SettingsDialog {...props} onRestore={() => setRestoreOpen(true)} />
      {restoreOpen ? (
        <Dialog open title="Restore from cloud backup" icon="cloud-download" width={640} onClose={() => setRestoreOpen(false)}>
          <RestoreWorkflow context="settings" />
        </Dialog>
      ) : null}
    </>
  );
}

const meta: Meta<typeof SettingsDialog> = {
  title: 'App/SettingsDialog',
  component: SettingsDialog,
  args: { open: true, onClose: fn(), selectedPhotoIds: ['offloaded-1', 'offloaded-2'] },
  render: (args) => <SettingsRestoreHost {...args} />,
  decorators: [
    (Story) => {
      installStub();
      return (
        <AppStateProvider>
          <Story />
        </AppStateProvider>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof SettingsDialog>;

export const StorageOpensByDefault: Story = {
  decorators: [
    (Story) => {
      installStub({ deferInitialProviderStatus: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = body.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expect(body.getByRole('tablist', { name: 'Settings sections' })).toHaveAttribute('aria-orientation', 'vertical');
    await Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished));
    const loadingBounds = dialog.getBoundingClientRect();
    const storage = body.getByRole('tab', { name: 'Storage & Backup' });
    await expect(storage).toHaveAttribute('aria-selected', 'true');
    // A slow provider check stays neutral: never claim the selected provider
    // is disconnected or offer connection actions before truth resolves.
    await waitFor(() => expect(body.getByText('Checking connection…')).toBeVisible());
    await expect(body.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    await expect(body.queryByText('Not connected')).not.toBeInTheDocument();
    await expect(body.queryByText('Link a provider to store encrypted originals off-device.')).not.toBeInTheDocument();
    await waitFor(() => expect(body.getByText('Checking backup provider before restoring…')).toBeVisible());
    await expect(body.queryByText('Connect the backup provider to restore.')).not.toBeInTheDocument();
    await expect(body.queryByRole('button', { name: 'Restore selected (2)' })).not.toBeInTheDocument();
    await expect(body.queryByRole('button', { name: 'Restore all' })).not.toBeInTheDocument();
    const storyWindow = canvasElement.ownerDocument.defaultView as StoryWindow | null;
    if (storyWindow?.releaseInitialProviderStatus === undefined) throw new Error('expected deferred provider status');
    storyWindow.releaseInitialProviderStatus();
    // The real pane (#114): connected card with live quota + enabled knobs.
    await waitFor(() => expect(body.getByText('Connected')).toBeVisible());
    const resolvedBounds = dialog.getBoundingClientRect();
    await expect(resolvedBounds.width).toBeCloseTo(loadingBounds.width, 0);
    await expect(resolvedBounds.height).toBeCloseTo(loadingBounds.height, 0);
    await expect(body.getByText('380 GB of 500 GB used')).toBeVisible();
    await expect(body.getByRole('switch', { name: 'Back up new imports automatically' })).toBeVisible();
    await expect(body.getByText('12.6 GB stored only in your verified cloud backup. Thumbnails remain on this Mac.')).toBeVisible();
    await expect(body.queryByText('Checking backup provider before restoring…')).not.toBeInTheDocument();
    await expect(body.getByRole('button', { name: 'Restore selected (2)' })).toBeEnabled();
    await expect(body.getByRole('button', { name: 'Restore all' })).toBeEnabled();
    await userEvent.click(body.getByRole('button', { name: 'Restore selected (2)' }));
    await waitFor(() => expect(body.getByText('2 restored')).toBeVisible());
  },
};

export const DisconnectHidesBackupControls: Story = {
  decorators: [
    (Story) => {
      installStub({ deferProviderDisconnect: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByRole('button', { name: 'Disconnect provider' })).toBeVisible());
    const card = body.getByTestId('provider-card');
    await userEvent.click(body.getByRole('button', { name: 'Disconnect provider' }));
    const confirmation = body.getByRole('dialog', { name: 'Disconnect Local mock?' });
    await expect(confirmation).toHaveTextContent('This removes this device’s saved Local mock authorization.');
    await expect(confirmation).toHaveTextContent('Encrypted data already stored in Local mock is not deleted.');
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    await expect(card).toHaveTextContent('Connected');
    await expect((globalThis as unknown as StoryWindow).disconnectCalls).toBe(0);
    await waitFor(() => expect(body.queryByRole('dialog', { name: 'Disconnect Local mock?' })).not.toBeInTheDocument());

    await userEvent.click(body.getByRole('button', { name: 'Disconnect provider' }));
    const reopenedConfirmation = await waitFor(() => body.getByRole('dialog', { name: 'Disconnect Local mock?' }));
    await userEvent.click(within(reopenedConfirmation).getByRole('button', { name: 'Disconnect provider' }));
    const pendingButtons = await waitFor(() => body.getAllByRole('button', { name: 'Disconnecting…' }));
    await expect(pendingButtons).toHaveLength(2);
    await expect(pendingButtons[0]).toBeDisabled();
    await expect(pendingButtons[1]).toBeDisabled();
    await expect(card).toHaveTextContent('Disconnecting…');
    const storyWindow = globalThis as unknown as StoryWindow;
    await expect(storyWindow.disconnectCalls).toBe(1);
    if (storyWindow.releaseProviderDisconnect === undefined) throw new Error('expected deferred provider disconnect');
    storyWindow.releaseProviderDisconnect();

    // Updated design (#239): the backup-specific controls HIDE instead of
    // disabling — only the connection card, re-offload policy, import
    // Copy/Move (no provider needed), and the locked Encrypt switch remain.
    await waitFor(() => expect(body.getByText('Not connected')).toBeVisible());
    await expect(body.getByText('Link a provider to store encrypted originals off-device.')).toBeVisible();
    await expect(body.queryByRole('switch', { name: 'Back up new imports automatically' })).not.toBeInTheDocument();
    await expect(body.queryByRole('switch', { name: 'Wi-Fi only' })).not.toBeInTheDocument();
    await expect(body.queryByRole('slider', { name: 'Upload bandwidth limit' })).not.toBeInTheDocument();
    await expect(body.getByRole('button', { name: 'Restore selected (2)' })).toBeDisabled();
    await expect(body.getByRole('button', { name: 'Restore all' })).toBeDisabled();
    await expect(body.getByText('Connect the backup provider to restore.')).toBeVisible();
    await expect(body.getByRole('radio', { name: 'Copy' })).toBeEnabled();
    await expect(body.getByRole('radio', { name: 'Move' })).toBeEnabled();
    // Re-offload remains a user policy while disconnected; Encrypt is locked on.
    const switches = body.getAllByRole('switch');
    await expect(switches).toHaveLength(2);
    await expect(switches[0]).toBeEnabled();
    await expect(switches[1]).toBeDisabled();

    // Reconnect: instant with the mock, quota and the knobs return.
    await userEvent.click(body.getByRole('button', { name: 'Connect Local mock' }));
    await waitFor(() => expect(body.getByText('Connected')).toBeVisible());
    await expect(body.getByText('380 GB of 500 GB used')).toBeVisible();
    await expect(body.getByRole('switch', { name: 'Back up new imports automatically' })).toBeVisible();
  },
};

export const DisconnectBlockedByCloudOnlyCustody: Story = {
  decorators: [
    (Story) => {
      installStub({
        accountLabel: 'm.rivera@example.com',
        disconnectPreflight: {
          ok: false,
          reason: 'Restore cloud-only originals before disconnecting.',
          code: 'custody-restore-required',
          retryable: false,
          custody: {
            credential: { providerId: 'mock', accountId: 'mock-account' },
            totalItems: 3,
            totalBytes: 6_300_000_000,
            libraries: [
              {
                libraryId: 'library-main',
                name: 'Rivera Archive',
                items: 3,
                bytes: 6_300_000_000,
                legacyUnbound: false,
              },
            ],
          },
        },
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole('button', { name: 'Disconnect provider' }));
    const confirmation = body.getByRole('dialog', { name: 'Disconnect Local mock?' });
    await waitFor(() => expect(confirmation).toHaveTextContent('3 cloud-only originals (6.3 GB)'));
    await expect(confirmation).toHaveTextContent('Rivera Archive: 3 originals · 6.3 GB');
    await expect(confirmation).toHaveTextContent('m.rivera@example.com');
    await expect(within(confirmation).getByRole('button', { name: 'Copy provider account ID' })).toBeVisible();
    await expect(within(confirmation).getByRole('button', { name: 'Copy library ID library-main' })).toBeVisible();
    await expect(confirmation.querySelector('.mono-data')).not.toBeNull();
    await expect(confirmation).not.toHaveTextContent('Encrypted data already stored in Local mock is not deleted.');
    await expect(within(confirmation).getByRole('button', { name: 'Restore all originals first' })).toBeEnabled();
    await expect(within(confirmation).getByRole('button', { name: 'Remove authorization anyway…' })).toBeEnabled();

    await userEvent.click(within(confirmation).getByRole('button', { name: 'Remove authorization anyway…' }));
    const emergency = body.getByRole('dialog', { name: 'Remove Local mock authorization anyway?' });
    await expect(emergency).toHaveTextContent('Reconnect Local mock as m.rivera@example.com');
    await expect(emergency).toHaveTextContent('cloud-only originals require reconnecting the same provider account');
    await userEvent.click(within(emergency).getByRole('button', { name: 'Remove authorization anyway' }));
    await expect((globalThis as unknown as StoryWindow).removeAuthorizationRequests).toEqual([
      { providerId: 'mock', authorization: PROVIDER_AUTHORIZATION_REMOVAL },
    ]);
  },
};

export const ProviderRequiredRecoveryBanner: Story = {
  decorators: [
    (Story) => {
      installStub({
        custodyRequirements: [
          {
            providerId: 'google-drive',
            accountId: 'google-account',
            accountLabel: 'm.rivera@gmail.com',
            items: 4,
            bytes: 8_400_000_000,
          },
        ],
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const banner = await body.findByRole('status');
    await expect(banner).toHaveTextContent('Google Drive required');
    await expect(banner).toHaveTextContent('Reconnect Google Drive as m.rivera@gmail.com');
    await expect(banner).toHaveTextContent('4 · 8.4 GB');
    await expect(within(banner).getByRole('button', { name: 'Copy provider account ID' })).toBeVisible();
    await expect(banner).toHaveClass('ovl-settings__custodyRequirement');
  },
};

export const ProviderSelectionAndUnknownQuota: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByRole('button', { name: 'Disconnect provider' })).toBeVisible());
    await userEvent.click(body.getByRole('button', { name: 'Disconnect provider' }));
    await userEvent.click(
      within(body.getByRole('dialog', { name: 'Disconnect Local mock?' })).getByRole('button', { name: 'Disconnect provider' }),
    );
    await userEvent.click(await waitFor(() => body.getByRole('radio', { name: 'iCloud Drive' })));
    await userEvent.click(body.getByRole('button', { name: 'Connect iCloud Drive' }));
    // iCloud has no account-quota API — no bar, and an honest System Settings
    // capacity route instead of a fabricated measurement.
    await waitFor(() => expect(body.getByRole('button', { name: /View in System Settings/u })).toBeVisible());
    await expect(body.queryByRole('progressbar')).not.toBeInTheDocument();
    await expect(body.getByText(/Verify by download/u)).toBeVisible();
  },
};

export const ICloudUnavailableSetup: Story = {
  decorators: [
    (Story) => {
      installStub({ iCloudAvailable: false });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByRole('button', { name: 'Disconnect provider' })).toBeVisible());
    await userEvent.click(body.getByRole('button', { name: 'Disconnect provider' }));
    await userEvent.click(
      within(body.getByRole('dialog', { name: 'Disconnect Local mock?' })).getByRole('button', { name: 'Disconnect provider' }),
    );
    await expect(await waitFor(() => body.getByRole('radio', { name: 'iCloud Drive' }))).toBeDisabled();
    await expect(body.getByText('iCloud Drive: iCloud Drive requires a provisioned signed macOS build.')).toBeVisible();
  },
};

export const GoogleDriveSelection: Story = {
  args: { onProviderSelection: fn() },
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByRole('button', { name: 'Disconnect provider' })).toBeVisible());
    await userEvent.click(body.getByRole('button', { name: 'Disconnect provider' }));
    await userEvent.click(
      within(body.getByRole('dialog', { name: 'Disconnect Local mock?' })).getByRole('button', { name: 'Disconnect provider' }),
    );
    await userEvent.click(await waitFor(() => body.getByRole('radio', { name: 'Google Drive' })));
    await expect(args.onProviderSelection).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'google-drive', label: 'Google Drive' }));
    await userEvent.click(body.getByRole('button', { name: 'Connect Google Drive' }));
    // Google Drive: account-wide capacity comes from about.storageQuota.
    await waitFor(() => expect(body.getByText('42 GB of 100 GB used')).toBeVisible());
    await expect(body.getByText(/Server checksum · resumable uploads/u)).toBeVisible();
    const storyWindow = globalThis as unknown as StoryWindow;
    await expect(storyWindow.providerStorageCalls?.['google-drive']).toBe(1);
    storyWindow.backupCompletedListener?.({
      uploaded: 1,
      failed: 0,
      manifestUploaded: true,
      auto: false,
      integrity: { checked: 1, repaired: 0, unrecoverable: 0, recoveryRepaired: false, failed: false },
    });
    await waitFor(() => expect(storyWindow.providerStorageCalls?.['google-drive']).toBe(2));
  },
};

export const RestoreDiscoveryAndWarnings: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const restoreButton = await waitFor(() => body.getByRole('button', { name: 'Restore library…' }));
    await userEvent.click(restoreButton);
    await expect(body.getByRole('dialog', { name: 'Restore from cloud backup' })).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: /^Choose recovery key/u }));
    await userEvent.type(body.getByLabelText('Recovery-key password'), 'correct horse battery staple');
    await userEvent.click(body.getByRole('button', { name: 'Discover backups' }));
    await waitFor(() => expect(body.getByTestId('restore-library-card')).toHaveTextContent('1,542 photos'));
    await expect(body.getByText('1 retained fallback generation available')).toBeVisible();
    await expect(body.getByText('Verified staged work is ready to resume')).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Verify backup' }));
    // #994: a clean verify stays on the results screen. Heal is the explicit
    // step to the confirmation; it is no longer an automatic advance.
    const heal = await waitFor(() => body.getByRole('button', { name: /^Heal\b/u }));
    await userEvent.click(heal);
    await waitFor(() => expect(body.getByText('This replaces the active library.')).toBeVisible());
    await expect(body.getByRole('button', { name: 'Restore 1,542 photos' })).toBeDisabled();
    await userEvent.click(
      body.getByRole('checkbox', { name: 'I understand that the active local library will be replaced after validation.' }),
    );
    await expect(body.getByRole('button', { name: 'Restore 1,542 photos' })).toBeEnabled();
    await userEvent.click(body.getByRole('button', { name: 'Restore 1,542 photos' }));
    await waitFor(() => expect(body.getByText('Restore complete')).toBeVisible());
    await expect(body.getByText('Generation 9 failed validation; restored generation 7.')).toBeVisible();
  },
};

export const RestoreRecoveryKeyDrop: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await waitFor(() => body.getByRole('button', { name: 'Restore library…' })));
    const target = body.getByTestId('recovery-key-drop-target');
    const dropFiles = (...files: File[]): Promise<boolean> => {
      const dataTransfer = new DataTransfer();
      Object.defineProperty(dataTransfer, 'files', { configurable: true, value: files });
      return fireEvent.drop(target, { dataTransfer });
    };

    await dropFiles(new File(['first'], 'first.key'), new File(['second'], 'second.key'));
    await expect(body.getByRole('alert')).toHaveTextContent('one recovery-key file at a time');

    await dropFiles(new File(['notes'], 'notes.txt'));
    await expect(body.getByRole('alert')).toHaveTextContent('Overlook .key recovery file');

    await dropFiles(new File(['key'], 'overlook-recovery.key'));
    await expect(body.getByText('overlook-recovery.key')).toBeVisible();
    await expect(body.getByRole('button', { name: /^Choose recovery key overlook-recovery\.key/u })).toBeVisible();
    await expect(body.queryByRole('alert')).not.toBeInTheDocument();
  },
};

export const NavSwitchesPanes: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('tab', { name: 'General' }));
    await expect(body.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(body.getByText('Default sort order')).toBeVisible());
    await userEvent.click(body.getByRole('tab', { name: 'Privacy' }));
    await expect(body.getByText('End-to-end encryption')).toBeVisible();
  },
};

export const DirectPrivacyRoute: Story = {
  args: { requestedSection: 'privacy' },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('tab', { name: 'Privacy' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(body.getByText('End-to-end encryption')).toBeVisible());
  },
};

export const ContentOwnsScrolling: Story = {
  render: (args) => (
    <div style={{ position: 'relative', height: 380 }}>
      <SettingsDialog {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('tab', { name: 'Privacy' }));
    const pane = body.getByTestId('settings-pane');
    const nav = body.getByRole('tablist', { name: 'Settings sections' });
    const dialogBody = pane.parentElement?.parentElement;
    if (dialogBody === null || dialogBody === undefined) throw new Error('settings dialog body missing');

    await expect(getComputedStyle(dialogBody).overflowY).toBe('hidden');
    await expect(getComputedStyle(pane).overflowY).toBe('auto');
    await expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight);
    const navTop = nav.getBoundingClientRect().top;
    pane.scrollTop = 120;
    await expect(pane.scrollTop).toBeGreaterThan(0);
    await expect(nav.getBoundingClientRect().top).toBe(navTop);

    await userEvent.click(body.getByRole('tab', { name: 'General' }));
    await expect(pane).toHaveAttribute('data-section', 'general');
    await expect(pane.scrollTop).toBe(0);

    // Vertical only (#1285): the pane states overflow-x, and every section's
    // rows wrap to its width instead of adding a horizontal scrollbar.
    await expect(getComputedStyle(pane).overflowX).toBe('hidden');
    for (const section of ['General', 'Storage & Backup', 'Privacy']) {
      await userEvent.click(body.getByRole('tab', { name: section }));
      await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
    }
  },
};

export const TransferAndSyncAction: Story = {
  args: { onTransfer: fn(), transferEnabled: true },
  decorators: [
    (Story) => {
      installStub({ deferInteropUnlock: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('tab', { name: 'Transfer & Sync' }));
    await userEvent.click(await waitFor(() => body.getByRole('button', { name: 'Connect pCloud' })));
    const selectBundle = await waitFor(() => body.getByRole('button', { name: 'Select bundle…' }));
    await waitFor(() => expect(selectBundle).toBeEnabled());
    await userEvent.click(selectBundle);
    await waitFor(() => expect(body.getByTestId('interop-pairing-card')).toHaveTextContent('locked'));
    const password = await waitFor(() => body.getByLabelText('Pairing bundle password'));
    await userEvent.type(password, 'pairing password');
    await userEvent.click(body.getByRole('button', { name: 'Unlock for this session' }));
    await expect(password).toHaveValue('');
    (globalThis as unknown as StoryWindow).releaseInteropUnlock?.();
    await waitFor(() => expect(body.queryByLabelText('Pairing bundle password')).not.toBeInTheDocument());
    await userEvent.click(body.getByRole('button', { name: 'Check for incoming transfers' }));
    const action = await waitFor(() => body.getByRole('button', { name: 'Review 2 incoming items' }));

    await expect(body.getByText('Outbound Move and Sync are not available yet.')).toBeVisible();
    action.focus();
    await expect(action).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onTransfer).toHaveBeenCalledOnce();

    const pane = body.getByTestId('settings-pane');
    await expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(pane.getBoundingClientRect().right + 1);
  },
};

export const PrivacySection: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('tab', { name: 'Privacy' }));

    // Recovery key row (#240): fingerprint + both KeyDialog entry points.
    await waitFor(() => expect(body.getByTestId('recovery-key-row')).toHaveTextContent('9F2C·4A81·D0E7·5B3A'));
    await userEvent.click(body.getByRole('button', { name: 'Back up…' }));
    await expect(body.getByRole('dialog', { name: 'Back up encryption key' })).toBeVisible();
    // Stacked modals (PR #250 review): Escape closes ONLY the top dialog —
    // Settings stays open underneath.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('dialog', { name: 'Back up encryption key' })).not.toBeInTheDocument());
    await expect(body.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Import…' }));
    await expect(body.getByRole('dialog', { name: 'Import encryption key' })).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(body.queryByRole('dialog', { name: 'Import encryption key' })).not.toBeInTheDocument());

    // Factual, always-on encryption row.
    await waitFor(() => expect(body.getByText('Always on')).toBeVisible());
    await expect(body.getByText('Originals and thumbnails are encrypted on this device before leaving it.')).toBeVisible();

    // Face grouping is deferred — disabled and OFF, never faked as active.
    const switches = body.getAllByRole('switch');
    const faceGrouping = switches.at(-2);
    const diagnostics = switches.at(-1);
    if (faceGrouping === undefined || diagnostics === undefined) {
      throw new Error('expected the face-grouping and diagnostics switches');
    }
    await expect(faceGrouping).toBeDisabled();
    await expect(faceGrouping).not.toBeChecked();
    await expect(body.getByText('Not yet available — will run entirely on-device when it ships.')).toBeVisible();

    // Diagnostics: off by default, honest local-only copy, persists via the
    // store stub.
    await expect(diagnostics).not.toBeChecked();
    await expect(
      body.getByText('Anonymous crash reports only — never photo content or metadata. Reporting stays local-only for now.'),
    ).toBeVisible();
    await userEvent.click(diagnostics);
    await waitFor(() => expect(diagnostics).toBeChecked());
    await waitFor(() => expect(body.getByText('1 pending local report')).toBeVisible());
    await userEvent.click(body.getByRole('button', { name: 'Review reports…' }));
    await expect(body.getByRole('dialog', { name: 'Review diagnostics' })).toBeVisible();
    await expect(body.getByText(/"kind":"renderer-process-gone"/u)).toBeVisible();
    await expect(body.getByText('Nothing is sent.', { exact: false })).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Export JSONL…' }));
    await expect(body.getByText('1 report exported.')).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Clear report…' }));
    const clearConfirmation = body.getByRole('dialog', { name: 'Clear diagnostic report?' });
    await expect(clearConfirmation).toHaveTextContent('This cannot be undone.');
    await userEvent.click(within(clearConfirmation).getByRole('button', { name: 'Clear report' }));
    await expect(body.getByText('No reports are waiting locally.')).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Done' }));
  },
};

export const HardenedAnchorProtection: Story = {
  decorators: [
    (Story) => {
      installStub({ appLockConfigured: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('tab', { name: 'Privacy' }));
    const hardened = await waitFor(() => body.getByRole('switch', { name: 'Hardened anchor protection' }));
    await expect(hardened).toBeEnabled();
    await expect(hardened).not.toBeChecked();
    await userEvent.click(hardened);
    await expect(body.getByRole('dialog', { name: 'Back up encryption key' })).toBeVisible();
    await expect(body.getByText(/requires a freshly exported recovery key/u)).toBeVisible();
  },
};

export const KeyboardOperable: Story = {
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    // The tablist is reachable after the header's Close control; arrows
    // move and activate sections without adding extra Tab stops.
    await userEvent.tab();
    await userEvent.tab();
    await expect(body.getByRole('tab', { name: 'Storage & Backup' })).toHaveFocus();
    await expect(body.getByRole('tab', { name: 'Storage & Backup' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowUp}');
    await expect(body.getByRole('tab', { name: 'General' })).toHaveFocus();
    await waitFor(() => expect(body.getByText('Default sort order')).toBeVisible());
    // Esc closes from anywhere inside the dialog.
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => expect(args.onClose).toHaveBeenCalled());
  },
};

export const GeneralSection: Story = {
  decorators: [
    (Story) => {
      installStub({ deferQuickActionSettings: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('tab', { name: 'General' }));
    await waitFor(() => expect(body.getByRole('radio', { name: 'Date' })).toBeChecked());

    // Sort change round-trips through the store stub.
    await userEvent.click(body.getByRole('radio', { name: 'Name' }));
    await waitFor(() => expect(body.getByRole('radio', { name: 'Name' })).toBeChecked());

    // Language uses the persisted profile setting and keeps system default as
    // the explicit null choice. A change is applied without closing Settings.
    const language = body.getByRole('combobox', { name: 'Language' });
    await expect(language).toHaveValue('');
    await userEvent.selectOptions(language, 'en');
    await waitFor(() => expect(language).toHaveValue('en'));
    await userEvent.selectOptions(language, '');
    await waitFor(() => expect(language).toHaveValue(''));

    // Retention is a live library setting with the bounded ADR-0023 choices.
    await expect(body.getByRole('radio', { name: '30 days' })).toBeChecked();
    await userEvent.click(body.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(body.getByRole('radio', { name: 'Off' })).toBeChecked());
    await userEvent.click(body.getByRole('radio', { name: '90 days' }));
    await waitFor(() => expect(body.getByRole('radio', { name: '90 days' })).toBeChecked());

    // Appearance applies all persisted first-party modes live.
    await expect(body.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await userEvent.click(body.getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(body.getByRole('radio', { name: 'Light' })).toBeChecked());
    await userEvent.click(body.getByRole('radio', { name: 'System' }));
    await waitFor(() => expect(body.getByRole('radio', { name: 'System' })).toBeChecked());
    await expect(body.getByText('Changes apply immediately. System follows your operating-system appearance.')).toBeVisible();

    // Quick Actions are profile-scoped, ordered, and may be disabled.
    await expect(body.getByRole('switch', { name: 'Export…' })).toBeChecked();
    await userEvent.click(body.getByRole('switch', { name: 'Move photo to Trash' }));
    await expect(body.getByRole('switch', { name: 'Move photo to Trash' })).not.toBeChecked();
    await userEvent.click(body.getByRole('switch', { name: 'Restore photo' }));
    await expect((globalThis as unknown as StoryWindow).quickActionPatches).toEqual([
      ['photo.favorite.toggle', 'album.membership.add', 'photo.export'],
      ['photo.favorite.toggle', 'album.membership.add', 'photo.export', 'photo.restore'],
    ]);
    await userEvent.click(body.getByRole('button', { name: 'Up — Move Restore photo up' }));
    await expect(body.getByRole('button', { name: 'Down — Move Restore photo down' })).toBeEnabled();

    // Thumbnails: locked on with the rationale.
    await expect(body.getByRole('switch', { name: 'Generate thumbnails on import' })).toBeChecked();
    await expect(body.getByRole('switch', { name: 'Generate thumbnails on import' })).toBeDisabled();
    await expect(body.getByText('The grid browses thumbnails, even offline. Cannot be disabled.')).toBeVisible();
  },
};

export const GeneralRightToLeft: Story = {
  globals: { locale: 'en-XB' },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvasElement.ownerDocument.documentElement).toHaveAttribute('dir', 'rtl'));
    const dialog = body.getByRole('dialog');
    const nav = body.getByRole('tablist');
    const general = within(nav).getAllByRole('tab')[0];
    if (general === undefined) throw new Error('general settings navigation item missing');
    await userEvent.click(general);
    const pane = body.getByTestId('settings-pane');
    await waitFor(() => expect(within(pane).getAllByRole('combobox')[0]).toBeVisible());
    await expect(nav.getBoundingClientRect().left).toBeGreaterThan(pane.getBoundingClientRect().left);
    await expect(nav.getBoundingClientRect().right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right);
  },
};

export const GeneralExpandedPseudoLocale: Story = {
  globals: { locale: 'en-XA' },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = body.getByRole('dialog');
    const nav = body.getByRole('tablist');
    const general = within(nav).getAllByRole('tab')[0];
    if (general === undefined) throw new Error('general settings navigation item missing');
    await userEvent.click(general);
    await waitFor(() => expect(body.getByTestId('settings-pane')).toBeVisible());
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  },
};

// #1297 (Pass C spec, Nav): the dialog at a fixed width, so the stories show
// the layout its container query picks.
function dialogWidth(width: number): Decorator {
  const WithWidth: Decorator = (Story) => (
    <>
      <style>{`.ovl-dialog { width: ${String(width)}px !important; max-width: none !important; }`}</style>
      <Story />
    </>
  );
  return WithWidth;
}

// Measured once the dialog has finished entering: it scales in from 0.985,
// which would shrink every rect.
async function settingsNav(canvasElement: HTMLElement) {
  const body = within(canvasElement.ownerDocument.body);
  const dialog = body.getByRole('dialog');
  await Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished));
  return { body, dialog, nav: body.getByRole('tablist'), pane: body.getByTestId('settings-pane') };
}

// 640: the nav is a column beside the pane, as wide as its longest label
// within 160 to 200px, its left edge on the dialog title's.
export const NavAt640: Story = {
  decorators: [dialogWidth(640)],
  play: async ({ canvasElement }) => {
    const { body, dialog, nav, pane } = await settingsNav(canvasElement);
    await waitFor(() => expect(nav).toHaveAttribute('aria-orientation', 'vertical'));
    const width = nav.getBoundingClientRect().width;
    await expect(width).toBeGreaterThanOrEqual(160);
    await expect(width).toBeLessThanOrEqual(200);
    await expect(nav.getBoundingClientRect().right).toBeLessThanOrEqual(pane.getBoundingClientRect().left);
    const title = within(dialog).getByRole('heading', { level: 2 });
    const titleStart = title.parentElement?.getBoundingClientRect().left ?? Number.NaN;
    const headerPadding = Number.parseFloat(getComputedStyle(title.parentElement ?? title).paddingLeft);
    await expect(Math.round(nav.getBoundingClientRect().left)).toBe(Math.round(titleStart + headerPadding));
    await userEvent.click(body.getByRole('tab', { name: 'General' }));
    await userEvent.keyboard('{ArrowDown}');
    await expect(body.getByRole('tab', { name: 'Storage & Backup' })).toHaveFocus();
    await expect(body.getByRole('tab', { name: 'Storage & Backup' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}');
    await expect(body.getByRole('tab', { name: 'Privacy' })).toHaveFocus();
  },
};

// 448 (a 960px window at 200%): the tabs become a row above the pane; ←/→
// and ↑/↓ both move, and nothing scrolls sideways but the tab row.
export const NavAt448: Story = {
  decorators: [dialogWidth(448)],
  play: async ({ canvasElement }) => {
    const { body, dialog, nav, pane } = await settingsNav(canvasElement);
    await waitFor(() => expect(nav).toHaveAttribute('aria-orientation', 'horizontal'));
    await expect(nav.getBoundingClientRect().bottom).toBeLessThanOrEqual(pane.getBoundingClientRect().top);
    await userEvent.click(body.getByRole('tab', { name: 'General' }));
    await userEvent.keyboard('{ArrowRight}');
    await expect(body.getByRole('tab', { name: 'Storage & Backup' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(body.getByRole('tab', { name: 'Privacy' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    await userEvent.keyboard('{ArrowUp}');
    await expect(body.getByRole('tab', { name: 'General' })).toHaveFocus();
    await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    // Trash retention wraps under its label; Sort order stays inline.
    const row = (label: string): Element | null => within(pane).getByText(label).closest('.ovl-settings__field');
    const rects = (label: string): { text: DOMRect; control: DOMRect } => ({
      text: row(label)?.querySelector('.ovl-settings__fieldText')?.getBoundingClientRect() ?? new DOMRect(),
      control: row(label)?.querySelector('.ovl-settings__fieldControl')?.getBoundingClientRect() ?? new DOMRect(),
    });
    await expect(rects('Trash retention').control.top).toBeGreaterThanOrEqual(rects('Trash retention').text.bottom);
    await expect(rects('Default sort order').control.top).toBe(rects('Default sort order').text.top);
  },
};

// +40% pseudo-locale at 640: the nav stays within 160 to 200px and its
// labels wrap rather than truncate.
export const NavAt640ExpandedPseudoLocale: Story = {
  globals: { locale: 'en-XA' },
  decorators: [dialogWidth(640)],
  play: async ({ canvasElement }) => {
    const { nav } = await settingsNav(canvasElement);
    await waitFor(() => expect(nav).toHaveAttribute('aria-orientation', 'vertical'));
    const width = nav.getBoundingClientRect().width;
    await expect(width).toBeGreaterThanOrEqual(160);
    await expect(width).toBeLessThanOrEqual(200);
    for (const label of nav.querySelectorAll('[role="tab"] span')) {
      await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    }
  },
};

// +40% pseudo-locale at 448: a row of tabs; the row may scroll, the pane not.
export const NavAt448ExpandedPseudoLocale: Story = {
  globals: { locale: 'en-XA' },
  decorators: [dialogWidth(448)],
  play: async ({ canvasElement }) => {
    const { dialog, nav, pane } = await settingsNav(canvasElement);
    await waitFor(() => expect(nav).toHaveAttribute('aria-orientation', 'horizontal'));
    await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  },
};
