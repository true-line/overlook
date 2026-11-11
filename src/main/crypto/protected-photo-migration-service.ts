import { randomUUID } from 'node:crypto';

import { assetOwnerOf } from '../../shared/library/asset-owner.js';

import type { BackupManifestEditRevisionV11 } from '../backup/backup-manifest-edit-revisions.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { ProtectedBlobStore } from '../blobs/protected-blob-store.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import { variantDerivativeKey } from '../db/variant-repository.js';
import type {
  OrdinaryAlbumRestoration,
  ProtectedMigrationJournal,
  ProtectedMigrationItem,
  ProtectedMigrationOperation,
  ProtectedMigrationPhase,
  ProtectedPhotoMigrationRepository,
} from '../db/protected-photo-migration-repository.js';
import type { EnvelopeKey, KeyResolver } from './envelope.js';
import {
  openProtectedPhotoMetadata,
  sealProtectedPhotoMetadata,
  type ProtectedPhotoMetadata,
  type ProtectedSidecarMetadata,
} from './protected-photo-metadata.js';
import type { PhotoInsert, PhotoRecord } from '../../shared/library/types.js';

interface UnprotectItemLayout {
  readonly ownerPhotoId: string;
  readonly derivativeKey: string;
}

interface PreparedUnprotectSource {
  readonly photoId: string;
  readonly sourceBlobRef: string;
  readonly contentHash: string;
  readonly sealedMetadata: Buffer;
  readonly metadata: ProtectedPhotoMetadata;
  readonly hasThumb: boolean;
  readonly hasMid: boolean;
}

function chooseBatchOwnerId(group: readonly PreparedUnprotectSource[]): string {
  const sorted = [...group].sort((a, b) => a.photoId.localeCompare(b.photoId));
  const groupIds = new Set(sorted.map((entry) => entry.photoId));
  const explicitRoot = sorted.find(
    (entry) =>
      entry.metadata.version === 2 && entry.metadata.photo.variantSourceId === null && (entry.metadata.photo.assetOwnerId ?? null) === null,
  );
  if (explicitRoot !== undefined) return explicitRoot.photoId;
  const externalAncestor = sorted.find(
    (entry) =>
      entry.metadata.version === 2 &&
      entry.metadata.photo.variantSourceId !== undefined &&
      (entry.metadata.photo.variantSourceId === null || !groupIds.has(entry.metadata.photo.variantSourceId)),
  );
  return (externalAncestor ?? sorted[0]!).photoId;
}

function unprotectBatchLayout(items: readonly ProtectedMigrationItem[]): ReadonlyMap<string, UnprotectItemLayout> {
  const ownerByHash = new Map<string, string>();
  const layout = new Map<string, UnprotectItemLayout>();
  for (const item of items) {
    if (item.sourceAssetOwnerId !== undefined && item.sourceDerivativeRef !== undefined) {
      layout.set(item.photoId, { ownerPhotoId: item.sourceAssetOwnerId, derivativeKey: item.sourceDerivativeRef });
      continue;
    }
    const existingOwner = ownerByHash.get(item.targetBlobRef);
    if (existingOwner === undefined) {
      ownerByHash.set(item.targetBlobRef, item.photoId);
      layout.set(item.photoId, { ownerPhotoId: item.photoId, derivativeKey: item.targetBlobRef });
    } else {
      layout.set(item.photoId, {
        ownerPhotoId: existingOwner,
        derivativeKey: variantDerivativeKey(item.photoId, item.targetBlobRef),
      });
    }
  }
  return layout;
}

function metadataSidecars(metadata: ProtectedPhotoMetadata): readonly ProtectedSidecarMetadata[] {
  return metadata.version === 2 ? (metadata.sidecars ?? []) : [];
}

export interface ProtectedMigrationAuthority {
  readonly sourceAlbumKey?: Buffer;
  readonly targetAlbumKey?: Buffer;
  readonly libraryResolver?: KeyResolver;
  readonly targetLibraryKey?: EnvelopeKey;
  readonly ordinaryAlbum?: OrdinaryAlbumRestoration;
}

