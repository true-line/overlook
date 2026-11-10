import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { assetOwnerOf } from '../../src/shared/library/asset-owner.js';
import type { MediaInfo } from '../../src/shared/library/media-info.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { ProtectedBlobStore } from '../../src/main/blobs/protected-blob-store.js';
import {
  ProtectedPhotoMigrationService,
  type ProtectedMigrationAuthority,
} from '../../src/main/crypto/protected-photo-migration-service.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProtectedPhotoMigrationRepository } from '../../src/main/db/protected-photo-migration-repository.js';
import { run, runNamed } from '../../src/main/db/sql.js';
import { VariantRepository, variantDerivativeKey } from '../../src/main/db/variant-repository.js';

const LIBRARY_ID = 'library-1430';
const ROOT_ID = 'photo-1430-a';

const SAMPLE_MEDIA_INFO: MediaInfo = {
  animated: true,
  frameCount: 12,
  loopCount: 0,
};

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function seedRootPhoto(photos: PhotosRepository, contentHash: string, byteLength: number): void {
  photos.insert({
    id: ROOT_ID,
    fileName: 'sunset.gif',
    fileKind: 'gif',
    width: 1600,
    height: 1200,
    bytes: byteLength,
    contentHash,
    camera: 'X100VI',
    lens: '23mm',
    iso: 160,
    aperture: '2.0',
    shutter: '1/500',
    focalLength: 23,
    takenAt: '2026-07-16T12:00:00.000Z',
    gpsLat: 37.77,
    gpsLon: -122.41,
    place: 'San Francisco',
    title: 'Golden Gate Dusk',
    description: 'Warm horizon over the bay',
    importedKeywords: ['bay', 'dusk', 'noise'],
    userTags: ['favorite-spot'],
    suppressedKeywords: ['noise'],
    metadataVersion: 4,
    mediaInfo: SAMPLE_MEDIA_INFO,
    importedAt: '2026-07-16T12:00:00.000Z',
    importSource: 'folder',
    favorite: true,
    keyId: 1,
  });
}

async function makeFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-1430-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  const ordinary = new BlobStore({ dataDir });
  const protectedBlobs = new ProtectedBlobStore(dataDir);
  await ordinary.init();
  await protectedBlobs.init();

  const libraryKey = randomBytes(32);
  const albumKeyA = randomBytes(32);
  const albumKeyB = randomBytes(32);
  const resolver = (keyId: number) => (keyId === 1 ? libraryKey : undefined);

  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', '2026-07-16T12:00:00.000Z')`);
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

  const originalBytes = Buffer.from('original-1430-bytes');
  const contentHash = createHash('sha256').update(originalBytes).digest('hex');
  await ordinary.putOriginal(Readable.from(originalBytes), { id: 1, key: libraryKey }, ROOT_ID);
  await ordinary.putThumb(Readable.from('root-thumb'), { id: 1, key: libraryKey }, ROOT_ID, contentHash, 'thumb');
  await ordinary.putThumb(Readable.from('root-mid'), { id: 1, key: libraryKey }, ROOT_ID, contentHash, 'mid');

  const photos = new PhotosRepository(db);
  seedRootPhoto(photos, contentHash, originalBytes.length);

  const migrations = new ProtectedPhotoMigrationRepository(db);
  const manifestDebts = { count: 0 };
  let seq = 0;
  const service = new ProtectedPhotoMigrationService({
    libraryId: LIBRARY_ID,
    ordinaryBlobs: ordinary,
    protectedBlobs,
    photos,
    migrations,
    oweManifest: () => {
      manifestDebts.count += 1;
    },
    createMigrationId: () => `mig-1430-${String(++seq)}`,
  });

  const protectAuthority: ProtectedMigrationAuthority = { targetAlbumKey: albumKeyA, libraryResolver: resolver };
  const unprotectAuthority: ProtectedMigrationAuthority = {
    sourceAlbumKey: albumKeyA,
    targetLibraryKey: { id: 1, key: libraryKey },
    libraryResolver: resolver,
  };

  return {
    db,
    ordinary,
    protectedBlobs,
    photos,
    migrations,
    service,
    libraryKey,
    albumKeyA,
    albumKeyB,
    resolver,
    contentHash,
    manifestDebts,
    protectAuthority,
    unprotectAuthority,
  };
}

