import { randomUUID } from 'node:crypto';

import { assetOwnerOf } from '../../shared/library/asset-owner.js';

import type { BackupManifestEditRevisionV11 } from '../backup/backup-manifest-edit-revisions.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { ProtectedBlobStore } from '../blobs/protected-blob-store.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type {
  OrdinaryAlbumRestoration,
  ProtectedMigrationJournal,
  ProtectedMigrationItem,
  ProtectedMigrationOperation,
  ProtectedMigrationPhase,
  ProtectedPhotoMigrationRepository,
} from '../db/protected-photo-migration-repository.js';
import type { EnvelopeKey, KeyResolver } from './envelope.js';
import { openProtectedPhotoMetadata, sealProtectedPhotoMetadata, type ProtectedPhotoMetadata } from './protected-photo-metadata.js';
import type { PhotoInsert, PhotoRecord } from '../../shared/library/types.js';

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
  /** Protection removes an ordinary row from the backup manifest. */
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
      const metadata: ProtectedPhotoMetadata = {
        version: 2,
        editRevisions: editHistories.get(photoId) ?? [],
        photo: photoMetadata(photo),
        ordinaryMemberships: this.options.migrations.ordinaryMemberships(photoId),
      };
      return {
        photoId,
        sourceBlobRef: photo.contentHash,
        sourceAssetOwnerId: assetOwnerOf(photo),
        sourceDerivativeRef: photo.derivativeKey,
        targetBlobRef: this.options.protectedBlobs.opaqueRef(albumKey, photo.contentHash, photoId),
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
    const items = input.photoIds.map((photoId) => {
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
        targetBlobRef: metadata.photo.contentHash,
        sealedTargetMetadata: source.sealedMetadata,
        hasThumb: source.hasThumb,
        hasMid: source.hasMid,
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
      return {
        photoId,
        sourceBlobRef: source.blobRef,
        targetBlobRef,
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
        if (journal.operation === 'protect') this.options.oweManifest();
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
        if (journal.operation === 'protect') this.options.oweManifest();
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
    for (const item of journal.items) {
      if (journal.operation === 'protect') await this.copyProtect(journal, item, authority);
      else if (journal.operation === 'unprotect') await this.copyUnprotect(journal, item, authority);
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
  }

  private async copyUnprotect(
    journal: ProtectedMigrationJournal,
    item: ProtectedMigrationItem,
    authority: ProtectedMigrationAuthority,
  ): Promise<void> {
    const albumId = journal.sourceAlbumId!;
    const albumKey = requireAlbumKey(authority.sourceAlbumKey, 'source album');
    const targetKey = authority.targetLibraryKey;
    if (targetKey === undefined) throw new ProtectedPhotoMigrationServiceError('ordinary library write authority is required');
    const written = await this.options.ordinaryBlobs.putOriginal(
      this.options.protectedBlobs.getStream(albumId, item.sourceBlobRef, 'original', albumKey),
      targetKey,
      item.photoId,
    );
    if (written.contentHash !== item.targetBlobRef || written.keyId !== targetKey.id) {
      throw new ProtectedPhotoMigrationServiceError('ordinary target did not use the active library key');
    }
    await this.options.ordinaryBlobs.putThumb(
      this.options.protectedBlobs.getStream(albumId, item.sourceBlobRef, 'thumb', albumKey),
      targetKey,
      item.photoId,
      item.targetBlobRef,
      'thumb',
    );
    await this.options.ordinaryBlobs.putThumb(
      this.options.protectedBlobs.getStream(albumId, item.sourceBlobRef, 'mid', albumKey),
      targetKey,
      item.photoId,
      item.targetBlobRef,
      'mid',
    );
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
    const ref = await this.options.protectedBlobs.putOriginal({
      albumId: targetId,
      albumKey: targetKey,
      contentHash: this.metadata(journal, item, authority).photo.contentHash,
      ...(this.metadata(journal, item, authority).version === 2 ? { variantId: item.photoId } : {}),
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
  }

  private async verifyTarget(journal: ProtectedMigrationJournal, authority: ProtectedMigrationAuthority): Promise<void> {
    for (const item of journal.items) {
      const metadata = this.metadata(journal, item, authority);
      if (journal.operation === 'unprotect') {
        const targetKey = authority.targetLibraryKey;
        if (targetKey === undefined) throw new ProtectedPhotoMigrationServiceError('ordinary library write authority is required');
        const fallback = authority.libraryResolver;
        const resolver: KeyResolver = (keyId) => (keyId === targetKey.id ? targetKey.key : fallback?.(keyId));
        const validOriginal = await this.options.ordinaryBlobs.verifyOriginal(item.targetBlobRef, resolver, item.photoId);
        const validThumbs = await this.options.ordinaryBlobs.verifyThumbs(item.targetBlobRef, resolver, item.photoId);
        if (!validOriginal || !validThumbs) throw new ProtectedPhotoMigrationServiceError('ordinary destination failed verification');
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
    const restorations = new Map<
      string,
      {
        photo: PhotoInsert;
        memberships: ProtectedPhotoMetadata['ordinaryMemberships'];
        editRevisions?: readonly BackupManifestEditRevisionV11[];
      }
    >();
    for (const item of journal.items) {
      const metadata = this.metadata(journal, item, authority);
      if (metadata.photo.deletedAt !== null) throw new ProtectedPhotoMigrationServiceError('deleted photos cannot be unprotected');
      const { deletedAt: _deletedAt, ...photo } = metadata.photo;
      restorations.set(item.photoId, {
        photo: { ...photo, keyId: targetKey.id },
        memberships: metadata.ordinaryMemberships,
        ...(metadata.version === 2 ? { editRevisions: metadata.editRevisions } : {}),
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
        continue;
      }
      const sourceAlbumId = journal.sourceAlbumId!;
      if (this.options.migrations.countProtectedBlobOwners(sourceAlbumId, item.sourceBlobRef) === 0) {
        await this.options.protectedBlobs.deleteBlob(sourceAlbumId, item.sourceBlobRef);
      }
    }
  }

  private async deleteUncommittedTarget(journal: ProtectedMigrationJournal): Promise<void> {
    for (const item of journal.items) {
      if (journal.operation === 'unprotect') {
        await this.options.ordinaryBlobs.deleteOriginal(item.targetBlobRef);
        await this.options.ordinaryBlobs.deleteThumbs(item.targetBlobRef);
      } else if (this.options.migrations.countProtectedBlobOwners(journal.targetAlbumId!, item.targetBlobRef) === 0) {
        await this.options.protectedBlobs.deleteBlob(journal.targetAlbumId!, item.targetBlobRef);
      }
    }
  }
}