export interface ProtectedMigrationRecovery {
  readonly rolledBack: readonly string[];
  readonly awaitingAuthority: readonly string[];
}

export class ProtectedPhotoMigrationServiceError extends Error {
  override readonly name = 'ProtectedPhotoMigrationServiceError';
}

export interface ProtectedPhotoMigrationServiceOptions {
  readonly libraryId: string;
  readonly ordinaryBlobs: BlobStore;
  readonly protectedBlobs: ProtectedBlobStore;
  readonly photos: PhotosRepository;
  readonly migrations: ProtectedPhotoMigrationRepository;
  /** Marks backup manifest debt when custody or protected records commit. */
  readonly oweManifest: () => void;
  /** Eagerly zeroizes ordinary media generations before the row becomes
   * hidden. Repository admission remains the second, durable boundary. */
  readonly revokeOrdinary?: ((photoIds: readonly string[]) => void) | undefined;
  readonly createMigrationId?: () => string;
}

function requireAlbumKey(key: Buffer | undefined, label: string): Buffer {
  if (key === undefined || key.length !== 32) throw new ProtectedPhotoMigrationServiceError(`${label} authority is required`);
  return key;
}

function photoMetadata(photo: PhotoRecord): ProtectedPhotoMetadata['photo'] {
  return {
    id: photo.id,
    fileName: photo.fileName,
    fileKind: photo.fileKind,
    mediaInfo: photo.mediaInfo,
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    contentHash: photo.contentHash,
    camera: photo.camera,
    lens: photo.lens,
    iso: photo.iso,
    aperture: photo.aperture,
    shutter: photo.shutter,
    focalLength: photo.focalLength,
    takenAt: photo.takenAt,
    gpsLat: photo.gpsLat,
    gpsLon: photo.gpsLon,
    place: photo.place,
    title: photo.title,
    description: photo.description,
    userTags: photo.userTags,
    importedKeywords: photo.importedKeywords,
    suppressedKeywords: photo.suppressedKeywords,
    metadataVersion: photo.metadataVersion,
    importedAt: photo.importedAt,
    importSource: photo.importSource,
    favorite: photo.favorite,
    deletedAt: photo.deletedAt,
    derivativeKey: photo.derivativeKey,
    variantSourceId: photo.variantSourceId,
    assetOwnerId: photo.assetOwnerId,
  };
}

export class ProtectedPhotoMigrationService {
  constructor(private readonly options: ProtectedPhotoMigrationServiceOptions) {}

  prepareProtect(input: { readonly albumId: string; readonly albumKey: Buffer; readonly photoIds: readonly string[] }): string {
    const albumKey = requireAlbumKey(input.albumKey, 'target album');
    const migrationId = this.options.createMigrationId?.() ?? randomUUID();
    const editHistories = this.options.migrations.ordinaryEditRevisions(input.photoIds);
    const items = input.photoIds.map((photoId) => {
      const photo = this.options.photos.get(photoId);
      if (photo === undefined || photo.deletedAt !== null) {
        throw new ProtectedPhotoMigrationServiceError(`ordinary photo ${photoId} is unavailable`);
      }
      if (!this.options.ordinaryBlobs.hasOriginal(photo.contentHash) || !this.options.ordinaryBlobs.hasThumbs(photo.derivativeKey)) {
        throw new ProtectedPhotoMigrationServiceError(`ordinary photo ${photoId} requires a local original and both derivatives`);
      }
      const sidecarRows = this.options.migrations.ordinarySidecars(photoId);
      for (const sidecar of sidecarRows) {
        if (!this.options.ordinaryBlobs.hasSidecar(sidecar.ownerId ?? photoId, sidecar.contentHash)) {
          throw new ProtectedPhotoMigrationServiceError(`ordinary photo ${photoId} is missing companion sidecar ${sidecar.contentHash}`);
        }
      }
      const sidecars: ProtectedSidecarMetadata[] = sidecarRows.map(({ role, fileName, contentHash, bytes, importedAt }) => ({
        role,
        fileName,
        contentHash,
        bytes,
        importedAt,
      }));
      const metadata: ProtectedPhotoMetadata = {
        version: 2,
        editRevisions: editHistories.get(photoId) ?? [],
        ...(sidecars.length > 0 ? { sidecars } : {}),
        photo: photoMetadata(photo),
        ordinaryMemberships: this.options.migrations.ordinaryMemberships(photoId),
      };
      const targetBlobRef = this.options.protectedBlobs.opaqueRef(albumKey, photo.contentHash, photoId);
      const targetSidecarRefs = sidecars.map((sidecar) =>
        this.options.protectedBlobs.opaqueSidecarRef(albumKey, targetBlobRef, sidecar.contentHash),
      );
      return {
        photoId,
        sourceBlobRef: photo.contentHash,
        sourceAssetOwnerId: assetOwnerOf(photo),
        sourceDerivativeRef: photo.derivativeKey,
        targetBlobRef,
        targetSidecarRefs,
        sealedTargetMetadata: sealProtectedPhotoMetadata(
          { libraryId: this.options.libraryId, albumId: input.albumId, photoId },
          albumKey,
          metadata,
        ),
        hasThumb: true,
        hasMid: true,
      };
    });
    this.options.revokeOrdinary?.(input.photoIds);
    this.options.migrations.prepare({
      migrationId,
      operation: 'protect',
      sourceAlbumId: null,
      targetAlbumId: input.albumId,
      items,
    });
    return migrationId;
  }