describe('Unprotect metadata fidelity and manifest debt (#1430)', () => {
  test('round-trips Schema V24+ metadata, mediaInfo, search tags, and owes manifests across protect, move, and unprotect', async () => {
    const f = await makeFixture();
    try {
      const protectId = f.service.prepareProtect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [ROOT_ID] });
      await f.service.runToCompletion(protectId, f.protectAuthority);
      assert.equal(f.manifestDebts.count, 1);

      const moveId = f.service.prepareMove({
        sourceAlbumId: 'protected-a',
        sourceAlbumKey: f.albumKeyA,
        targetAlbumId: 'protected-b',
        targetAlbumKey: f.albumKeyB,
        photoIds: [ROOT_ID],
      });
      await f.service.runToCompletion(moveId, { sourceAlbumKey: f.albumKeyA, targetAlbumKey: f.albumKeyB });
      assert.equal(f.manifestDebts.count, 2, 'moving between protected albums owes manifest publication');

      const unprotectId = f.service.prepareUnprotect({ albumId: 'protected-b', albumKey: f.albumKeyB, photoIds: [ROOT_ID] });
      await f.service.runToCompletion(unprotectId, {
        sourceAlbumKey: f.albumKeyB,
        targetLibraryKey: { id: 1, key: f.libraryKey },
        libraryResolver: f.resolver,
      });
      assert.equal(f.manifestDebts.count, 3, 'unprotecting back to ordinary custody owes manifest publication');

      const restored = f.photos.get(ROOT_ID);
      assert.ok(restored !== undefined);
      assert.equal(restored.title, 'Golden Gate Dusk');
      assert.equal(restored.description, 'Warm horizon over the bay');
      assert.deepEqual(restored.importedKeywords, ['bay', 'dusk', 'noise']);
      assert.deepEqual(restored.userTags, ['favorite-spot']);
      assert.deepEqual(restored.suppressedKeywords, ['noise']);
      assert.deepEqual(restored.tags, ['bay', 'dusk', 'favorite-spot']);
      assert.equal(restored.metadataVersion, 4);
      assert.deepEqual(restored.mediaInfo, SAMPLE_MEDIA_INFO);

      const searchPage = f.photos.page({ source: 'all', limit: 10, query: 'favorite-spot' });
      assert.deepEqual(
        searchPage.photos.map((item) => item.id),
        [ROOT_ID],
      );
    } finally {
      f.db.close();
    }
  });
});

