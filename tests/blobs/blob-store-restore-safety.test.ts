import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { buildBackupManifestV13, type BackupManifestPhotoV13 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreEngine } from '../../src/main/backup/restore-engine.js';
import { BlobStore, BlobStoreError } from '../../src/main/blobs/blob-store.js';
import { createEncryptStream, type EnvelopeKey, type KeyResolver } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { variantDerivativeKey } from '../../src/main/db/variant-repository.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import { DEFAULT_GALLERY_POLICY } from '../../src/shared/library/gallery-policy.js';

const KEY: EnvelopeKey = { id: 1, key: randomBytes(32) };
const RESOLVE: KeyResolver = (id) => (id === 1 ? KEY.key : undefined);

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

async function freshStore(): Promise<{ store: BlobStore; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-blobs-restore-safety-'));
  const store = new BlobStore({ dataDir });
  await store.init();
  return { store, dataDir };
}

function manifestPhoto(
  id: string,
  fileName: string,
  contentHash: string,
  bytes: number,
  keyId: number,
  importedAt: string,
  overrides: Partial<BackupManifestPhotoV13> = {},
): BackupManifestPhotoV13 {
  return {
    id,
    fileName,
    fileKind: 'jpeg',
    mediaInfo: null,
    width: 1,
    height: 1,
    bytes,
    contentHash,
    blobPath: `blobs/${contentHash.slice(0, 2)}/${contentHash}`,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt,
    importSource: 'cloud-restore',
    favorite: false,
    keyId,
    deletedAt: null,
    ...overrides,
  };
}

test('restoreOriginal preserves a preexisting valid original on corrupt or mismatched-AAD EEXIST (#1431)', async () => {
  const { store, dataDir } = await freshStore();
  const plaintext = randomBytes(4096);
  const ref = await store.putOriginal(Readable.from([plaintext]), KEY, 'owner-photo');
  const validCiphertext = await buffer(store.getEncryptedStream(ref.contentHash));

  await assert.rejects(
    store.restoreOriginal(ref.contentHash, Readable.from([Buffer.from('corrupt-bytes')]), RESOLVE, 'owner-photo'),
    BlobStoreError,
  );
  assert.equal(await store.verifyOriginal(ref.contentHash, RESOLVE, 'owner-photo'), true);
  assert.deepEqual(await buffer(store.getStream(ref.contentHash, RESOLVE, 'owner-photo')), plaintext);

  await assert.rejects(store.restoreOriginal(ref.contentHash, Readable.from([validCiphertext]), RESOLVE, 'wrong-photo'), BlobStoreError);
  assert.equal(await store.verifyOriginal(ref.contentHash, RESOLVE, 'owner-photo'), true);

  const { store: siblingSource } = await freshStore();
  await siblingSource.putOriginal(Readable.from([plaintext]), KEY, 'sibling-photo');
  const siblingCiphertext = await buffer(siblingSource.getEncryptedStream(ref.contentHash));
  await assert.rejects(
    store.restoreOriginal(ref.contentHash, Readable.from([siblingCiphertext]), RESOLVE, 'sibling-photo'),
    BlobStoreError,
  );
  assert.equal(await store.verifyOriginal(ref.contentHash, RESOLVE, 'owner-photo'), true);
  assert.deepEqual(await buffer(store.getEncryptedStream(ref.contentHash)), validCiphertext);
  assert.deepEqual(readdirSync(join(dataDir, 'tmp')), []);
});

test('restoreSidecar preserves a preexisting valid companion on corrupt or mismatched-key EEXIST (#1431)', async () => {
  const { store, dataDir } = await freshStore();
  const sidecarBytes = Buffer.from('<x:xmpmeta>custody-check</x:xmpmeta>');
  const ref = await store.putSidecar(Readable.from([sidecarBytes]), KEY, 'owner-photo');
  const validCiphertext = await buffer(store.getEncryptedSidecarStream('owner-photo', ref.contentHash));

  await assert.rejects(
    store.restoreSidecar('owner-photo', ref.contentHash, Readable.from([Buffer.from('not-an-envelope')]), RESOLVE),
    BlobStoreError,
  );
  assert.equal(await store.verifySidecar('owner-photo', ref.contentHash, RESOLVE), true);

  const otherKey: EnvelopeKey = { id: 2, key: randomBytes(32) };
  const { store: otherSource } = await freshStore();
  await otherSource.putSidecar(Readable.from([sidecarBytes]), otherKey, 'owner-photo');
  const otherCiphertext = await buffer(otherSource.getEncryptedSidecarStream('owner-photo', ref.contentHash));
  const resolveOnlyOther: KeyResolver = (id) => (id === 2 ? otherKey.key : undefined);

  await assert.rejects(
    store.restoreSidecar('owner-photo', ref.contentHash, Readable.from([otherCiphertext]), resolveOnlyOther),
    BlobStoreError,
  );
  assert.equal(await store.verifySidecar('owner-photo', ref.contentHash, RESOLVE), true);
  assert.deepEqual(await buffer(store.getEncryptedSidecarStream('owner-photo', ref.contentHash)), validCiphertext);
  assert.deepEqual(readdirSync(join(dataDir, 'tmp')), []);
});

