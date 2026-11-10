import { deleteUnownedRestoredOriginal, pruneUnverifiedCompletedBlobs, verifyRestoredCustody } from './restore-key-custody.js';
import { sidecarOwnerOf } from '../../shared/library/sidecar-files.js';
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addAbortSignal, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { createHash } from 'node:crypto';

import { BlobStore, BlobStoreError } from '../blobs/blob-store.js';
import { ProtectedBlobStore, ProtectedBlobStoreError } from '../blobs/protected-blob-store.js';
import { KeyStore, type SafeStorageLike } from '../crypto/keystore.js';
import { rememberOpenedMaster } from '../crypto/library-master-port.js';
import { installRecoveredMaster } from '../crypto/recovery.js';
import { createDecryptStream } from '../crypto/envelope.js';
import { openLibraryDatabase } from '../db/database.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { boardsSnapshot, restoreBoards } from '../db/board-repository.js';
import { galleryPolicyMatches, restoreGalleryPolicy } from './restore-gallery-policy.js';
import { albumVisibilityMatches, restoreAlbumVisibility } from './restore-album-visibility.js';
import { editRevisionsMatch, restoreEditRevisions, restoredHeadTransforms, settleRestoredEditBakes } from './restore-edit-revisions.js';
import { provenanceMatches, restoreProvenance } from './restore-provenance.js';
import { bakeRestoredDerivatives, manifestDerivativeKey, restoreVariantFamilies, variantFamiliesMatch } from './restore-variants.js';
import { ProtectedRecoveryRepository } from '../db/protected-recovery-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import { ActivityRepository } from '../activity/activity-repository.js';
import type { ThumbnailService } from '../import/thumbnail-service.js';
import { createManifestDebtStore } from './manifest-debt.js';
import { blobPhotos, coverageTotals } from './backup-manifest-coverage.js';
import { discoverRestore, type RestoreCandidate, type RestoreDiscovery } from './restore-discovery.js';
import {
  activateStagedLibrary,
  assertRestoreAuthorized,
  loadCheckpoint,
  recoverInterruptedActivation,
  resetStaging,
  restorePaths,
  saveCheckpoint,
  type ActivationOperations,
  type RestorePaths,
} from './restore-staging.js';
import { RestoreError, toRestoreError, type RestoreCheckpoint, type RestoreProgress } from './restore-types.js';
import { ProviderError, type StorageProvider } from './provider.js';
import type { RestoreCoverage, RestoreMissingObject } from '../../shared/backup/restore-contract.js';
import { projectVerifiedManifest } from './restore-projection.js';
import {
  addPresenceFingerprint,
  createScanTicker,
  listObjectBytes,
  presentBytes,
  verifyObjectCount,
  type ScanTicker,
} from './restore-verify-scan.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

const SCRATCH_BYTES = 16 * 1024 * 1024;

export interface RestoreEngineDeps {
  readonly provider: StorageProvider;
  readonly targetDir: string;
  readonly safeStorage: SafeStorageLike;
  readonly thumbnails: (store: BlobStore) => Pick<ThumbnailService, 'generateFor'>;
  readonly availableBytes?: ((path: string) => Promise<number>) | undefined;
  readonly activationOperations?: ActivationOperations | undefined;
  /** Reconciles the ADR-0013 app-lock freshness anchor after activation
   * (#753): the restored library carries no app-lock record, so the stale
   * anchor from the replaced library reads as a rollback attack and
   * fail-closes the relaunch into 'Recovery required'. */
  readonly resetLockAnchor?: (() => void) | undefined;
  /** Writes a password-derived app-lock record + matching ADR-0013 anchor for
   * the activated library (#754). Runs only with a custodyPassword, i.e. only
   * after the facade verified that password as fresh app-lock authority. */
  readonly reestablishLock?: ((input: { libraryId: string; password: string; masterKey: Buffer }) => Promise<void>) | undefined;
  readonly beforeActivate?: (() => Promise<void>) | undefined;
  readonly events: { progress(progress: RestoreProgress): void };
}

export interface RestoreRequest {
  readonly masterKey: Buffer;
  readonly allowReplace: boolean;
  readonly signal?: AbortSignal | undefined;
  /** Fresh app-password authority captured at discovery (#754). When present,
   * activation re-establishes the password-derived app-lock record instead of
   * leaving the restored library on downgraded keychain-form custody. */
  readonly custodyPassword?: string | undefined;
  /** Non-activating scan accepted by the user. Bind is manifest identity
   * (library / generation / path / sealed hash); extra download gaps are
   * reported as NOT FOUND instead of aborting (#965). */
  readonly verification?: RestoreVerifyResult | undefined;
}

export interface RestoreRunResult {
  readonly libraryId: string;
  readonly generation: number;
  readonly photos: number;
  readonly coverage?: RestoreCoverage;
  readonly resumed: boolean;
  /** Objects the restore could not recover (#915). Empty for a complete
   * restore; a partial restore reports every one, never just the first. */
  readonly missing: readonly RestoreMissingObject[];
}

