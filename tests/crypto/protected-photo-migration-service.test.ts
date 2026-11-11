import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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
import { openProtectedPhotoMetadata } from '../../src/main/crypto/protected-photo-metadata.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProtectedPhotoMigrationRepository } from '../../src/main/db/protected-photo-migration-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { run, runNamed } from '../../src/main/db/sql.js';

const LIBRARY_ID = 'library-a';
const PHOTO_ID = 'photo-a';

interface World {
  readonly dataDir: string;
  readonly db: ReturnType<typeof openLibraryDatabase>;
  readonly ordinary: BlobStore;
  readonly protected: ProtectedBlobStore;
  readonly photos: PhotosRepository;
  readonly migrations: ProtectedPhotoMigrationRepository;
  readonly service: ProtectedPhotoMigrationService;
  readonly libraryKey: Buffer;
  readonly albumKeyA: Buffer;
  readonly albumKeyB: Buffer;
  readonly contentHash: string;
  readonly protectAuthority: ProtectedMigrationAuthority;
  readonly manifestDebts: { count: number };
  readonly revokedOrdinary: string[][];
}

async function world(onSnapshot?: (photoIds: ReadonlySet<string>) => void): Promise<World> {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-protected-migration-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  const ordinary = new BlobStore({ dataDir });
  const protectedBlobs = new ProtectedBlobStore(dataDir);
  await ordinary.init();
  await protectedBlobs.init();
  const libraryKey = randomBytes(32);
  const albumKeyA = randomBytes(32);
  const albumKeyB = randomBytes(32);
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', '2026-07-16T12:00:00.000Z')`);
  runNamed(db, `INSERT INTO albums (id, name, created_at, position) VALUES ('ordinary-a', 'Ordinary', @now, 0)`, {
    now: '2026-07-16T12:00:00.000Z',
  });
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
  const original = Buffer.from('original secret bytes');
  const contentHash = createHash('sha256').update(original).digest('hex');
  await ordinary.putOriginal(Readable.from(original), { id: 1, key: libraryKey }, PHOTO_ID);
  await ordinary.putThumb(Readable.from('thumb bytes'), { id: 1, key: libraryKey }, PHOTO_ID, contentHash, 'thumb');
  await ordinary.putThumb(Readable.from('mid bytes'), { id: 1, key: libraryKey }, PHOTO_ID, contentHash, 'mid');
  const photos = new PhotosRepository(db);
  photos.insert({
    id: PHOTO_ID,
    fileName: 'secret.jpg',
    fileKind: 'jpeg',
    width: 10,
    height: 10,
    bytes: original.length,
    contentHash,
    camera: 'private camera',
    lens: null,
    iso: 100,
    aperture: '2.8',
    shutter: '1/250',
    focalLength: 35,
    takenAt: '2026-07-16T12:00:00.000Z',
    gpsLat: 1,
    gpsLon: 2,
    place: 'private place',
    importedAt: '2026-07-16T12:00:00.000Z',
    importSource: 'test',
    favorite: true,
    keyId: 1,
  });
  photos.addToAlbum('ordinary-a', [PHOTO_ID]);
  const editRevisions = new EditRevisionRepository(db);
  const migrations = new ProtectedPhotoMigrationRepository(db, {
    snapshot: (photoIds) => {
      onSnapshot?.(photoIds);
      return editRevisions.snapshot(photoIds);
    },
    restore: (revisions) => editRevisions.restore(revisions),
  });
  const manifestDebts = { count: 0 };
  const revokedOrdinary: string[][] = [];
  let sequence = 0;
  const service = new ProtectedPhotoMigrationService({
    libraryId: LIBRARY_ID,
    ordinaryBlobs: ordinary,
    protectedBlobs,
    photos,
    migrations,
    oweManifest: () => {
      manifestDebts.count += 1;
    },
    revokeOrdinary: (photoIds) => revokedOrdinary.push([...photoIds]),
    createMigrationId: () => `migration-${String(++sequence)}`,
  });
  return {
    dataDir,
    db,
    ordinary,
    protected: protectedBlobs,
    photos,
    migrations,
    service,
    libraryKey,
    albumKeyA,
    albumKeyB,
    contentHash,
    protectAuthority: { targetAlbumKey: albumKeyA, libraryResolver: (keyId) => (keyId === 1 ? libraryKey : undefined) },
    manifestDebts,
    revokedOrdinary,
  };
}

