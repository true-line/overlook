import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { ProtectedBlobStore } from '../../src/main/blobs/protected-blob-store.js';
import {
  ProtectedPhotoMigrationService,
  ProtectedPhotoMigrationServiceError,
  type ProtectedMigrationAuthority,
} from '../../src/main/crypto/protected-photo-migration-service.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProtectedPhotoMigrationRepository } from '../../src/main/db/protected-photo-migration-repository.js';
import { SidecarRepository } from '../../src/main/db/sidecar-repository.js';
import { run, runNamed } from '../../src/main/db/sql.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';

const LIBRARY_ID = 'library-1429';
const PHOTO_ID = 'photo-1429-a';

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function seedPhotoAndSidecars(db: ReturnType<typeof openLibraryDatabase>, ordinary: BlobStore, libraryKey: Buffer) {
  const originalBytes = Buffer.from('raw-photo-1429');
  const contentHash = createHash('sha256').update(originalBytes).digest('hex');
  await ordinary.putOriginal(Readable.from(originalBytes), { id: 1, key: libraryKey }, PHOTO_ID);
  await ordinary.putThumb(Readable.from('thumb-1429'), { id: 1, key: libraryKey }, PHOTO_ID, contentHash, 'thumb');
  await ordinary.putThumb(Readable.from('mid-1429'), { id: 1, key: libraryKey }, PHOTO_ID, contentHash, 'mid');

  const photos = new PhotosRepository(db);
  photos.insert({
    id: PHOTO_ID,
    fileName: 'IMG_1429.CR3',
    fileKind: 'raw',
    width: 2400,
    height: 1600,
    bytes: originalBytes.length,
    contentHash,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: '2026-07-16T12:00:00.000Z',
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-16T12:00:00.000Z',
    importSource: 'folder',
    favorite: false,
    keyId: 1,
  });

  const sidecars = new SidecarRepository(db);
  const xmpRef = await ordinary.putSidecar(Readable.from('<xmp>rating=5</xmp>'), { id: 1, key: libraryKey }, PHOTO_ID);
  const aaeRef = await ordinary.putSidecar(Readable.from('<plist>adjustments</plist>'), { id: 1, key: libraryKey }, PHOTO_ID);
  sidecars.insert({
    photoId: PHOTO_ID,
    ownerId: PHOTO_ID,
    role: 'xmp',
    fileName: 'IMG_1429.xmp',
    contentHash: xmpRef.contentHash,
    bytes: xmpRef.bytes,
    keyId: 1,
    importedAt: '2026-07-16T12:00:00.000Z',
  });
  sidecars.insert({
    photoId: PHOTO_ID,
    ownerId: PHOTO_ID,
    role: 'aae',
    fileName: 'IMG_1429.AAE',
    contentHash: aaeRef.contentHash,
    bytes: aaeRef.bytes,
    keyId: 1,
    importedAt: '2026-07-16T12:00:01.000Z',
  });
  return { photos, sidecars, xmpHash: xmpRef.contentHash, aaeHash: aaeRef.contentHash };
}