  prepareUnprotect(input: { readonly albumId: string; readonly albumKey: Buffer; readonly photoIds: readonly string[] }): string {
    const albumKey = requireAlbumKey(input.albumKey, 'source album');
    const migrationId = this.options.createMigrationId?.() ?? randomUUID();
    const opened: PreparedUnprotectSource[] = input.photoIds.map((photoId) => {
      const source = this.options.migrations.getProtected(photoId);
      if (source === undefined || source.albumId !== input.albumId) {
        throw new ProtectedPhotoMigrationServiceError(`protected photo ${photoId} is unavailable`);
      }
      const metadata = openProtectedPhotoMetadata(
        { libraryId: this.options.libraryId, albumId: input.albumId, photoId },
        albumKey,
        source.sealedMetadata,
      );
      if (this.options.photos.hasContentHash(metadata.photo.contentHash)) {
        throw new ProtectedPhotoMigrationServiceError(
          `ordinary domain already contains content hash ${metadata.photo.contentHash} while unprotecting ${photoId}`,
        );
      }
      return {
        photoId,
        sourceBlobRef: source.blobRef,
        contentHash: metadata.photo.contentHash,
        sealedMetadata: source.sealedMetadata,
        metadata,
        hasThumb: source.hasThumb,
        hasMid: source.hasMid,
      };
    });
    const groupsByHash = new Map<string, PreparedUnprotectSource[]>();
    for (const entry of opened) {
      const group = groupsByHash.get(entry.contentHash) ?? [];
      group.push(entry);
      groupsByHash.set(entry.contentHash, group);
    }
    const ownerByHash = new Map<string, string>();
    for (const [contentHash, group] of groupsByHash) {
      ownerByHash.set(contentHash, chooseBatchOwnerId(group));
    }
    const usedDerivativeKeys = new Set<string>(ownerByHash.keys());
    const items = opened.map((entry) => {
      const ownerPhotoId = ownerByHash.get(entry.contentHash)!;
      const savedKey = entry.metadata.version === 2 ? entry.metadata.photo.derivativeKey : undefined;
      const derivativeKey =
        entry.photoId === ownerPhotoId
          ? entry.contentHash
          : savedKey !== undefined && !usedDerivativeKeys.has(savedKey)
            ? savedKey
            : variantDerivativeKey(entry.photoId, entry.contentHash);
      usedDerivativeKeys.add(derivativeKey);
      return {
        photoId: entry.photoId,
        sourceBlobRef: entry.sourceBlobRef,
        sourceAssetOwnerId: ownerPhotoId,
        sourceDerivativeRef: derivativeKey,
        targetBlobRef: entry.contentHash,
        sealedTargetMetadata: entry.sealedMetadata,
        hasThumb: entry.hasThumb,
        hasMid: entry.hasMid,
      };
    });
    this.options.migrations.prepare({
      migrationId,
      operation: 'unprotect',
      sourceAlbumId: input.albumId,
      targetAlbumId: null,
      items,
    });
    return migrationId;
  }