export interface RestoreVerifyResult {
  readonly libraryId: string;
  readonly generation: number;
  readonly manifestPath: string;
  readonly sealedManifestSha256: string;
  /** Digest of every object observed by the scan, including corrupt objects.
   * This is internal plan state and is never exposed as a caller-selected
   * restore parameter. */
  readonly objectSetSha256: string;
  readonly photos: number;
  readonly coverage?: RestoreCoverage;
  readonly missing: readonly RestoreMissingObject[];
  /** Counts split for the verify screen (X missing, Y corrupt) */
  readonly missingCount: number;
  readonly corruptCount: number;
  readonly verifiedCount: number;
}

/** Partial-pass accumulator (#915). `null` means strict: any missing or
 * unverifiable object rejects the candidate (the #741 fallback contract). */
type MissingObjects = RestoreMissingObject[] | null;

function objectSetSha256(fingerprints: readonly string[]): string {
  return createHash('sha256')
    .update([...fingerprints].sort().join('\n'))
    .digest('hex');
}

function addObjectFingerprint(fingerprints: string[], path: string, bytes: Buffer): void {
  fingerprints.push(`${path}\u0000${String(bytes.length)}\u0000${createHash('sha256').update(bytes).digest('hex')}`);
}

function missingOriginalIds(missing: MissingObjects): ReadonlySet<string> {
  return new Set(
    (missing ?? []).filter((object) => object.kind === 'original' && object.photoId !== null).map((object) => object.photoId as string),
  );
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new RestoreError('cancelled', 'restore cancelled');
}

function missingRemoteError(path: string): RestoreError {
  return new RestoreError('corrupt', `manifest references missing ${path}`);
}

function checkpointFor(discovery: RestoreDiscovery, candidate: RestoreCandidate): RestoreCheckpoint {
  return {
    version: 1,
    libraryId: discovery.bootstrap.libraryId,
    manifestPath: candidate.path,
    sealedManifestSha256: candidate.sealedSha256,
    completedBlobIds: [],
    completedThumbnailIds: [],
    completedProtectedObjectIds: [],
  };
}

function checkpointMatches(checkpoint: RestoreCheckpoint, discovery: RestoreDiscovery, candidate: RestoreCandidate): boolean {
  return (
    checkpoint.libraryId === discovery.bootstrap.libraryId &&
    checkpoint.manifestPath === candidate.path &&
    checkpoint.sealedManifestSha256 === candidate.sealedSha256
  );
}

async function defaultAvailableBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

export class RestoreEngine {
  constructor(private readonly deps: RestoreEngineDeps) {}

  /** Non-activating scan (#947): classifies every manifest object as
   * verified vs missing (not-found) vs corrupt (failed-verification) without
   * writing library.db. Reuses provider list + getStream + envelope decrypt
   * verification. Idempotent and cancellable. */
  async verify(request: RestoreRequest): Promise<RestoreVerifyResult> {
    await recoverInterruptedActivation(restorePaths(this.deps.targetDir));
    if (!this.deps.safeStorage.isEncryptionAvailable()) {
      throw new RestoreError('io', 'OS keychain is unavailable; restored master key cannot be protected');
    }
    this.emit('discovering', 0, 0, null);
    const discovery = await discoverRestore(this.deps.provider, request.masterKey, request.signal);
    // Use newest valid candidate — same ordering as run()
    const candidate = discovery.candidates[0];
    if (candidate === undefined) throw new RestoreError('corrupt', 'no manifest generation could be restored');
    const missing: RestoreMissingObject[] = [];
    const fingerprints: string[] = [];
    const ticker = createScanTicker(verifyObjectCount(candidate), (stage, done, total, photoId) => {
      this.emit(stage, done, total, photoId);
    });
    await this.scanBlobs(discovery, candidate, missing, fingerprints, request.signal, ticker);
    await this.scanSidecars(discovery, candidate, missing, fingerprints, request.signal, ticker);
    await this.scanProtected(discovery, candidate, missing, fingerprints, request.signal, ticker);
    const missingCount = missing.filter((o) => o.reason === 'not-found').length;
    const corruptCount = missing.filter((o) => o.reason === 'failed-verification').length;
    const verifiedCount = blobPhotos(candidate.manifest.photos).length - missing.filter((o) => o.kind === 'original').length;
    const coverage = coverageTotals(candidate.manifest.photos);
    return {
      libraryId: candidate.manifest.libraryId,
      generation: candidate.generation,
      manifestPath: candidate.path,
      sealedManifestSha256: candidate.sealedSha256,
      objectSetSha256: objectSetSha256(fingerprints),
      photos: candidate.manifest.photos.length,
      ...(coverage.excludedCount > 0 ? { coverage } : {}),
      missing,
      missingCount,
      corruptCount,
      verifiedCount: Math.max(0, verifiedCount),
    };
  }

