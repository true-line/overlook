import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { BlobStore } from '../blobs/blob-store.js';
import { createEncryptStream } from '../crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../crypto/keystore.js';
import { openLibraryDatabase } from '../db/database.js';
import { MIGRATIONS } from '../db/migrations.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { sampleJpeg } from '../library/seed.js';
import { buildBackupManifestV2, type BackupManifestPhotoV2 } from './backup-manifest.js';
import type { StorageProvider } from './provider.js';
import { sealRecoveryBootstrap } from './recovery-bootstrap.js';
import { RestoreEngine } from './restore-engine.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

const GENERATED_AT = '2026-07-15T02:00:00.000Z';
const CURRENT_DATABASE_SCHEMA = Math.max(...MIGRATIONS.map((migration) => migration.version));
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

async function put(provider: StorageProvider, path: string, bytes: Buffer): Promise<void> {
  await provider.put(path, Readable.from([bytes]));
}

async function sealManifest(manifest: unknown, keyStore: KeyStore): Promise<Buffer> {
  return buffer(
    Readable.from([Buffer.from(JSON.stringify(manifest))]).pipe(createEncryptStream(keyStore.currentKey(), { photoId: 'manifest' })),
  );
}

/** Complete provider-neutral fresh-profile restore shared by deterministic and signed-live adapters. */
export async function exerciseDisasterRecoveryContract(
  browser: StorageProvider,
  libraryId: string,
): Promise<{ readonly generation: number; readonly photos: number }> {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-dr-source-'));
  const targetRoot = mkdtempSync(join(tmpdir(), 'overlook-dr-target-'));
  const targetDir = join(targetRoot, 'library');
  const scoped = browser.forLibrary(libraryId);
  const remotePaths: string[] = [];
  let masterKey: Buffer | null = null;
  try {
    const keyStore = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: sourceDir });
    masterKey = keyStore.masterKeyBytes();
    const sourceStore = new BlobStore({ dataDir: sourceDir });
    await sourceStore.init();
    const plaintextById = new Map<string, Buffer>();
    const photos: BackupManifestPhotoV2[] = [];
    for (let index = 0; index < 2; index += 1) {
      const id = `P${String(index + 1)}`;
      const plaintext = sampleJpeg(index + 1);
      plaintextById.set(id, plaintext);
      const ref = await sourceStore.putOriginal(Readable.from([plaintext]), keyStore.currentKey(), id);
      photos.push({
        id,
        fileName: `RECOVERED_${String(index + 1)}.JPG`,
        fileKind: 'jpeg',
        mediaInfo: null,
        width: 1,
        height: 1,
        bytes: ref.bytes,
        contentHash: ref.contentHash,
        blobPath: `blobs/${ref.contentHash.slice(0, 2)}/${ref.contentHash}`,
        camera: index === 0 ? 'Recovery Camera' : null,
        lens: null,
        iso: index === 0 ? 200 : null,
        aperture: null,
        shutter: null,
        focalLength: null,
        takenAt: null,
        gpsLat: null,
        gpsLon: null,
        place: index === 0 ? 'Cloud' : null,
        importedAt: `2026-07-15T02:00:0${String(index)}.000Z`,
        importSource: 'disaster-recovery-contract',
        favorite: index === 0,
        ...(index === 0 ? { isOriginal: true } : {}),
        keyId: ref.keyId,
        deletedAt: null,
      });
      const blobPath = photos[index]?.blobPath ?? '';
      await put(scoped, blobPath, await buffer(sourceStore.getEncryptedStream(ref.contentHash)));
      remotePaths.push(blobPath);
    }
    const manifest = buildBackupManifestV2({
      libraryId,
      generatedAt: GENERATED_AT,
      snapshot: {
        databaseSchema: CURRENT_DATABASE_SCHEMA,
        keyIds: [keyStore.currentKey().id],
        totals: { photos: 2, bytes: photos.reduce((sum, photo) => sum + photo.bytes, 0), albums: 1 },
        photos,
        albums: [{ id: 'A1', name: 'Recovered album', createdAt: GENERATED_AT, position: 0, photoIds: photos.map(({ id }) => id) }],
      },
    });
    const sealedManifest = await sealManifest(manifest, keyStore);
    const bootstrapPath = 'recovery/bootstrap.ovrb';
    await put(
      scoped,
      bootstrapPath,
      sealRecoveryBootstrap(
        {
          schema: 2,
          libraryId,
          generatedAt: GENERATED_AT,
          manifestGeneration: 1,
          manifestSha256: createHash('sha256').update(sealedManifest).digest('hex'),
          previousManifest: null,
          keys: keyStore.exportWrappedKeys(),
        },
        masterKey,
      ),
    );
    remotePaths.push(bootstrapPath);
    const manifestPath = 'manifest/gen-1.ovlk';
    await put(scoped, manifestPath, sealedManifest);
    remotePaths.push(manifestPath);

    assert.ok((await browser.listLibraries()).includes(libraryId));
    const result = await new RestoreEngine({
      provider: browser.forLibrary(libraryId),
      targetDir,
      safeStorage: fakeSafeStorage,
      availableBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
      thumbnails: (store) => ({
        generateFor: async (request) => {
          for (const size of ['thumb', 'mid'] as const) {
            await store.putThumb(
              Readable.from([Buffer.from(`${size}:${request.photoId}`)]),
              request.key,
              request.photoId,
              request.contentHash,
              size,
            );
          }
          return { generated: true, width: 1, height: 1 };
        },
      }),
      events: { progress: () => undefined },
    }).run({ masterKey, allowReplace: false });
    assert.deepEqual(result, { libraryId, generation: 1, photos: 2, resumed: false, missing: [] });
    assert.equal(existsSync(`${targetDir}.restore-staging`), false);
    assert.equal(existsSync(`${targetDir}.restore-previous`), false);

    const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: targetDir });
    const dbKey = restoredKeys.resolver()(1);
    assert.ok(dbKey !== undefined);
    const db = openLibraryDatabase({ path: join(targetDir, 'library.db'), dbKey });
    try {
      const { keyring, ...restored } = new PhotosRepository(db).manifestSnapshot();
      assert.deepEqual(restored, {
        databaseSchema: manifest.databaseSchema,
        keyIds: manifest.keyIds,
        totals: manifest.totals,
        photos: manifest.photos,
        albums: manifest.albums,
      });
      // The keyring (#517) is rebuilt from the recovered custody: every key
      // the manifest uses is registered and present.
      assert.deepEqual(
        keyring.map((entry) => entry.keyId),
        manifest.keyIds,
      );
    } finally {
      db.close();
    }
    const restoredStore = new BlobStore({ dataDir: targetDir });
    await restoredStore.init();
    for (const photo of photos) {
      assert.deepEqual(
        await buffer(restoredStore.getStream(photo.contentHash, restoredKeys.resolver(), assetOwnerOf(photo))),
        plaintextById.get(photo.id),
      );
      assert.equal(await restoredStore.verifyThumbs(photo.contentHash, restoredKeys.resolver(), photo.id), true);
    }
    return { generation: result.generation, photos: result.photos };
  } finally {
    const cleanup = await Promise.allSettled([...remotePaths].reverse().map((path) => scoped.delete(path)));
    assert.equal(
      cleanup.filter((result) => result.status === 'rejected').length,
      0,
      'disaster-recovery contract removes every remote object',
    );
    masterKey?.fill(0);
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