  prepareMove(input: {
    readonly sourceAlbumId: string;
    readonly sourceAlbumKey: Buffer;
    readonly targetAlbumId: string;
    readonly targetAlbumKey: Buffer;
    readonly photoIds: readonly string[];
  }): string {
    const sourceKey = requireAlbumKey(input.sourceAlbumKey, 'source album');
    const targetKey = requireAlbumKey(input.targetAlbumKey, 'target album');
    const migrationId = this.options.createMigrationId?.() ?? randomUUID();
    const items = input.photoIds.map((photoId) => {
      const source = this.options.migrations.getProtected(photoId);
      if (source === undefined || source.albumId !== input.sourceAlbumId) {
        throw new ProtectedPhotoMigrationServiceError(`protected photo ${photoId} is unavailable`);
      }
      const metadata = openProtectedPhotoMetadata(
        { libraryId: this.options.libraryId, albumId: input.sourceAlbumId, photoId },
        sourceKey,
        source.sealedMetadata,
      );
      const targetBlobRef = this.options.protectedBlobs.opaqueRef(
        targetKey,
        metadata.photo.contentHash,
        metadata.version === 2 ? photoId : undefined,
      );
      const targetSidecarRefs = metadataSidecars(metadata).map((sidecar) =>
        this.options.protectedBlobs.opaqueSidecarRef(targetKey, targetBlobRef, sidecar.contentHash),
      );
      return {
        photoId,
        sourceBlobRef: source.blobRef,
        targetBlobRef,
        targetSidecarRefs,
        sealedTargetMetadata: sealProtectedPhotoMetadata(
          { libraryId: this.options.libraryId, albumId: input.targetAlbumId, photoId },
          targetKey,
          metadata,
        ),
        hasThumb: source.hasThumb,
        hasMid: source.hasMid,
      };
    });
    this.options.migrations.prepare({
      migrationId,
      operation: 'move',
      sourceAlbumId: input.sourceAlbumId,
      targetAlbumId: input.targetAlbumId,
      items,
    });
    return migrationId;
  }

  async advance(migrationId: string, authority: ProtectedMigrationAuthority): Promise<boolean> {
    const journal = this.options.migrations.get(migrationId);
    if (journal === undefined) return false;
    switch (journal.phase) {
      case 'prepare':
        this.options.migrations.transition(migrationId, 'prepare', 'copy');
        break;
      case 'copy':
        await this.copy(journal, authority);
        this.options.migrations.transition(migrationId, 'copy', 'verify');
        break;
      case 'verify':
        await this.verifyTarget(journal, authority);
        this.commit(journal, authority);
        this.options.oweManifest();
        break;
      case 'commit':
        this.options.migrations.markPurging(migrationId);
        break;
      case 'purge':
        await this.verifyTarget(journal, authority);
        await this.purgeSource(journal);
        this.options.migrations.finish(migrationId);
        break;
    }
    return true;
  }

  async runToCompletion(migrationId: string, authority: ProtectedMigrationAuthority): Promise<void> {
    while (await this.advance(migrationId, authority)) {
      // Each iteration crosses exactly one durable journal boundary.
    }
  }

  migrationPhase(migrationId: string): ProtectedMigrationPhase | undefined {
    return this.options.migrations.get(migrationId)?.phase;
  }

  pendingForAlbum(albumId: string, operation: Extract<ProtectedMigrationOperation, 'protect' | 'unprotect'>) {
    return this.options.migrations.findAlbumJournal(albumId, operation);
  }