async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function protectedOriginalPath(dataDir: string): Promise<string> {
  const entries = await readdir(join(dataDir, 'protected-blobs'), { recursive: true, withFileTypes: true });
  const entry = entries.find((candidate) => candidate.isFile() && candidate.name.endsWith('.original'));
  assert.ok(entry !== undefined);
  return join(entry.parentPath, entry.name);
}

describe('ProtectedPhotoMigrationService', () => {
  test('protect then authorized unprotect round-trips bytes, derivatives, metadata, and memberships', async () => {
    const w = await world();
    const protectId = w.service.prepareProtect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [PHOTO_ID] });
    assert.deepEqual(w.revokedOrdinary, [[PHOTO_ID]], 'ordinary media caches revoke before protected custody begins');
    await w.service.runToCompletion(protectId, w.protectAuthority);
    assert.equal(w.manifestDebts.count, 1, 'removing ordinary custody owes a fresh backup manifest');
    assert.equal(w.photos.get(PHOTO_ID), undefined);
    assert.equal(w.ordinary.hasOriginal(w.contentHash), false);
    const record = w.migrations.getProtected(PHOTO_ID)!;
    const metadata = openProtectedPhotoMetadata(
      { libraryId: LIBRARY_ID, albumId: 'protected-a', photoId: PHOTO_ID },
      w.albumKeyA,
      record.sealedMetadata,
    );
    assert.equal(metadata.photo.place, 'private place');
    assert.deepEqual(metadata.ordinaryMemberships, [{ albumId: 'ordinary-a', position: 0 }]);

    const unprotectId = w.service.prepareUnprotect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [PHOTO_ID] });
    await w.service.runToCompletion(unprotectId, {
      sourceAlbumKey: w.albumKeyA,
      targetLibraryKey: { id: 1, key: w.libraryKey },
      libraryResolver: (keyId) => (keyId === 1 ? w.libraryKey : undefined),
    });
    assert.equal(w.photos.get(PHOTO_ID)?.place, 'private place');
    assert.deepEqual(w.photos.albumMembers('ordinary-a'), [PHOTO_ID]);
    assert.equal(
      (await bytes(w.ordinary.getStream(w.contentHash, (keyId) => (keyId === 1 ? w.libraryKey : undefined), PHOTO_ID))).toString(),
      'original secret bytes',
    );
    assert.equal(await w.ordinary.verifyThumbs(w.contentHash, (keyId) => (keyId === 1 ? w.libraryKey : undefined), PHOTO_ID), true);
    w.db.close();
  });

  test('startup repair safely handles every durable boundary', async () => {
    for (let advances = 0; advances <= 4; advances += 1) {
      const w = await world();
      const migrationId = w.service.prepareProtect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [PHOTO_ID] });
      for (let step = 0; step < advances; step += 1) await w.service.advance(migrationId, w.protectAuthority);
      const phase = w.migrations.get(migrationId)?.phase;
      const debtBeforeRepair = w.manifestDebts.count;
      const repaired = await w.service.repairStartup();
      if (phase === 'commit' || phase === 'purge') {
        assert.deepEqual(repaired, { rolledBack: [], awaitingAuthority: [migrationId] });
        assert.equal(
          w.manifestDebts.count,
          debtBeforeRepair + 1,
          'restart reconstructs manifest debt after the ordinary row committed away',
        );
        assert.equal(w.ordinary.hasOriginal(w.contentHash), true);
        await w.service.runToCompletion(migrationId, w.protectAuthority);
        assert.equal(w.migrations.getProtected(PHOTO_ID)?.albumId, 'protected-a');
      } else {
        assert.deepEqual(repaired, { rolledBack: [migrationId], awaitingAuthority: [] });
        assert.equal(w.photos.get(PHOTO_ID)?.id, PHOTO_ID);
        assert.equal(w.ordinary.hasOriginal(w.contentHash), true);
      }
      w.db.close();
    }
  });

  for (const keepSibling of [false, true]) {
    test(`protects a duplicate with importing sibling ${keepSibling ? 'present' : 'removed'} (#1118)`, async () => {
      const w = await world();
      try {
        const duplicateId = 'duplicate-a';
        new VariantRepository(w.db).duplicate(w.photos.get(PHOTO_ID)!, duplicateId, '2026-09-20T12:00:00.000Z');
        const duplicate = w.photos.get(duplicateId)!;
        const revisions = new EditRevisionRepository(w.db);
        const firstRevisionId = '01J8ED00000000000000000001';
        revisions.append(duplicateId, {
          version: 1,
          id: firstRevisionId,
          parentId: null,
          operations: [{ type: 'rotate', version: 1, quarterTurns: 1 }],
          author: { product: 'overlook', version: 'test' },
          createdAt: '2026-09-20T12:00:01.000Z',
          importedFrom: null,
        });
        revisions.append(duplicateId, {
          version: 1,
          id: '01J8ED00000000000000000002',
          parentId: firstRevisionId,
          operations: [{ type: 'rotate', version: 1, quarterTurns: 2 }],
          author: { product: 'overlook', version: 'test' },
          createdAt: '2026-09-20T12:00:02.000Z',
          importedFrom: null,
        });
        const savedHistory = revisions.snapshot(new Set([duplicateId]));
        for (const kind of ['thumb', 'mid'] as const) {
          await w.ordinary.putThumb(
            Readable.from(`duplicate ${kind}`),
            { id: 1, key: w.libraryKey },
            duplicateId,
            duplicate.derivativeKey,
            kind,
          );
        }
        if (!keepSibling) run(w.db, 'DELETE FROM photos WHERE id = ?', PHOTO_ID);
        const migrationId = w.service.prepareProtect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [duplicateId] });
        const item = w.migrations.get(migrationId)!.items[0]!;
        assert.equal(item.sourceAssetOwnerId, PHOTO_ID);
        assert.equal(item.sourceDerivativeRef, duplicate.derivativeKey);
        for (let step = 0; step < 3; step += 1) await w.service.advance(migrationId, w.protectAuthority);
        assert.equal(w.service.migrationPhase(migrationId), 'commit');
        assert.equal(w.migrations.countOrdinaryBlobOwners(w.contentHash), keepSibling ? 1 : 0);
        assert.deepEqual((await w.service.repairStartup()).awaitingAuthority, [migrationId]);
        assert.equal(w.ordinary.hasThumbs(duplicate.derivativeKey), true, 'source survives until authorized recovery');
        await w.service.runToCompletion(migrationId, w.protectAuthority);
        const protectedRow = w.migrations.getProtected(duplicateId)!;
        const sealed = openProtectedPhotoMetadata(
          { libraryId: LIBRARY_ID, albumId: 'protected-a', photoId: duplicateId },
          w.albumKeyA,
          protectedRow.sealedMetadata,
        );
        assert.equal(sealed.version, 2);
        assert.deepEqual(sealed.version === 2 ? sealed.editRevisions : [], savedHistory);
        assert.equal(revisions.list(duplicateId).length, 0, 'edit history leaves ordinary storage');
        assert.equal(
          (await bytes(w.protected.getStream('protected-a', protectedRow.blobRef, 'original', w.albumKeyA))).toString(),
          'original secret bytes',
        );
        assert.equal(
          (await bytes(w.protected.getStream('protected-a', protectedRow.blobRef, 'thumb', w.albumKeyA))).toString(),
          'duplicate thumb',
        );
        assert.equal(w.ordinary.hasThumbs(duplicate.derivativeKey), false, 'committed variant derivatives are purged');
        if (keepSibling) {
          assert.equal(
            (await bytes(w.ordinary.getStream(w.contentHash, w.protectAuthority.libraryResolver!, PHOTO_ID))).toString(),
            'original secret bytes',
          );
          assert.equal(
            (await bytes(w.ordinary.getThumbStream(w.contentHash, 'thumb', w.protectAuthority.libraryResolver!, PHOTO_ID))).toString(),
            'thumb bytes',
          );
          assert.throws(
            () => w.service.prepareUnprotect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [duplicateId] }),
            /already contains content hash/u,
          );
        } else {
          const unprotectId = w.service.prepareUnprotect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [duplicateId] });
          await w.service.runToCompletion(unprotectId, { sourceAlbumKey: w.albumKeyA, targetLibraryKey: { id: 1, key: w.libraryKey } });
          const restored = w.photos.get(duplicateId)!;
          assert.deepEqual(revisions.snapshot(new Set([duplicateId])), savedHistory, 'every revision and head returns unchanged');
          assert.equal(restored.assetOwnerId, null, 'returned independent root owns its new envelope');
          assert.equal(await w.ordinary.verifyOriginal(w.contentHash, w.protectAuthority.libraryResolver!, duplicateId), true);
          assert.equal(
            (
              await bytes(w.ordinary.getThumbStream(restored.derivativeKey, 'mid', w.protectAuthority.libraryResolver!, duplicateId))
            ).toString(),
            'duplicate mid',
          );
        }
      } finally {
        w.db.close();
      }
    });
  }

  test('equal originals retain independent protected previews and can move between albums', async () => {
    const snapshots: string[][] = [];
    const w = await world((photoIds) => snapshots.push([...photoIds]));
    try {
      const id = 'duplicate-b';
      new VariantRepository(w.db).duplicate(w.photos.get(PHOTO_ID)!, id, '2026-09-20T12:00:00.000Z');
      const duplicate = w.photos.get(id)!;
      const revisions = new EditRevisionRepository(w.db);
      for (const [photoId, revisionId, turns] of [
        [PHOTO_ID, '01J8ED00000000000000000003', 1],
        [id, '01J8ED00000000000000000004', 2],
      ] as const) {
        revisions.append(photoId, {
          version: 1,
          id: revisionId,
          parentId: null,
          operations: [{ type: 'rotate', version: 1, quarterTurns: turns }],
          author: { product: 'overlook', version: 'test' },
          createdAt: '2026-09-20T12:00:00.000Z',
          importedFrom: null,
        });
      }
      const expectedRootHistory = revisions.snapshot(new Set([PHOTO_ID]));
      const expectedVariantHistory = revisions.snapshot(new Set([id]));
      for (const kind of ['thumb', 'mid'] as const) {
        await w.ordinary.putThumb(Readable.from(`second ${kind}`), { id: 1, key: w.libraryKey }, id, duplicate.derivativeKey, kind);
      }
      const migration = w.service.prepareProtect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [PHOTO_ID, id] });
      assert.deepEqual(snapshots, [[PHOTO_ID, id]], 'one history snapshot for the complete selection');
      await w.service.runToCompletion(migration, w.protectAuthority);
      const root = w.migrations.getProtected(PHOTO_ID)!;
      const variant = w.migrations.getProtected(id)!;
      assert.notEqual(root.blobRef, variant.blobRef);
      for (const [photoId, row, expected] of [
        [PHOTO_ID, root, expectedRootHistory],
        [id, variant, expectedVariantHistory],
      ] as const) {
        const metadata = openProtectedPhotoMetadata(
          { libraryId: LIBRARY_ID, albumId: 'protected-a', photoId },
          w.albumKeyA,
          row.sealedMetadata,
        );
        assert.deepEqual(
          metadata.version === 2 ? metadata.editRevisions : [],
          expected,
          'batched snapshot keeps each history with its owner',
        );
      }
      assert.equal((await bytes(w.protected.getStream('protected-a', root.blobRef, 'thumb', w.albumKeyA))).toString(), 'thumb bytes');
      assert.equal((await bytes(w.protected.getStream('protected-a', variant.blobRef, 'thumb', w.albumKeyA))).toString(), 'second thumb');
      const move = w.service.prepareMove({
        sourceAlbumId: 'protected-a',
        sourceAlbumKey: w.albumKeyA,
        targetAlbumId: 'protected-b',
        targetAlbumKey: w.albumKeyB,
        photoIds: [id],
      });
      await w.service.runToCompletion(move, { sourceAlbumKey: w.albumKeyA, targetAlbumKey: w.albumKeyB });
      const moved = w.migrations.getProtected(id)!;
      assert.equal((await bytes(w.protected.getStream('protected-b', moved.blobRef, 'mid', w.albumKeyB))).toString(), 'second mid');
      assert.equal((await bytes(w.protected.getStream('protected-a', root.blobRef, 'thumb', w.albumKeyA))).toString(), 'thumb bytes');
    } finally {
      w.db.close();
    }
  });

  test('protect retains shared ordinary blobs while another row owns the content hash', async () => {
    const w = await world();
    w.migrations.countOrdinaryBlobOwners = () => 1;
    const migrationId = w.service.prepareProtect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [PHOTO_ID] });
    await w.service.runToCompletion(migrationId, w.protectAuthority);
    assert.equal(w.ordinary.hasOriginal(w.contentHash), true);
    assert.equal(await w.ordinary.verifyThumbs(w.contentHash, w.protectAuthority.libraryResolver!, PHOTO_ID), true);
    w.db.close();
  });

  test('corrupt destination never purges the last verified source; authorized move changes domains', async () => {
    const w = await world();
    const protectId = w.service.prepareProtect({ albumId: 'protected-a', albumKey: w.albumKeyA, photoIds: [PHOTO_ID] });
    for (let step = 0; step < 4; step += 1) await w.service.advance(protectId, w.protectAuthority);
    const targetPath = await protectedOriginalPath(w.dataDir);
    const encrypted = await readFile(targetPath);
    encrypted[encrypted.length - 1] = (encrypted.at(-1) ?? 0) ^ 1;
    await writeFile(targetPath, encrypted);
    await assert.rejects(w.service.advance(protectId, w.protectAuthority), ProtectedPhotoMigrationServiceError);
    assert.equal(w.ordinary.hasOriginal(w.contentHash), true);
    w.db.close();

    const moved = await world();
    const first = moved.service.prepareProtect({ albumId: 'protected-a', albumKey: moved.albumKeyA, photoIds: [PHOTO_ID] });
    await moved.service.runToCompletion(first, moved.protectAuthority);
    const sourceRef = moved.migrations.getProtected(PHOTO_ID)!.blobRef;
    const moveId = moved.service.prepareMove({
      sourceAlbumId: 'protected-a',
      sourceAlbumKey: moved.albumKeyA,
      targetAlbumId: 'protected-b',
      targetAlbumKey: moved.albumKeyB,
      photoIds: [PHOTO_ID],
    });
    await moved.service.runToCompletion(moveId, { sourceAlbumKey: moved.albumKeyA, targetAlbumKey: moved.albumKeyB });
    const target = moved.migrations.getProtected(PHOTO_ID)!;
    assert.equal(target.albumId, 'protected-b');
    assert.notEqual(target.blobRef, sourceRef);
    assert.equal(await moved.protected.verify('protected-b', target.blobRef, 'original', moved.albumKeyB, moved.contentHash), true);
    moved.db.close();
  });

  test('batch unprotect preserves root ownership and chained variant lineage when root ID sorts after duplicates (#1430)', async () => {
    const w = await world();
    try {
      const rootId = 'photo-z';
      const childId = 'duplicate-b';
      const grandchildId = 'duplicate-a';
      const rootBytes = Buffer.from('root-z original bytes');
      const rootHash = createHash('sha256').update(rootBytes).digest('hex');
      await w.ordinary.putOriginal(Readable.from(rootBytes), { id: 1, key: w.libraryKey }, rootId);
      await w.ordinary.putThumb(Readable.from('root-z thumb'), { id: 1, key: w.libraryKey }, rootId, rootHash, 'thumb');
      await w.ordinary.putThumb(Readable.from('root-z mid'), { id: 1, key: w.libraryKey }, rootId, rootHash, 'mid');
      w.photos.insert({
        id: rootId,
        fileName: 'root-z.jpg',
        fileKind: 'jpeg',
        width: 20,
        height: 20,
        bytes: rootBytes.length,
        contentHash: rootHash,
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
        importSource: 'test',
        keyId: 1,
      });
      const variants = new VariantRepository(w.db);
      variants.duplicate(w.photos.get(rootId)!, childId, '2026-09-20T12:00:00.000Z');
      const childBefore = w.photos.get(childId)!;
      for (const kind of ['thumb', 'mid'] as const) {
        await w.ordinary.putThumb(Readable.from(`child ${kind}`), { id: 1, key: w.libraryKey }, childId, childBefore.derivativeKey, kind);
      }
      variants.duplicate(childBefore, grandchildId, '2026-09-20T12:01:00.000Z');
      const grandchildBefore = w.photos.get(grandchildId)!;
      for (const kind of ['thumb', 'mid'] as const) {
        await w.ordinary.putThumb(
          Readable.from(`grandchild ${kind}`),
          { id: 1, key: w.libraryKey },
          grandchildId,
          grandchildBefore.derivativeKey,
          kind,
        );
      }

      const protectId = w.service.prepareProtect({
        albumId: 'protected-a',
        albumKey: w.albumKeyA,
        photoIds: [grandchildId, childId, rootId],
      });
      await w.service.runToCompletion(protectId, w.protectAuthority);

      const unprotectId = w.service.prepareUnprotect({
        albumId: 'protected-a',
        albumKey: w.albumKeyA,
        photoIds: [grandchildId, childId, rootId],
      });
      await w.service.runToCompletion(unprotectId, {
        sourceAlbumKey: w.albumKeyA,
        targetLibraryKey: { id: 1, key: w.libraryKey },
        libraryResolver: w.protectAuthority.libraryResolver!,
      });

      const rootAfter = w.photos.get(rootId)!;
      const childAfter = w.photos.get(childId)!;
      const grandchildAfter = w.photos.get(grandchildId)!;
      assert.equal(rootAfter.variantSourceId, null);
      assert.equal(rootAfter.assetOwnerId, null);
      assert.equal(rootAfter.derivativeKey, rootHash);
      assert.equal(childAfter.variantSourceId, rootId);
      assert.equal(childAfter.assetOwnerId, rootId);
      assert.equal(childAfter.derivativeKey, childBefore.derivativeKey);
      assert.equal(grandchildAfter.variantSourceId, childId);
      assert.equal(grandchildAfter.assetOwnerId, rootId);
      assert.equal(grandchildAfter.derivativeKey, grandchildBefore.derivativeKey);
      const resolver = w.protectAuthority.libraryResolver!;
      assert.equal((await bytes(w.ordinary.getStream(rootHash, resolver, rootId))).toString(), 'root-z original bytes');
      assert.equal((await bytes(w.ordinary.getThumbStream(rootAfter.derivativeKey, 'thumb', resolver, rootId))).toString(), 'root-z thumb');
      assert.equal(
        (await bytes(w.ordinary.getThumbStream(childAfter.derivativeKey, 'thumb', resolver, childId))).toString(),
        'child thumb',
      );
      assert.equal(
        (await bytes(w.ordinary.getThumbStream(grandchildAfter.derivativeKey, 'mid', resolver, grandchildId))).toString(),
        'grandchild mid',
      );
    } finally {
      w.db.close();
    }
  });
});