  private async scanBlobs(
    _discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    missing: RestoreMissingObject[],
    fingerprints: string[],
    signal: AbortSignal | undefined,
    ticker: ScanTicker,
  ): Promise<void> {
    // Presence only — do not download original bodies. Restore authenticates
    // each envelope once, when the user chooses to restore.
    // Excluded records (ADR-0033 §4) promise no blob and are not scanned.
    const carried = blobPhotos(candidate.manifest.photos);
    const listed = await listObjectBytes(
      this.deps.provider,
      carried.map((photo) => photo.blobPath),
      signal,
    );
    for (const photo of carried) {
      assertNotAborted(signal);
      try {
        const bytes = await presentBytes(this.deps.provider, listed, photo.blobPath, signal);
        addPresenceFingerprint(fingerprints, photo.blobPath, bytes);
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'not-found') {
          missing.push({ path: photo.blobPath, kind: 'original', photoId: photo.id, reason: 'not-found' });
        } else if (error instanceof RestoreError) throw error;
        else {
          throw error;
        }
      } finally {
        ticker.tick(photo.id);
      }
    }
  }

  private async scanSidecars(
    discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    missing: RestoreMissingObject[],
    fingerprints: string[],
    signal: AbortSignal | undefined,
    ticker: ScanTicker,
  ): Promise<void> {
    // Every schema from 6 on carries the sidecar section; gate on the section,
    // not the version, so a newer manifest era never silently skips it.
    if (!('sidecars' in candidate.manifest)) return;
    for (const sidecar of candidate.manifest.sidecars) {
      assertNotAborted(signal);
      try {
        const stream = await this.deps.provider.getStream(sidecar.blobPath);
        const buf = await buffer(signal === undefined ? stream : addAbortSignal(signal, stream));
        addObjectFingerprint(fingerprints, sidecar.blobPath, buf);
        const decrypt = createDecryptStream(discovery.resolveKey, { photoId: `sidecar:${sidecarOwnerOf(sidecar)}` });
        const readable = Readable.from([buf]);
        try {
          for await (const _ of readable.pipe(decrypt)) {
            // Drain every authenticated envelope chunk for verification
          }
        } catch {
          missing.push({ path: sidecar.blobPath, kind: 'sidecar', photoId: sidecar.photoId, reason: 'failed-verification' });
        }
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'not-found') {
          missing.push({ path: sidecar.blobPath, kind: 'sidecar', photoId: sidecar.photoId, reason: 'not-found' });
        } else throw error;
      } finally {
        ticker.tick(sidecar.photoId);
      }
    }
  }

  private async scanProtected(
    _discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    missing: RestoreMissingObject[],
    fingerprints: string[],
    signal: AbortSignal | undefined,
    ticker: ScanTicker,
  ): Promise<void> {
    if (candidate.manifest.schema === 2) return;
    const entries = candidate.manifest.protectedPhotos.flatMap((photo) =>
      photo.objects.filter((o) => o.status === 'synced').map((o) => ({ photo, object: o })),
    );
    for (const entry of entries) {
      assertNotAborted(signal);
      try {
        const stream = await this.deps.provider.getStream(entry.object.path);
        const buf = await buffer(signal === undefined ? stream : addAbortSignal(signal, stream));
        addObjectFingerprint(fingerprints, entry.object.path, buf);
        const h = createHash('sha256').update(buf).digest('hex');
        if (h !== entry.object.sha256 || buf.length !== entry.object.bytes) {
          missing.push({ path: entry.object.path, kind: 'protected', photoId: entry.photo.id, reason: 'failed-verification' });
        }
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'not-found') {
          missing.push({ path: entry.object.path, kind: 'protected', photoId: entry.photo.id, reason: 'not-found' });
        } else if (error instanceof ProviderError) throw error;
        else {
          missing.push({ path: entry.object.path, kind: 'protected', photoId: entry.photo.id, reason: 'failed-verification' });
        }
      } finally {
        ticker.tick(entry.photo.id);
      }
    }
  }

  async run(request: RestoreRequest): Promise<RestoreRunResult> {
    const paths = restorePaths(this.deps.targetDir);
    try {
      await mkdir(dirname(paths.targetDir), { recursive: true });
      await recoverInterruptedActivation(paths);
      await assertRestoreAuthorized(paths, request.allowReplace);
      if (!this.deps.safeStorage.isEncryptionAvailable()) {
        throw new RestoreError('io', 'OS keychain is unavailable; restored master key cannot be protected');
      }
      this.emit('discovering', 0, 0, null);
      const discovery = await discoverRestore(this.deps.provider, request.masterKey, request.signal);
      if (request.verification !== undefined) {
        // #965: bind to manifest identity; extra download gaps are NOT FOUND.
        const candidate = discovery.candidates.find(
          (item) =>
            item.path === request.verification?.manifestPath &&
            item.generation === request.verification.generation &&
            item.sealedSha256 === request.verification.sealedManifestSha256,
        );
        if (candidate === undefined || candidate.manifest.libraryId !== request.verification.libraryId) {
          throw new RestoreError('corrupt', 'The backup changed after verification. Verify it again before restoring.');
        }
        return await this.restoreCandidate(paths, discovery, candidate, request, [...request.verification.missing]);
      }
      let lastCandidateError: RestoreError | null = null;
      for (const candidate of discovery.candidates) {
        try {
          return await this.restoreCandidate(paths, discovery, candidate, request, null);
        } catch (error) {
          const mapped = toRestoreError(error);
          if (mapped.reason !== 'corrupt' && mapped.reason !== 'unsupported') throw mapped;
          lastCandidateError = mapped;
        }
      }
      // Partial pass (#915): no retained generation is complete — blob paths
      // are content-addressed, so one lost object usually poisons every
      // generation. Restore the newest candidate that works, skipping objects
      // that are absent or fail verification, and report every one as NOT
      // FOUND instead of restoring nothing. The strict pass above keeps the
      // #741 guarantee: a complete retained generation always wins.
      for (const candidate of discovery.candidates) {
        try {
          return await this.restoreCandidate(paths, discovery, candidate, request, []);
        } catch (error) {
          const mapped = toRestoreError(error);
          if (mapped.reason !== 'corrupt' && mapped.reason !== 'unsupported') throw mapped;
        }
      }
      throw lastCandidateError ?? new RestoreError('corrupt', 'no manifest generation could be restored');
    } catch (error) {
      throw toRestoreError(error);
    }
  }

  private async restoreCandidate(
    paths: RestorePaths,
    discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    request: RestoreRequest,
    missing: MissingObjects,
  ): Promise<RestoreRunResult> {
    const loaded = await loadCheckpoint(paths);
    let checkpoint: RestoreCheckpoint;
    let resumed = false;
    if (loaded !== null && checkpointMatches(loaded, discovery, candidate)) {
      checkpoint = loaded;
      resumed =
        loaded.completedBlobIds.length > 0 || loaded.completedThumbnailIds.length > 0 || loaded.completedProtectedObjectIds.length > 0;
    } else {
      await resetStaging(paths);
      checkpoint = checkpointFor(discovery, candidate);
      await saveCheckpoint(paths, checkpoint);
    }
    const store = new BlobStore({ dataDir: paths.stagingDir });
    const protectedStore = new ProtectedBlobStore(paths.stagingDir);
    await store.init();
    await protectedStore.init();
    checkpoint = await this.restoreBlobs(paths, store, discovery, candidate, checkpoint, missing, request.signal);
    checkpoint = await this.restoreSidecars(paths, store, discovery, candidate, checkpoint, missing, request.signal);
    checkpoint = await this.restoreProtectedBlobs(paths, protectedStore, candidate, checkpoint, missing, request.signal);
    const restoreCandidate =
      missing === null ? candidate : { ...candidate, manifest: projectVerifiedManifest(candidate.manifest, missing) };
    if (missing !== null) {
      const retainedPhotoIds = new Set(restoreCandidate.manifest.photos.map((photo) => photo.id));
      for (const photo of candidate.manifest.photos) {
        if (!retainedPhotoIds.has(photo.id)) await store.deleteSidecars(photo.id);
      }
      if (candidate.manifest.schema !== 2 && restoreCandidate.manifest.schema !== 2) {
        const retainedProtectedIds = new Set(restoreCandidate.manifest.protectedPhotos.map((photo) => photo.id));
        for (const photo of candidate.manifest.protectedPhotos) {
          if (retainedProtectedIds.has(photo.id)) continue;
          for (const object of photo.objects) {
            if (object.status === 'synced' && protectedStore.has(photo.albumId, photo.blobRef, object.kind)) {
              await protectedStore.deleteKind(photo.albumId, photo.blobRef, object.kind);
            }
          }
        }
      }
    }
    const recoveredKeys = await this.prepareRecoveredCustody(paths, discovery, candidate, request.masterKey);
    try {
      await this.restoreThumbnails(paths, store, recoveredKeys, discovery, candidate, checkpoint, missing, request.signal);
      this.emit('rebuilding', 0, restoreCandidate.manifest.photos.length, null);
      await this.rebuildCatalog(paths, store, protectedStore, recoveredKeys, discovery, restoreCandidate, missing);
    } finally {
      recoveredKeys.close();
    }
    assertNotAborted(request.signal);
    const coverage = coverageTotals(restoreCandidate.manifest.photos);
    if ((missing !== null && missing.length > 0) || coverage.excludedCount > 0) {
      // Deliberate exclusions are separate from failed objects. The report rides the staging→active rename as a durable
      // file next to library.db so it survives a later user-chosen reopen
      // (#915/#994).
      const reportPath = join(paths.stagingDir, 'restore-report.json');
      await writeFile(
        `${reportPath}.tmp`,
        JSON.stringify(
          { version: 1, generation: candidate.generation, generatedAt: candidate.manifest.generatedAt, coverage, missing: missing ?? [] },
          null,
          2,
        ),
      );
      await rename(`${reportPath}.tmp`, reportPath);
    }
    this.emit('activating', 0, 1, null);
    await this.deps.beforeActivate?.();
    await activateStagedLibrary(paths, this.deps.activationOperations);
    rememberOpenedMaster(paths.targetDir, request.masterKey);
    try {
      // Immediately after the rename: the activated library must not relaunch
      // against the replaced library's anchor. A crash before this line keeps
      // today's recoverable-with-key behavior; a clear failure must not undo
      // an activation that already succeeded.
      this.deps.resetLockAnchor?.();
    } catch (error) {
      console.error(`[overlook] app-lock anchor reset failed after restore: ${error instanceof Error ? error.message : String(error)}`);
    }
    await rm(join(paths.targetDir, 'restore-checkpoint.json'), { force: true });
    if (request.custodyPassword !== undefined && this.deps.reestablishLock !== undefined) {
      try {
        await this.deps.reestablishLock({
          libraryId: candidate.manifest.libraryId,
          password: request.custodyPassword,
          masterKey: request.masterKey,
        });
      } catch (error) {
        // Activation is committed; a custody write failure must not undo a
        // restore that already succeeded. The lock reads unconfigured until
        // the user re-enables it in Settings.
        console.error(
          `[overlook] app-lock custody re-establishment failed after restore: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.emit('complete', 1, 1, null);
    return {
      libraryId: candidate.manifest.libraryId,
      generation: candidate.generation,
      photos: blobPhotos(restoreCandidate.manifest.photos).length,
      ...(coverage.excludedCount > 0 ? { coverage } : {}),
      resumed,
      missing: missing ?? [],
    };
  }

  /** Encrypted companions (#484): schema-6 manifests list every sidecar
   * object; each download re-verifies (decrypt + content-address) before it
   * counts, with its own resumable checkpoint set. */
  private async restoreSidecars(
    paths: RestorePaths,
    store: BlobStore,
    discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    checkpoint: RestoreCheckpoint,
    missing: MissingObjects,
    signal?: AbortSignal,
  ): Promise<RestoreCheckpoint> {
    if (!('sidecars' in candidate.manifest)) return checkpoint;
    const entries = candidate.manifest.sidecars.map((sidecar) => ({ sidecar, id: `${sidecar.photoId}:${sidecar.hash}` }));
    const ids = new Set(entries.map((entry) => entry.id));
    const completed = new Set((checkpoint.completedSidecarIds ?? []).filter((id) => ids.has(id)));
    for (const entry of entries) {
      if (!completed.has(entry.id)) continue;
      const ownerId = sidecarOwnerOf(entry.sidecar);
      if (!(await store.verifySidecar(ownerId, entry.sidecar.hash, discovery.resolveKey))) {
        completed.delete(entry.id);
        await store.deleteSidecar(ownerId, entry.sidecar.hash);
      }
    }
    checkpoint = { ...checkpoint, completedSidecarIds: [...completed] };
    await saveCheckpoint(paths, checkpoint);
    const skipped = new Set((missing ?? []).map((item) => item.path));
    const pending = entries.filter((entry) => !completed.has(entry.id) && !skipped.has(entry.sidecar.blobPath));
    if (pending.length === 0) return checkpoint;
    for (const entry of pending) {
      assertNotAborted(signal);
      try {
        const remoteStream = await this.deps.provider.getStream(entry.sidecar.blobPath);
        await store.restoreSidecar(
          sidecarOwnerOf(entry.sidecar),
          entry.sidecar.hash,
          signal === undefined ? remoteStream : addAbortSignal(signal, remoteStream),
          discovery.resolveKey,
        );
      } catch (error) {
        if (missing !== null && (error instanceof BlobStoreError || (error instanceof ProviderError && error.kind === 'not-found'))) {
          missing.push({
            path: entry.sidecar.blobPath,
            kind: 'sidecar',
            photoId: entry.sidecar.photoId,
            reason: error instanceof BlobStoreError ? 'failed-verification' : 'not-found',
          });
          continue;
        }
        if (error instanceof BlobStoreError) throw new RestoreError('corrupt', error.message);
        if (error instanceof ProviderError && error.kind === 'not-found') throw missingRemoteError(entry.sidecar.blobPath);
        throw error;
      }
      completed.add(entry.id);
      checkpoint = { ...checkpoint, completedSidecarIds: [...completed] };
      await saveCheckpoint(paths, checkpoint);
    }
    return checkpoint;
  }

  private async restoreProtectedBlobs(
    paths: RestorePaths,
    store: ProtectedBlobStore,
    candidate: RestoreCandidate,
    checkpoint: RestoreCheckpoint,
    missing: MissingObjects,
    signal?: AbortSignal,
  ): Promise<RestoreCheckpoint> {
    if (candidate.manifest.schema === 2) return checkpoint;
    const entries = candidate.manifest.protectedPhotos.flatMap((photo) =>
      photo.objects.filter((object) => object.status === 'synced').map((object) => ({ photo, object, id: `${photo.id}:${object.kind}` })),
    );
    const ids = new Set(entries.map((entry) => entry.id));
    const completed = new Set(checkpoint.completedProtectedObjectIds.filter((id) => ids.has(id)));
    for (const entry of entries) {
      if (!completed.has(entry.id)) continue;
      if (!store.has(entry.photo.albumId, entry.photo.blobRef, entry.object.kind)) {
        completed.delete(entry.id);
        continue;
      }
      const actual = await store.ciphertextInfo(entry.photo.albumId, entry.photo.blobRef, entry.object.kind);
      if (actual.sha256 !== entry.object.sha256 || actual.bytes !== entry.object.bytes) {
        completed.delete(entry.id);
        await store.deleteKind(entry.photo.albumId, entry.photo.blobRef, entry.object.kind);
      }
    }
    checkpoint = { ...checkpoint, completedProtectedObjectIds: [...completed] };
    await saveCheckpoint(paths, checkpoint);
    const skipped = new Set((missing ?? []).map((item) => item.path));
    const pending = entries.filter((entry) => !completed.has(entry.id) && !skipped.has(entry.object.path));
    const requiredBytes = SCRATCH_BYTES + pending.reduce((sum, entry) => sum + entry.object.bytes, 0);
    const available = await (this.deps.availableBytes ?? defaultAvailableBytes)(dirname(paths.targetDir));
    if (available < requiredBytes) {
      throw new RestoreError('disk-space', `restore needs ${String(requiredBytes)} bytes but only ${String(available)} are available`);
    }
    let done = completed.size;
    this.emit('downloading', done, entries.length, null);
    for (const entry of pending) {
      assertNotAborted(signal);
      try {
        const remote = await this.deps.provider.getStream(entry.object.path);
        await store.restoreEncrypted({
          albumId: entry.photo.albumId,
          blobRef: entry.photo.blobRef,
          kind: entry.object.kind,
          ciphertext: signal === undefined ? remote : addAbortSignal(signal, remote),
          sha256: entry.object.sha256,
          bytes: entry.object.bytes,
        });
      } catch (error) {
        if (
          missing !== null &&
          (error instanceof ProtectedBlobStoreError || (error instanceof ProviderError && error.kind === 'not-found'))
        ) {
          missing.push({
            path: entry.object.path,
            kind: 'protected',
            photoId: entry.photo.id,
            reason: error instanceof ProtectedBlobStoreError ? 'failed-verification' : 'not-found',
          });
          continue;
        }
        if (error instanceof ProtectedBlobStoreError) throw new RestoreError('corrupt', error.message);
        throw error;
      }
      completed.add(entry.id);
      checkpoint = { ...checkpoint, completedProtectedObjectIds: [...completed] };
      await saveCheckpoint(paths, checkpoint);
      this.emit('downloading', ++done, entries.length, null);
    }
    return checkpoint;
  }

  private async restoreBlobs(
    paths: RestorePaths,
    store: BlobStore,
    discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    checkpoint: RestoreCheckpoint,
    missing: MissingObjects,
    signal?: AbortSignal,
  ): Promise<RestoreCheckpoint> {
    // Excluded records (ADR-0033 §4) have nothing to download; their rows
    // are placeholders the catalog restore writes on its own.
    const carried = blobPhotos(candidate.manifest.photos);
    const manifestIds = new Set(carried.map((photo) => photo.id));
    const completed = new Set(checkpoint.completedBlobIds.filter((id) => manifestIds.has(id)));
    await pruneUnverifiedCompletedBlobs(store, discovery.resolveKey, carried, completed);
    checkpoint = { ...checkpoint, completedBlobIds: [...completed] };
    await saveCheckpoint(paths, checkpoint);
    const remote = new Map((await this.deps.provider.list('blobs', signal)).map((entry) => [entry.path, entry]));
    const skipped = new Set((missing ?? []).map((item) => item.path));
    const pending = carried.filter((photo) => !completed.has(photo.id) && !skipped.has(photo.blobPath));
    // #969: list() is a size hint only. A listing miss is not NOT FOUND —
    // getStream decides presence. Manifest bytes cover omitted paths.
    // Variants share one original (#496): its bytes count once.
    let requiredBytes = SCRATCH_BYTES;
    const counted = new Set<string>();
    for (const photo of pending) {
      if (counted.has(photo.blobPath)) continue;
      counted.add(photo.blobPath);
      requiredBytes += remote.get(photo.blobPath)?.bytes ?? photo.bytes;
    }
    const available = await (this.deps.availableBytes ?? defaultAvailableBytes)(dirname(paths.targetDir));
    if (available < requiredBytes) {
      throw new RestoreError('disk-space', `restore needs ${String(requiredBytes)} bytes but only ${String(available)} are available`);
    }
    let done = completed.size;
    this.emit('downloading', done, carried.length, null);
    for (const photo of pending) {
      assertNotAborted(signal);
      try {
        // Variants share one original (#496): a sibling already restored and
        // verified this blob, so it is not downloaded twice.
        const shared =
          store.hasOriginal(photo.contentHash) &&
          (await store.verifyOriginal(photo.contentHash, discovery.resolveKey, assetOwnerOf(photo)));
        if (!shared) {
          const remoteStream = await this.deps.provider.getStream(photo.blobPath);
          await store.restoreOriginal(
            photo.contentHash,
            signal === undefined ? remoteStream : addAbortSignal(signal, remoteStream),
            discovery.resolveKey,
            assetOwnerOf(photo),
          );
        }
      } catch (error) {
        if (missing !== null && (error instanceof BlobStoreError || (error instanceof ProviderError && error.kind === 'not-found'))) {
          missing.push({
            path: photo.blobPath,
            kind: 'original',
            photoId: photo.id,
            reason: error instanceof BlobStoreError ? 'failed-verification' : 'not-found',
          });
          await deleteUnownedRestoredOriginal(store, discovery.resolveKey, carried, completed, photo.contentHash);
          continue;
        }
        if (error instanceof BlobStoreError) throw new RestoreError('corrupt', error.message);
        if (error instanceof ProviderError && error.kind === 'not-found') throw missingRemoteError(photo.blobPath);
        throw error;
      }
      completed.add(photo.id);
      done += 1;
      checkpoint = { ...checkpoint, completedBlobIds: [...completed] };
      await saveCheckpoint(paths, checkpoint);
      this.emit('downloading', done, carried.length, photo.id);
    }
    return checkpoint;
  }

  private async restoreThumbnails(
    paths: RestorePaths,
    store: BlobStore,
    recoveredKeys: KeyStore,
    discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    checkpoint: RestoreCheckpoint,
    missing: MissingObjects,
    signal?: AbortSignal,
  ): Promise<RestoreCheckpoint> {
    const thumbnails = this.deps.thumbnails(store);
    const skip = missingOriginalIds(missing);
    const carried = blobPhotos(candidate.manifest.photos);
    const manifestIds = new Set(carried.map((photo) => photo.id));
    const completed = new Set(checkpoint.completedThumbnailIds.filter((id) => manifestIds.has(id)));
    for (const photo of carried) {
      if (completed.has(photo.id) && !(await store.verifyThumbs(manifestDerivativeKey(photo), discovery.resolveKey, photo.id))) {
        completed.delete(photo.id);
        await store.deleteThumbs(manifestDerivativeKey(photo));
      }
    }
    let done = completed.size;
    // Restored heads bake into the rebuilt derivatives (ADR-0031 §7): the
    // revisions land in the catalog later, but the tiles must show the same
    // edits the backed-up library showed, not the untouched original.
    const transforms = restoredHeadTransforms(candidate.manifest);
    this.emit('rebuilding', done, carried.length, null);
    for (const photo of carried.filter((item) => !completed.has(item.id) && !skip.has(item.id))) {
      assertNotAborted(signal);
      await bakeRestoredDerivatives(thumbnails, store, recoveredKeys, discovery, photo, transforms.get(photo.id), signal);
      completed.add(photo.id);
      done += 1;
      checkpoint = { ...checkpoint, completedThumbnailIds: [...completed] };
      await saveCheckpoint(paths, checkpoint);
      this.emit('rebuilding', done, carried.length, photo.id);
    }
    return checkpoint;
  }

  private async prepareRecoveredCustody(
    paths: RestorePaths,
    discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    masterKey: Buffer,
  ): Promise<KeyStore> {
    const libraryIdPath = join(paths.stagingDir, 'library-id');
    await writeFile(`${libraryIdPath}.tmp`, candidate.manifest.libraryId);
    await rename(`${libraryIdPath}.tmp`, libraryIdPath);
    const keysPath = join(paths.stagingDir, 'keys.json');
    if (!existsSync(keysPath)) {
      const temporaryKeysPath = `${keysPath}.tmp`;
      await writeFile(temporaryKeysPath, JSON.stringify({ version: 1, keys: discovery.bootstrap.keys }, null, 2));
      await rename(temporaryKeysPath, keysPath);
    }
    const installed = installRecoveredMaster(paths.stagingDir, this.deps.safeStorage, masterKey);
    if (installed !== 'installed' && installed !== 'already-installed') {
      throw new RestoreError('wrong-key', `recovered master installation failed: ${installed}`);
    }
    const recovered = KeyStore.open({ safeStorage: this.deps.safeStorage, dataDir: paths.stagingDir, recordMasterBackup: false });
    try {
      const requiresFreshWriteKey = discovery.bootstrap.schema === 1 || candidate.generation !== discovery.bootstrap.manifestGeneration;
      if (requiresFreshWriteKey) {
        const recoveredActive = discovery.bootstrap.keys.find((key) => key.status === 'active');
        if (recoveredActive === undefined) throw new RestoreError('corrupt', 'recovery bootstrap has no active key');
        const activeId = recovered.currentKey().id;
        if (activeId === recoveredActive.id) {
          recovered.rotate();
        } else {
          const expectedRotatedId = Math.max(...discovery.bootstrap.keys.map((key) => key.id)) + 1;
          if (activeId !== expectedRotatedId) {
            throw new RestoreError('corrupt', 'recovery staging has an unexpected active key');
          }
        }
      }
      return recovered;
    } catch (error) {
      recovered.close();
      throw error;
    }
  }

  private async rebuildCatalog(
    paths: RestorePaths,
    store: BlobStore,
    protectedStore: ProtectedBlobStore,
    recoveredKeys: KeyStore,
    discovery: RestoreDiscovery,
    candidate: RestoreCandidate,
    missing: MissingObjects,
  ): Promise<void> {
    const dbKey = discovery.resolveKey(1);
    if (dbKey === undefined) throw new RestoreError('wrong-key', 'recovery bootstrap does not contain database key #1');
    const skip = missingOriginalIds(missing);
    const missingPaths = new Set((missing ?? []).map((object) => object.path));
    const dbPath = join(paths.stagingDir, 'library.db');
    for (const suffix of ['', '-wal', '-shm']) await rm(`${dbPath}${suffix}`, { force: true });
    const db = openLibraryDatabase({ path: dbPath, dbKey });
    try {
      const repo = new PhotosRepository(db);
      repo.restoreManifest(candidate.manifest, recoveredKeys.exportWrappedKeys());
      // The restored library starts owing a manifest generation (#741): the
      // provider selected after relaunch may not be the restore source, and
      // the first run's publication preflight reconciles the difference —
      // without the debt, a mismatched selection would sit silently on
      // stale claims until the next library edit.
      createManifestDebtStore(db, () => new Date()).save(true);
      if ('boards' in candidate.manifest) restoreBoards(db, candidate.manifest.boards);
      restoreGalleryPolicy(db, candidate.manifest);
      restoreAlbumVisibility(db, candidate.manifest);
      restoreEditRevisions(db, candidate.manifest);
      restoreProvenance(db, candidate.manifest);
      restoreVariantFamilies(db, candidate.manifest);
      if (candidate.manifest.schema !== 2) new ProtectedRecoveryRepository(db).restore(candidate.manifest);
      if ('sidecars' in candidate.manifest) {
        const sidecarRepo = new SidecarRepository(db);
        // A NOT FOUND sidecar row is omitted rather than kept: unlike a
        // photo row it carries no album membership, and a row pointing at
        // absent content would poison the next backup publication (#915).
        for (const sidecar of candidate.manifest.sidecars.filter((item) => !missingPaths.has(item.blobPath))) {
          sidecarRepo.insert({
            photoId: sidecar.photoId,
            ownerId: sidecarOwnerOf(sidecar),
            role: sidecar.role,
            fileName: sidecar.fileName,
            contentHash: sidecar.hash,
            bytes: sidecar.bytes,
            keyId: sidecar.keyId,
            importedAt: candidate.manifest.generatedAt,
          });
        }
      }
      if (candidate.manifest.schema !== 2 && candidate.manifest.schema !== 3) {
        new ActivityRepository(db).restoreSnapshot(candidate.manifest.activity);
      }
      const rebuilt = repo.manifestSnapshot();
      const expectedBoards = 'boards' in candidate.manifest ? candidate.manifest.boards : [];
      const expected = {
        keyIds: candidate.manifest.keyIds,
        totals: candidate.manifest.totals,
        // `mediaInfo` is OPTIONAL in the manifest (absent = "not probed",
        // pre-#548 generations) and this consumer must normalize absence to
        // null: the rebuilt snapshot always carries the key.
        photos: candidate.manifest.photos.map((photo) => ({ mediaInfo: null, ...photo })),
        albums: candidate.manifest.albums,
        boards: expectedBoards,
      };
      const actual = {
        keyIds: rebuilt.keyIds,
        totals: rebuilt.totals,
        photos: rebuilt.photos,
        albums: rebuilt.albums,
        boards: boardsSnapshot(db),
      };
      if (!isDeepStrictEqual(actual, expected)) throw new RestoreError('corrupt', 'rebuilt catalog does not match the verified projection');
      await verifyRestoredCustody(db, store, discovery.resolveKey, recoveredKeys, blobPhotos(candidate.manifest.photos), skip);
      if (candidate.manifest.schema !== 2) {
        const protectedRepo = new ProtectedRecoveryRepository(db);
        const protectedExpected = {
          protectedAlbums: candidate.manifest.protectedAlbums,
          protectedPhotos: candidate.manifest.protectedPhotos,
        };
        if (!isDeepStrictEqual(protectedRepo.snapshot(), protectedExpected)) {
          throw new RestoreError('corrupt', 'rebuilt protected catalog does not match the verified projection');
        }
        for (const photo of candidate.manifest.protectedPhotos) {
          for (const object of photo.objects) {
            if (object.status === 'offloaded' || missingPaths.has(object.path)) continue;
            const actual = await protectedStore.ciphertextInfo(photo.albumId, photo.blobRef, object.kind);
            if (actual.sha256 !== object.sha256 || actual.bytes !== object.bytes) {
              throw new RestoreError('corrupt', 'final protected ciphertext verification failed');
            }
          }
        }
      }
      if (candidate.manifest.schema !== 2 && candidate.manifest.schema !== 3) {
        const activity = new ActivityRepository(db).backupSnapshot();
        if (!isDeepStrictEqual(activity, candidate.manifest.activity)) {
          throw new RestoreError('corrupt', 'rebuilt activity history does not match the verified projection');
        }
      }
      await settleRestoredEditBakes(db, candidate.manifest, async (photoId) => {
        const photo = repo.get(photoId);
        return photo !== undefined && (await store.verifyThumbs(photo.derivativeKey, recoveredKeys.resolver(), photoId));
      });
      if (!galleryPolicyMatches(db, candidate.manifest)) throw new RestoreError('corrupt', 'restored gallery policy mismatch');
      if (!albumVisibilityMatches(db, candidate.manifest)) throw new RestoreError('corrupt', 'restored album visibility mismatch');
      if (!editRevisionsMatch(db, candidate.manifest)) throw new RestoreError('corrupt', 'restored edit revisions mismatch');
      if (!provenanceMatches(db, candidate.manifest)) throw new RestoreError('corrupt', 'restored provenance mismatch');
      if (!variantFamiliesMatch(db, candidate.manifest)) throw new RestoreError('corrupt', 'restored variant families mismatch');
    } finally {
      db.close();
    }
  }

  private emit(stage: RestoreProgress['stage'], done: number, total: number, photoId: string | null): void {
    this.deps.events.progress({ stage, done, total, photoId });
  }
}