  async repairStartup(): Promise<ProtectedMigrationRecovery> {
    const rolledBack: string[] = [];
    const awaitingAuthority: string[] = [];
    for (const journal of this.options.migrations.listJournals()) {
      if (journal.phase === 'commit' || journal.phase === 'purge') {
        this.options.oweManifest();
        awaitingAuthority.push(journal.migrationId);
        continue;
      }
      await this.deleteUncommittedTarget(journal);
      this.options.migrations.rollbackPrecommit(journal.migrationId);
      rolledBack.push(journal.migrationId);
    }
    return { rolledBack, awaitingAuthority };
  }

  private async copy(journal: ProtectedMigrationJournal, authority: ProtectedMigrationAuthority): Promise<void> {
    const unprotectLayout = journal.operation === 'unprotect' ? unprotectBatchLayout(journal.items) : undefined;
    for (const item of journal.items) {
      if (journal.operation === 'protect') await this.copyProtect(journal, item, authority);
      else if (journal.operation === 'unprotect') await this.copyUnprotect(journal, item, authority, unprotectLayout!.get(item.photoId)!);
      else await this.copyMove(journal, item, authority);
    }
  }

  private async copyProtect(
    journal: ProtectedMigrationJournal,
    item: ProtectedMigrationItem,
    authority: ProtectedMigrationAuthority,
  ): Promise<void> {
    const albumId = journal.targetAlbumId!;
    const albumKey = requireAlbumKey(authority.targetAlbumKey, 'target album');
    const resolver = authority.libraryResolver;
    if (resolver === undefined) throw new ProtectedPhotoMigrationServiceError('ordinary library read authority is required');
    const ref = await this.options.protectedBlobs.putOriginal({
      albumId,
      albumKey,
      contentHash: item.sourceBlobRef,
      ...(this.metadata(journal, item, authority).version === 2 ? { variantId: item.photoId } : {}),
      plaintext: this.options.ordinaryBlobs.getStream(item.sourceBlobRef, resolver, item.sourceAssetOwnerId ?? item.photoId),
    });
    if (ref !== item.targetBlobRef) throw new ProtectedPhotoMigrationServiceError('protected target reference changed');
    await this.options.protectedBlobs.putDerivative({
      albumId,
      albumKey,
      blobRef: ref,
      kind: 'thumb',
      plaintext: this.options.ordinaryBlobs.getThumbStream(item.sourceDerivativeRef ?? item.sourceBlobRef, 'thumb', resolver, item.photoId),
    });
    await this.options.protectedBlobs.putDerivative({
      albumId,
      albumKey,
      blobRef: ref,
      kind: 'mid',
      plaintext: this.options.ordinaryBlobs.getThumbStream(item.sourceDerivativeRef ?? item.sourceBlobRef, 'mid', resolver, item.photoId),
    });
    for (const sidecar of this.options.migrations.ordinarySidecars(item.photoId)) {
      await this.options.protectedBlobs.putSidecar({
        albumId,
        albumKey,
        blobRef: ref,
        sidecarHash: sidecar.contentHash,
        plaintext: this.options.ordinaryBlobs.getSidecarStream(sidecar.ownerId ?? item.photoId, sidecar.contentHash, resolver),
      });
    }
  }