async function makeFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-1429-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  const ordinary = new BlobStore({ dataDir });
  const protectedBlobs = new ProtectedBlobStore(dataDir);
  await ordinary.init();
  await protectedBlobs.init();

  const libraryKey = randomBytes(32);
  const rotatedKey = randomBytes(32);
  const albumKeyA = randomBytes(32);
  const albumKeyB = randomBytes(32);
  const resolver = (keyId: number) => (keyId === 1 ? libraryKey : keyId === 2 ? rotatedKey : undefined);

  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-1', '2026-07-16T12:00:00.000Z')`);
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (2, 'wrapped-2', '2026-07-17T12:00:00.000Z')`);
  for (const albumId of ['protected-a', 'protected-b']) {
    runNamed(
      db,
      `INSERT INTO protected_album_records (
         album_id, record_version, migration_state, credential_generation, metadata_generation,
         credential_record, sealed_metadata, created_at, updated_at
       ) VALUES (@albumId, 1, 'active', 1, 1, x'01', x'02', @now, @now)`,
      { albumId, now: '2026-07-16T12:00:00.000Z' },
    );
  }

  const { photos, sidecars, xmpHash, aaeHash } = await seedPhotoAndSidecars(db, ordinary, libraryKey);
  const migrations = new ProtectedPhotoMigrationRepository(db);
  let seq = 0;
  const service = new ProtectedPhotoMigrationService({
    libraryId: LIBRARY_ID,
    ordinaryBlobs: ordinary,
    protectedBlobs,
    photos,
    migrations,
    oweManifest: () => undefined,
    createMigrationId: () => `mig-1429-${String(++seq)}`,
  });
  const protectAuthority: ProtectedMigrationAuthority = { targetAlbumKey: albumKeyA, libraryResolver: resolver };
  return {
    db,
    ordinary,
    protectedBlobs,
    photos,
    sidecars,
    migrations,
    service,
    libraryKey,
    rotatedKey,
    albumKeyA,
    albumKeyB,
    resolver,
    xmpHash,
    aaeHash,
    protectAuthority,
  };
}

describe('Companion sidecar custody round-trip (#1429)', () => {
  test('round-trips XMP and AAE companions byte-for-byte across protect, move, and unprotect without leaving orphans', async () => {
    const f = await makeFixture();
    try {
      const protectId = f.service.prepareProtect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [PHOTO_ID] });
      await f.service.runToCompletion(protectId, f.protectAuthority);

      assert.equal(f.sidecars.listForPhoto(PHOTO_ID).length, 0);
      assert.equal((await f.ordinary.listSidecarEntries()).length, 0, 'ordinary sidecars are cleaned after protect');
      const storedA = f.migrations.getProtected(PHOTO_ID)!;
      assert.equal(f.protectedBlobs.hasSidecar('protected-a', storedA.blobRef, f.xmpHash), true);
      assert.equal(f.protectedBlobs.hasSidecar('protected-a', storedA.blobRef, f.aaeHash), true);

      const moveId = f.service.prepareMove({
        sourceAlbumId: 'protected-a',
        sourceAlbumKey: f.albumKeyA,
        targetAlbumId: 'protected-b',
        targetAlbumKey: f.albumKeyB,
        photoIds: [PHOTO_ID],
      });
      await f.service.runToCompletion(moveId, { sourceAlbumKey: f.albumKeyA, targetAlbumKey: f.albumKeyB });
      const storedB = f.migrations.getProtected(PHOTO_ID)!;
      assert.equal(f.protectedBlobs.hasSidecar('protected-a', storedA.blobRef, f.xmpHash), false, 'source album sidecar purged on move');
      assert.equal(f.protectedBlobs.hasSidecar('protected-b', storedB.blobRef, f.xmpHash), true);
      assert.equal(f.protectedBlobs.hasSidecar('protected-b', storedB.blobRef, f.aaeHash), true);

      const unprotectId = f.service.prepareUnprotect({ albumId: 'protected-b', albumKey: f.albumKeyB, photoIds: [PHOTO_ID] });
      await f.service.runToCompletion(unprotectId, {
        sourceAlbumKey: f.albumKeyB,
        targetLibraryKey: { id: 2, key: f.rotatedKey },
        libraryResolver: f.resolver,
      });

      assert.equal(f.protectedBlobs.hasSidecar('protected-b', storedB.blobRef, f.xmpHash), false);
      const restoredSidecars = f.sidecars.listForPhoto(PHOTO_ID);
      assert.deepEqual(
        restoredSidecars.map((row) => ({ role: row.role, fileName: row.fileName, keyId: row.keyId, ownerId: row.ownerId })),
        [
          { role: 'aae', fileName: 'IMG_1429.AAE', keyId: 2, ownerId: PHOTO_ID },
          { role: 'xmp', fileName: 'IMG_1429.xmp', keyId: 2, ownerId: PHOTO_ID },
        ],
      );
      assert.equal(await streamText(f.ordinary.getSidecarStream(PHOTO_ID, f.xmpHash, f.resolver)), '<xmp>rating=5</xmp>');
      assert.equal(await streamText(f.ordinary.getSidecarStream(PHOTO_ID, f.aaeHash, f.resolver)), '<plist>adjustments</plist>');
    } finally {
      f.db.close();
    }
  });
});

describe('Companion sidecar shared ownership and rollback (#1429)', () => {
  test('retains shared ordinary sidecar blobs while a sibling variant remains and cleans uncommitted sidecars on rollback', async () => {
    const f = await makeFixture();
    try {
      const dupId = 'photo-1429-dup';
      new VariantRepository(f.db).duplicate(f.photos.get(PHOTO_ID)!, dupId, '2026-08-01T00:00:00.000Z');
      const dup = f.photos.get(dupId)!;
      await f.ordinary.putThumb(Readable.from('dup-thumb'), { id: 1, key: f.libraryKey }, dupId, dup.derivativeKey, 'thumb');
      await f.ordinary.putThumb(Readable.from('dup-mid'), { id: 1, key: f.libraryKey }, dupId, dup.derivativeKey, 'mid');

      const protectRoot = f.service.prepareProtect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [PHOTO_ID] });
      await f.service.runToCompletion(protectRoot, f.protectAuthority);
      assert.equal(f.ordinary.hasSidecar(PHOTO_ID, f.xmpHash), true, 'shared ordinary sidecar survives for remaining duplicate');

      run(f.db, 'DELETE FROM photos WHERE id = ?', dupId);
      await f.ordinary.deleteOriginal(dup.contentHash);
      await f.ordinary.deleteThumbs(dup.contentHash);
      await f.ordinary.deleteThumbs(dup.derivativeKey);
      await f.ordinary.deleteSidecars(PHOTO_ID);
      const unprotectCopy = f.service.prepareUnprotect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [PHOTO_ID] });
      await f.service.advance(unprotectCopy, {
        sourceAlbumKey: f.albumKeyA,
        targetLibraryKey: { id: 2, key: f.rotatedKey },
        libraryResolver: f.resolver,
      });
      await f.service.advance(unprotectCopy, {
        sourceAlbumKey: f.albumKeyA,
        targetLibraryKey: { id: 2, key: f.rotatedKey },
        libraryResolver: f.resolver,
      });
      assert.equal(f.ordinary.hasSidecar(PHOTO_ID, f.xmpHash), true);

      assert.deepEqual(await f.service.repairStartup(), { rolledBack: [unprotectCopy], awaitingAuthority: [] });
      assert.equal(f.ordinary.hasSidecar(PHOTO_ID, f.xmpHash), false, 'uncommitted ordinary sidecars are cleaned on rollback');

      const unprotectFull = f.service.prepareUnprotect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [PHOTO_ID] });
      await f.service.runToCompletion(unprotectFull, {
        sourceAlbumKey: f.albumKeyA,
        targetLibraryKey: { id: 2, key: f.rotatedKey },
        libraryResolver: f.resolver,
      });
      await f.ordinary.deleteSidecars(PHOTO_ID);
      assert.throws(
        () => f.service.prepareProtect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [PHOTO_ID] }),
        ProtectedPhotoMigrationServiceError,
      );
    } finally {
      f.db.close();
    }
  });
});