describe('Unprotect batch variants and rollback safety (#1430)', () => {
  test('batch-unprotects sibling variants sharing contentHash with distinct derivative keys and shared original owner', async () => {
    const f = await makeFixture();
    try {
      const siblingId = 'photo-1430-b';
      new VariantRepository(f.db).duplicate(f.photos.get(ROOT_ID)!, siblingId, '2026-08-01T00:00:00.000Z');
      const sibling = f.photos.get(siblingId)!;
      await f.ordinary.putThumb(Readable.from('sibling-thumb'), { id: 1, key: f.libraryKey }, siblingId, sibling.derivativeKey, 'thumb');
      await f.ordinary.putThumb(Readable.from('sibling-mid'), { id: 1, key: f.libraryKey }, siblingId, sibling.derivativeKey, 'mid');

      const revisions = new EditRevisionRepository(f.db);
      revisions.append(siblingId, {
        version: 1,
        id: '01J8ED14300000000000000001',
        parentId: null,
        operations: [{ type: 'rotate', version: 1, quarterTurns: 1 }],
        author: { product: 'overlook', version: 'test' },
        createdAt: '2026-08-01T00:00:01.000Z',
        importedFrom: null,
      });

      const protectId = f.service.prepareProtect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [ROOT_ID, siblingId] });
      await f.service.runToCompletion(protectId, f.protectAuthority);
      assert.equal(f.ordinary.hasOriginal(f.contentHash), false);

      const unprotectId = f.service.prepareUnprotect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [siblingId, ROOT_ID] });
      await f.service.runToCompletion(unprotectId, f.unprotectAuthority);

      const restoredRoot = f.photos.get(ROOT_ID)!;
      const restoredSibling = f.photos.get(siblingId)!;
      assert.equal(restoredRoot.assetOwnerId, null);
      assert.equal(restoredRoot.variantSourceId, null);
      assert.equal(restoredRoot.derivativeKey, f.contentHash);

      assert.equal(restoredSibling.assetOwnerId, ROOT_ID);
      assert.equal(restoredSibling.variantSourceId, ROOT_ID);
      assert.equal(restoredSibling.derivativeKey, variantDerivativeKey(siblingId, f.contentHash));

      assert.equal(await streamText(f.ordinary.getStream(f.contentHash, f.resolver, assetOwnerOf(restoredSibling))), 'original-1430-bytes');
      assert.equal(await streamText(f.ordinary.getThumbStream(restoredRoot.derivativeKey, 'thumb', f.resolver, ROOT_ID)), 'root-thumb');
      assert.equal(
        await streamText(f.ordinary.getThumbStream(restoredSibling.derivativeKey, 'thumb', f.resolver, siblingId)),
        'sibling-thumb',
      );
      assert.equal(revisions.list(siblingId).length, 1);
    } finally {
      f.db.close();
    }
  });

  test('pre-commit unprotect rollback cleans unowned variant thumbs and preserves shared ordinary owners', async () => {
    const f = await makeFixture();
    try {
      const siblingId = 'photo-1430-c';
      new VariantRepository(f.db).duplicate(f.photos.get(ROOT_ID)!, siblingId, '2026-08-01T00:00:00.000Z');
      const sibling = f.photos.get(siblingId)!;
      await f.ordinary.putThumb(Readable.from('sibling-thumb'), { id: 1, key: f.libraryKey }, siblingId, sibling.derivativeKey, 'thumb');
      await f.ordinary.putThumb(Readable.from('sibling-mid'), { id: 1, key: f.libraryKey }, siblingId, sibling.derivativeKey, 'mid');

      const protectId = f.service.prepareProtect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [ROOT_ID, siblingId] });
      await f.service.runToCompletion(protectId, f.protectAuthority);

      const unprotectUnowned = f.service.prepareUnprotect({
        albumId: 'protected-a',
        albumKey: f.albumKeyA,
        photoIds: [ROOT_ID, siblingId],
      });
      await f.service.advance(unprotectUnowned, f.unprotectAuthority);
      await f.service.advance(unprotectUnowned, f.unprotectAuthority);
      const expectedVarKey = variantDerivativeKey(siblingId, f.contentHash);
      assert.equal(f.ordinary.hasThumbs(expectedVarKey), true);

      assert.deepEqual(await f.service.repairStartup(), { rolledBack: [unprotectUnowned], awaitingAuthority: [] });
      assert.equal(f.ordinary.hasOriginal(f.contentHash), false);
      assert.equal(f.ordinary.hasThumbs(expectedVarKey), false);

      const unprotectShared = f.service.prepareUnprotect({ albumId: 'protected-a', albumKey: f.albumKeyA, photoIds: [ROOT_ID] });
      await f.ordinary.putOriginal(Readable.from('original-1430-bytes'), { id: 1, key: f.libraryKey }, 'concurrent-owner');
      await f.ordinary.putThumb(
        Readable.from('concurrent-thumb'),
        { id: 1, key: f.libraryKey },
        'concurrent-owner',
        f.contentHash,
        'thumb',
      );
      await f.ordinary.putThumb(Readable.from('concurrent-mid'), { id: 1, key: f.libraryKey }, 'concurrent-owner', f.contentHash, 'mid');
      f.photos.insert({
        id: 'concurrent-owner',
        fileName: 'concurrent.gif',
        fileKind: 'gif',
        width: 1600,
        height: 1200,
        bytes: Buffer.byteLength('original-1430-bytes'),
        contentHash: f.contentHash,
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
        importedAt: '2026-08-02T00:00:00.000Z',
        importSource: 'folder',
        favorite: false,
        keyId: 1,
      });

      assert.deepEqual(await f.service.repairStartup(), { rolledBack: [unprotectShared], awaitingAuthority: [] });
      assert.equal(f.ordinary.hasOriginal(f.contentHash), true, 'shared ordinary original survives rollback');
      assert.equal(await f.ordinary.verifyThumbs(f.contentHash, f.resolver, 'concurrent-owner'), true);
    } finally {
      f.db.close();
    }
  });
});