  private async copyUnprotect(
    journal: ProtectedMigrationJournal,
    item: ProtectedMigrationItem,
    authority: ProtectedMigrationAuthority,
    itemLayout: UnprotectItemLayout,
  ): Promise<void> {
    const albumId = journal.sourceAlbumId!;
    const albumKey = requireAlbumKey(authority.sourceAlbumKey, 'source album');
    const targetKey = authority.targetLibraryKey;
    if (targetKey === undefined) throw new ProtectedPhotoMigrationServiceError('ordinary library write authority is required');
    const metadata = this.metadata(journal, item, authority);
    if (item.photoId === itemLayout.ownerPhotoId) {
      const written = await this.options.ordinaryBlobs.putOriginal(
        this.options.protectedBlobs.getStream(albumId, item.sourceBlobRef, 'original', albumKey),
        targetKey,
        itemLayout.ownerPhotoId,
      );
      if (written.contentHash !== item.targetBlobRef || written.keyId !== targetKey.id) {
        throw new ProtectedPhotoMigrationServiceError('ordinary target did not use the active library key');
      }
    } else {
      const validSource = await this.options.protectedBlobs.verify(albumId, item.sourceBlobRef, 'original', albumKey, item.targetBlobRef);
      if (!validSource) throw new ProtectedPhotoMigrationServiceError('protected source original failed verification');
    }
    await this.options.ordinaryBlobs.putThumb(
      this.options.protectedBlobs.getStream(albumId, item.sourceBlobRef, 'thumb', albumKey),
      targetKey,
      item.photoId,
      itemLayout.derivativeKey,
      'thumb',
    );
    await this.options.ordinaryBlobs.putThumb(
      this.options.protectedBlobs.getStream(albumId, item.sourceBlobRef, 'mid', albumKey),
      targetKey,
      item.photoId,
      itemLayout.derivativeKey,
      'mid',
    );
    const fallback = authority.libraryResolver;
    const resolver: KeyResolver = (keyId) => (keyId === targetKey.id ? targetKey.key : fallback?.(keyId));
    for (const sidecar of metadataSidecars(metadata)) {
      const writtenSidecar = await this.options.ordinaryBlobs.putSidecar(
        this.options.protectedBlobs.getSidecarStream(albumId, item.sourceBlobRef, sidecar.contentHash, albumKey),
        targetKey,
        itemLayout.ownerPhotoId,
      );
      if (writtenSidecar.contentHash !== sidecar.contentHash) {
        throw new ProtectedPhotoMigrationServiceError('ordinary target sidecar content hash changed');
      }
      if (
        writtenSidecar.keyId !== targetKey.id &&
        !(await this.options.ordinaryBlobs.verifySidecar(itemLayout.ownerPhotoId, sidecar.contentHash, resolver))
      ) {
        throw new ProtectedPhotoMigrationServiceError('ordinary target sidecar failed verification');
      }
    }
  }

  private async copyMove(
    journal: ProtectedMigrationJournal,
    item: ProtectedMigrationItem,
    authority: ProtectedMigrationAuthority,
  ): Promise<void> {
    const sourceId = journal.sourceAlbumId!;
    const targetId = journal.targetAlbumId!;
    const sourceKey = requireAlbumKey(authority.sourceAlbumKey, 'source album');
    const targetKey = requireAlbumKey(authority.targetAlbumKey, 'target album');
    const metadata = this.metadata(journal, item, authority);
    const ref = await this.options.protectedBlobs.putOriginal({
      albumId: targetId,
      albumKey: targetKey,
      contentHash: metadata.photo.contentHash,
      ...(metadata.version === 2 ? { variantId: item.photoId } : {}),
      plaintext: this.options.protectedBlobs.getStream(sourceId, item.sourceBlobRef, 'original', sourceKey),
    });
    if (ref !== item.targetBlobRef) throw new ProtectedPhotoMigrationServiceError('protected move target reference changed');
    for (const kind of ['thumb', 'mid'] as const) {
      await this.options.protectedBlobs.putDerivative({
        albumId: targetId,
        albumKey: targetKey,
        blobRef: ref,
        kind,
        plaintext: this.options.protectedBlobs.getStream(sourceId, item.sourceBlobRef, kind, sourceKey),
      });
    }
    for (const sidecar of metadataSidecars(metadata)) {
      await this.options.protectedBlobs.putSidecar({
        albumId: targetId,
        albumKey: targetKey,
        blobRef: ref,
        sidecarHash: sidecar.contentHash,
        plaintext: this.options.protectedBlobs.getSidecarStream(sourceId, item.sourceBlobRef, sidecar.contentHash, sourceKey),
      });
    }
  }