function sharedVariantManifest(libraryId: string, generatedAt: string, contentHash: string, bytes: number, keyId: number) {
  const photos: readonly BackupManifestPhotoV13[] = [
    manifestPhoto('P1', 'IMG_1.JPG', contentHash, bytes, keyId, generatedAt),
    manifestPhoto('P2', 'IMG_2.JPG', contentHash, bytes, keyId, generatedAt, {
      derivativeKey: variantDerivativeKey('P2', contentHash),
      variantSourceId: 'P1',
      // Omit assetOwnerId so P2 attempts verification under AAD 'P2' instead of 'P1',
      // failing verification while sharing P1's already-verified contentHash.
    }),
  ];
  return {
    blobPath: photos[0]!.blobPath,
    manifest: buildBackupManifestV13({
      libraryId,
      generatedAt,
      snapshot: {
        databaseSchema: 33,
        keyIds: [1],
        totals: { photos: 2, bytes: bytes * 2, albums: 0 },
        photos,
        albums: [],
        protectedAlbums: [],
        protectedPhotos: [],
        activity: [],
        boards: [],
        sidecars: [],
        galleryPolicy: DEFAULT_GALLERY_POLICY,
        hiddenAlbumIds: [],
        folders: [],
        albumTree: [],
        smartAlbums: [],
        editRevisions: [],
        provenance: [],
        variantFamilies: [{ contentHash, representativeId: 'P1' }],
      },
    }),
  };
}

test('RestoreEngine partial restore preserves shared-hash original when a sibling fails verification (#1431)', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-restore-shared-source-'));
  const targetDir = join(mkdtempSync(join(tmpdir(), 'overlook-restore-shared-target-')), 'library');
  const libraryId = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
  const generatedAt = '2026-07-14T23:00:00.000Z';

  const keyStore = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: sourceDir });
  const masterKey = keyStore.masterKeyBytes();
  const sourceStore = new BlobStore({ dataDir: sourceDir });
  await sourceStore.init();

  const jpeg = sampleJpeg(1);
  const ref = await sourceStore.putOriginal(Readable.from([jpeg]), keyStore.currentKey(), 'P1');
  const { blobPath, manifest } = sharedVariantManifest(libraryId, generatedAt, ref.contentHash, ref.bytes, ref.keyId);

  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-restore-shared-remote-')), libraryId });
  await provider.put(blobPath, sourceStore.getEncryptedStream(ref.contentHash));
  const sealedManifest = await buffer(
    Readable.from([Buffer.from(JSON.stringify(manifest))]).pipe(createEncryptStream(keyStore.currentKey(), { photoId: 'manifest' })),
  );
  await provider.put('manifest/gen-1.ovlk', Readable.from([sealedManifest]));
  const bootstrap = sealRecoveryBootstrap(
    {
      schema: 2,
      libraryId,
      generatedAt,
      manifestGeneration: 1,
      manifestSha256: createHash('sha256').update(sealedManifest).digest('hex'),
      previousManifest: null,
      keys: keyStore.exportWrappedKeys(),
    },
    masterKey,
  );
  await provider.put('recovery/bootstrap.ovrb', Readable.from([bootstrap]));

  const engine = new RestoreEngine({
    provider,
    targetDir,
    safeStorage: fakeSafeStorage,
    availableBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    thumbnails: (store) => ({
      generateFor: async (req) => {
        const key = req.derivativeKey ?? req.contentHash;
        await store.putThumb(Readable.from([Buffer.from(`t:${req.photoId}`)]), req.key, req.photoId, key, 'thumb');
        await store.putThumb(Readable.from([Buffer.from(`m:${req.photoId}`)]), req.key, req.photoId, key, 'mid');
        return { generated: true, width: 1, height: 1 };
      },
    }),
    events: { progress: () => {} },
  });

  const result = await engine.run({ masterKey, allowReplace: false });
  assert.equal(result.photos, 1);
  assert.deepEqual(result.missing, [{ path: blobPath, kind: 'original', photoId: 'P2', reason: 'failed-verification' }]);

  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: targetDir });
  const restoredStore = new BlobStore({ dataDir: targetDir });
  await restoredStore.init();
  assert.equal(await restoredStore.verifyOriginal(ref.contentHash, restoredKeys.resolver(), 'P1'), true);
  assert.deepEqual(await buffer(restoredStore.getStream(ref.contentHash, restoredKeys.resolver(), 'P1')), jpeg);
  restoredKeys.close();
});