  private async verifyTarget(journal: ProtectedMigrationJournal, authority: ProtectedMigrationAuthority): Promise<void> {
    const unprotectLayout = journal.operation === 'unprotect' ? unprotectBatchLayout(journal.items) : undefined;
    for (const item of journal.items) {
      const metadata = this.metadata(journal, item, authority);
      if (journal.operation === 'unprotect') {
        const itemLayout = unprotectLayout!.get(item.photoId)!;
        const targetKey = authority.targetLibraryKey;
        if (targetKey === undefined) throw new ProtectedPhotoMigrationServiceError('ordinary library write authority is required');
        const fallback = authority.libraryResolver;
        const resolver: KeyResolver = (keyId) => (keyId === targetKey.id ? targetKey.key : fallback?.(keyId));
        const validOriginal = await this.options.ordinaryBlobs.verifyOriginal(item.targetBlobRef, resolver, itemLayout.ownerPhotoId);
        const validThumbs = await this.options.ordinaryBlobs.verifyThumbs(itemLayout.derivativeKey, resolver, item.photoId);
        if (!validOriginal || !validThumbs) throw new ProtectedPhotoMigrationServiceError('ordinary destination failed verification');
        for (const sidecar of metadataSidecars(metadata)) {
          if (!(await this.options.ordinaryBlobs.verifySidecar(itemLayout.ownerPhotoId, sidecar.contentHash, resolver))) {
            throw new ProtectedPhotoMigrationServiceError('ordinary destination failed verification');
          }
        }
        continue;
      }
      const albumId = journal.targetAlbumId!;
      const albumKey = requireAlbumKey(authority.targetAlbumKey, 'target album');
      const validOriginal = await this.options.protectedBlobs.verify(
        albumId,
        item.targetBlobRef,
        'original',
        albumKey,
        metadata.photo.contentHash,
      );
      const validThumb = await this.options.protectedBlobs.verify(albumId, item.targetBlobRef, 'thumb', albumKey);
      const validMid = await this.options.protectedBlobs.verify(albumId, item.targetBlobRef, 'mid', albumKey);
      if (!validOriginal || !validThumb || !validMid) {
        throw new ProtectedPhotoMigrationServiceError('protected destination failed verification');
      }
      for (const sidecar of metadataSidecars(metadata)) {
        if (!(await this.options.protectedBlobs.verifySidecar(albumId, item.targetBlobRef, sidecar.contentHash, albumKey))) {
          throw new ProtectedPhotoMigrationServiceError('protected destination failed verification');
        }
      }
    }
  }

  private commit(journal: ProtectedMigrationJournal, authority: ProtectedMigrationAuthority): void {
    if (journal.operation === 'protect') {
      this.options.migrations.commitProtect(journal.migrationId);
      return;
    }
    if (journal.operation === 'move') {
      this.options.migrations.commitMove(journal.migrationId);
      return;
    }
    const targetKey = authority.targetLibraryKey;
    if (targetKey === undefined) throw new ProtectedPhotoMigrationServiceError('ordinary library write authority is required');
    const unprotectLayout = unprotectBatchLayout(journal.items);
    const unprotectedIds = new Set(journal.items.map((item) => item.photoId));
    const restorations = new Map<
      string,
      {
        photo: PhotoInsert;
        memberships: ProtectedPhotoMetadata['ordinaryMemberships'];
        editRevisions?: readonly BackupManifestEditRevisionV11[];
        sidecars?: readonly (ProtectedSidecarMetadata & { readonly keyId?: number })[];
      }
    >();
    for (const item of journal.items) {
      const metadata = this.metadata(journal, item, authority);
      if (metadata.photo.deletedAt !== null) throw new ProtectedPhotoMigrationServiceError('deleted photos cannot be unprotected');
      const itemLayout = unprotectLayout.get(item.photoId)!;
      const isBatchOwner = item.photoId === itemLayout.ownerPhotoId;
      const savedSourceId = metadata.version === 2 ? metadata.photo.variantSourceId : undefined;
      const restoredVariantSourceId = isBatchOwner
        ? null
        : savedSourceId !== undefined && savedSourceId !== null && unprotectedIds.has(savedSourceId)
          ? savedSourceId
          : itemLayout.ownerPhotoId;
      const { deletedAt: _deletedAt, ...photo } = metadata.photo;
      restorations.set(item.photoId, {
        photo: {
          ...photo,
          keyId: targetKey.id,
          derivativeKey: itemLayout.derivativeKey,
          variantSourceId: restoredVariantSourceId,
          assetOwnerId: isBatchOwner ? null : itemLayout.ownerPhotoId,
        },
        memberships: metadata.ordinaryMemberships,
        ...(metadata.version === 2 ? { editRevisions: metadata.editRevisions } : {}),
        ...(metadata.version === 2 && metadata.sidecars !== undefined
          ? {
              sidecars: metadata.sidecars.map((sidecar) => ({
                ...sidecar,
                keyId: this.options.ordinaryBlobs.sidecarKeyId(itemLayout.ownerPhotoId, sidecar.contentHash),
              })),
            }
          : {}),
      });
    }
    this.options.migrations.commitUnprotect(journal.migrationId, restorations, authority.ordinaryAlbum);
  }

  private metadata(
    journal: ProtectedMigrationJournal,
    item: ProtectedMigrationItem,
    authority: ProtectedMigrationAuthority,
  ): ProtectedPhotoMetadata {
    const albumId = journal.operation === 'unprotect' ? journal.sourceAlbumId! : journal.targetAlbumId!;
    const albumKey =
      journal.operation === 'unprotect'
        ? requireAlbumKey(authority.sourceAlbumKey, 'source album')
        : requireAlbumKey(authority.targetAlbumKey, 'target album');
    return openProtectedPhotoMetadata(
      { libraryId: this.options.libraryId, albumId, photoId: item.photoId },
      albumKey,
      item.sealedTargetMetadata,
    );
  }

  private async purgeSource(journal: ProtectedMigrationJournal): Promise<void> {
    for (const item of journal.items) {
      if (journal.operation === 'protect') {
        if (this.options.migrations.countOrdinaryBlobOwners(item.sourceBlobRef) === 0) {
          await this.options.ordinaryBlobs.deleteOriginal(item.sourceBlobRef);
          await this.options.ordinaryBlobs.deleteThumbs(item.sourceBlobRef);
        }
        if (item.sourceDerivativeRef !== undefined && item.sourceDerivativeRef !== item.sourceBlobRef) {
          await this.options.ordinaryBlobs.deleteThumbs(item.sourceDerivativeRef);
        }
        for (const ownerId of new Set([item.photoId, ...(item.sourceAssetOwnerId === undefined ? [] : [item.sourceAssetOwnerId])])) {
          if (!this.options.migrations.hasOrdinarySidecarOwner(ownerId)) {
            await this.options.ordinaryBlobs.deleteSidecars(ownerId);
          }
        }
        continue;
      }
      const sourceAlbumId = journal.sourceAlbumId!;
      if (this.options.migrations.countProtectedBlobOwners(sourceAlbumId, item.sourceBlobRef) === 0) {
        await this.options.protectedBlobs.deleteBlob(sourceAlbumId, item.sourceBlobRef);
      }
    }
  }

  private async deleteUncommittedTarget(journal: ProtectedMigrationJournal): Promise<void> {
    const unprotectLayout = journal.operation === 'unprotect' ? unprotectBatchLayout(journal.items) : undefined;
    for (const item of journal.items) {
      if (journal.operation === 'unprotect') {
        const itemLayout = unprotectLayout!.get(item.photoId)!;
        if (this.options.migrations.countOrdinaryBlobOwners(item.targetBlobRef) === 0) {
          await this.options.ordinaryBlobs.deleteOriginal(item.targetBlobRef);
          await this.options.ordinaryBlobs.deleteThumbs(item.targetBlobRef);
        }
        if (itemLayout.derivativeKey !== item.targetBlobRef) {
          await this.options.ordinaryBlobs.deleteThumbs(itemLayout.derivativeKey);
        }
        if (!this.options.migrations.hasOrdinarySidecarOwner(itemLayout.ownerPhotoId)) {
          await this.options.ordinaryBlobs.deleteSidecars(itemLayout.ownerPhotoId);
        }
      } else if (this.options.migrations.countProtectedBlobOwners(journal.targetAlbumId!, item.targetBlobRef) === 0) {
        await this.options.protectedBlobs.deleteBlob(journal.targetAlbumId!, item.targetBlobRef);
      }
    }
  }
}
