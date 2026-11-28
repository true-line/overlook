import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { ProtectedBlobStore } from '../../src/main/blobs/protected-blob-store.js';
import { ProtectedAlbumAuthorityRegistry } from '../../src/main/crypto/protected-album-authority.js';
import { createProtectedAlbumCustody, type ProtectedAlbumMetadata } from '../../src/main/crypto/protected-album-credentials.js';
import { sealProtectedPhotoMetadata, type ProtectedPhotoMetadata } from '../../src/main/crypto/protected-photo-metadata.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { ProtectedAlbumRepository } from '../../src/main/db/protected-album-repository.js';
import { ProtectedPhotoMigrationRepository } from '../../src/main/db/protected-photo-migration-repository.js';
import { runNamed } from '../../src/main/db/sql.js';
import { createProtectedExportRuntime } from '../../src/main/export/protected-export-runtime.js';
import { handleFullRequest } from '../../src/main/fullres/full-response.js';
import { FullService } from '../../src/main/fullres/full-service.js';
import { ProtectedContentUnavailableError, ProtectedLibraryService } from '../../src/main/library/protected-library-service.js';
import { ProtectedMediaService } from '../../src/main/library/protected-media-service.js';
import { handleThumbRequest } from '../../src/main/thumbs/thumb-response.js';
import { ThumbService } from '../../src/main/thumbs/thumb-service.js';
import { protectedFullUrl } from '../../src/shared/library/full-url.js';
import { protectedThumbUrl } from '../../src/shared/library/thumb-url.js';

const LIBRARY_ID = 'library-a';
const PHOTO_ID = 'photo-a';
const NOW = '2026-07-16T12:00:00.000Z';

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-protected-library-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  const albums = new ProtectedAlbumRepository(db, LIBRARY_ID);
  const photos = new ProtectedPhotoMigrationRepository(db);
  const blobs = new ProtectedBlobStore(dataDir);
  await blobs.init();
  const authorities = new ProtectedAlbumAuthorityRegistry();
  const masterKey = randomBytes(32);
  const original = Buffer.from('private original bytes');
  const contentHash = createHash('sha256').update(original).digest('hex');
  const photoMetadata: ProtectedPhotoMetadata = {
    version: 1,
    photo: {
      id: PHOTO_ID,
      fileName: 'private-name.jpg',
      fileKind: 'jpeg',
      mediaInfo: null,
      width: 20,
      height: 10,
      bytes: original.length,
      contentHash,
      camera: 'private camera',
      lens: null,
      iso: 100,
      aperture: '2.8',
      shutter: '1/250',
      focalLength: 35,
      takenAt: NOW,
      gpsLat: 1,
      gpsLon: 2,
      place: 'private place',
      importedAt: NOW,
      importSource: 'test',
      favorite: true,
      deletedAt: null,
    },
    ordinaryMemberships: [],
  };

  const albumKeys = new Map<string, Buffer>();
  for (const [albumId, name, members] of [
    ['protected-a', 'Secret trip', [{ photoId: PHOTO_ID, position: 0, ordinaryMemberships: [] }]],
    ['protected-b', 'Other secret', []],
  ] as const) {
    const metadata: ProtectedAlbumMetadata = { version: 1, name, createdAt: NOW, position: 0, members };
    const custody = await createProtectedAlbumCustody({
      libraryId: LIBRARY_ID,
      albumId,
      password: 'correct horse battery staple',
      masterKey,
      metadata,
    });
    albumKeys.set(albumId, Buffer.from(custody.albumKey));
    albums.insertStaged({ albumId, credentialRecord: custody.credentialRecord, sealedMetadata: custody.sealedMetadata, now: NOW });
    assert.equal(albums.transition(albumId, 'staged', 'active', NOW), true);
    custody.albumKey.fill(0);
  }

  const albumKey = albumKeys.get('protected-a');
  assert.ok(albumKey);
  const blobRef = await blobs.putOriginal({
    albumId: 'protected-a',
    albumKey,
    contentHash,
    plaintext: Readable.from([original]),
  });
  await blobs.putDerivative({
    albumId: 'protected-a',
    albumKey,
    blobRef,
    kind: 'thumb',
    plaintext: Readable.from([Buffer.from('private thumb')]),
  });
  await blobs.putDerivative({
    albumId: 'protected-a',
    albumKey,
    blobRef,
    kind: 'mid',
    plaintext: Readable.from([Buffer.from('private preview')]),
  });
  runNamed(
    db,
    `INSERT INTO protected_photo_records (
       photo_id, album_id, record_version, blob_ref, sealed_metadata,
       has_thumb, has_mid, created_at, updated_at
     ) VALUES (@photoId, @albumId, 1, @blobRef, @sealedMetadata, 1, 1, @now, @now)`,
    {
      photoId: PHOTO_ID,
      albumId: 'protected-a',
      blobRef,
      sealedMetadata: sealProtectedPhotoMetadata(
        { libraryId: LIBRARY_ID, albumId: 'protected-a', photoId: PHOTO_ID },
        albumKey,
        photoMetadata,
      ),
      now: NOW,
    },
  );

  const service = new ProtectedLibraryService({ libraryId: LIBRARY_ID, albums, photos, blobs, authorities, now: () => NOW });
  return { db, albums, photos, blobs, authorities, albumKeys, service, original, contentHash };
}

function albumKey(worldState: Awaited<ReturnType<typeof world>>): Buffer {
  const key = worldState.albumKeys.get('protected-a');
  assert.ok(key);
  return key;
}

function unavailable(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ProtectedContentUnavailableError);
    assert.equal(error.message, 'protected content is unavailable');
    return true;
  });
}

describe('protected library authorization boundary (#327)', () => {
  test('locked listing exposes only stable opaque ids, generic labels, and authorization state', async () => {
    const w = await world();
    const listed = w.service.listOpaque();
    assert.deepEqual(listed, [
      { id: 'protected-a', label: 'Protected album', locked: true },
      { id: 'protected-b', label: 'Protected album', locked: true },
    ]);
    const serialized = JSON.stringify(listed);
    for (const secret of ['Secret trip', 'Other secret', 'private-name', 'private place', w.contentHash]) {
      assert.equal(serialized.includes(secret), false);
    }
    unavailable(() => w.service.summary('protected-a'));
    unavailable(() => w.service.get('protected-a', PHOTO_ID));
    unavailable(() => w.service.get('protected-b', PHOTO_ID));
    unavailable(() => w.service.get('missing', PHOTO_ID));
    await assert.rejects(w.service.media('protected-a', PHOTO_ID, 'thumb'), ProtectedContentUnavailableError);
    w.db.close();
  });

  test('one authorized route pages, searches, mutates, and reads only its own domain', async () => {
    const w = await world();
    w.authorities.authorize('protected-a', albumKey(w));
    assert.deepEqual(w.service.summary('protected-a'), {
      id: 'protected-a',
      name: 'Secret trip',
      count: 1,
      createdAt: NOW,
    });
    const page = w.service.page({ albumId: 'protected-a', limit: 10, query: 'private place' });
    assert.equal(page.photos.length, 1);
    assert.equal(page.photos[0]?.fileName, 'private-name.jpg');
    assert.equal('contentHash' in (page.photos[0] ?? {}), false, 'domain equality never crosses into the renderer contract');
    assert.equal(w.service.page({ albumId: 'protected-a', limit: 10, query: 'no match' }).photos.length, 0);
    unavailable(() => w.service.get('protected-b', PHOTO_ID));

    assert.deepEqual(w.service.toggleFavorite('protected-a', PHOTO_ID), { favorite: false });
    assert.equal(w.service.page({ albumId: 'protected-a', limit: 10, source: 'favorites' }).photos.length, 0);
    assert.deepEqual(w.service.softDelete('protected-a', [PHOTO_ID]), { deleted: 1 });
    assert.equal(w.service.page({ albumId: 'protected-a', limit: 10 }).photos.length, 0);
    assert.equal(w.service.page({ albumId: 'protected-a', limit: 10, source: 'deleted' }).photos.length, 1);
    assert.deepEqual(w.service.restore('protected-a', [PHOTO_ID]), { restored: 1 });

    const thumb = await w.service.media('protected-a', PHOTO_ID, 'thumb');
    assert.equal(thumb.bytes.toString(), 'private thumb');
    const original = await w.service.media('protected-a', PHOTO_ID, 'original');
    assert.deepEqual(original.bytes, w.original);
    w.db.close();
  });

  test('relock revokes a media read already in flight', async () => {
    const w = await world();
    w.authorities.authorize('protected-a', albumKey(w));
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedBlobs = {
      getStream: () =>
        Readable.from(
          (async function* () {
            started?.();
            await gate;
            yield Buffer.from('late plaintext');
          })(),
        ),
    } as unknown as ProtectedBlobStore;
    const service = new ProtectedLibraryService({
      libraryId: LIBRARY_ID,
      albums: w.albums,
      photos: w.photos,
      blobs: delayedBlobs,
      authorities: w.authorities,
    });
    const pending = service.media('protected-a', PHOTO_ID, 'original');
    await entered;
    w.authorities.relock('protected-a');
    release?.();
    await assert.rejects(pending, ProtectedContentUnavailableError);
    w.db.close();
  });

  test('domain-scoped protocol URLs revoke cached thumbnails, previews, full reads, and prefetches on relock', async () => {
    const w = await world();
    w.authorities.authorize('protected-a', albumKey(w));
    const media = new ProtectedMediaService({ library: w.service, authorities: w.authorities });
    assert.equal((await media.getThumb('protected-a', PHOTO_ID, 'thumb'))?.bytes.toString(), 'private thumb');
    assert.deepEqual((await media.getFull('protected-a', PHOTO_ID))?.bytes, w.original);
    assert.ok(media.stats().thumbBytes > 0);
    assert.ok(media.stats().fullBytes > 0);

    const ordinaryThumb = new ThumbService({ loadThumb: () => Promise.resolve(null) });
    const ordinaryFull = new FullService({ loadOriginal: () => Promise.resolve(null) });
    const thumbResponse = await handleThumbRequest(
      () => ordinaryThumb,
      () => undefined,
      new Request(protectedThumbUrl('protected-a', PHOTO_ID)),
      () => media,
    );
    assert.equal(thumbResponse.status, 200);
    assert.equal(thumbResponse.headers.get('cache-control'), 'no-store');
    const fullResponse = await handleFullRequest(
      () => ordinaryFull,
      () => undefined,
      new Request(protectedFullUrl('protected-a', PHOTO_ID)),
      () => media,
    );
    assert.equal(fullResponse.status, 200);
    assert.equal(fullResponse.headers.get('cache-control'), 'no-store');

    w.authorities.relock('protected-a');
    assert.deepEqual(media.stats(), { thumbBytes: 0, fullBytes: 0 });
    assert.equal(
      (
        await handleThumbRequest(
          () => ordinaryThumb,
          () => undefined,
          new Request(protectedThumbUrl('protected-a', PHOTO_ID)),
          () => media,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await handleFullRequest(
          () => ordinaryFull,
          () => undefined,
          new Request(protectedFullUrl('protected-a', PHOTO_ID)),
          () => media,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await handleFullRequest(
          () => ordinaryFull,
          () => undefined,
          new Request(protectedFullUrl('protected-a', PHOTO_ID, { prefetch: true })),
          () => media,
        )
      ).status,
      404,
      'stale prefetch URLs fail closed after relock',
    );
    assert.deepEqual(media.stats(), { thumbBytes: 0, fullBytes: 0 });
    await media.close();
    await Promise.all([ordinaryThumb.close(), ordinaryFull.close()]);
    w.db.close();
  });

  test('protected export requires live album authority and redacts failures', async () => {
    const w = await world();
    const destination = mkdtempSync(join(tmpdir(), 'overlook-protected-export-'));
    let failures = 0;
    const runtime = createProtectedExportRuntime({
      library: w.service,
      progress: () => undefined,
      pickDestination: () => Promise.resolve(destination),
      failure: () => {
        failures += 1;
      },
    });
    w.authorities.authorize('protected-a', albumKey(w));
    const exported = await runtime.run('protected-a', [PHOTO_ID], destination, 'original');
    assert.deepEqual(exported, { exported: 1, failed: 0, cancelled: 0, previewTranscodes: 0 });
    assert.deepEqual(await readFile(join(destination, 'private-name.jpg')), w.original);

    w.authorities.relock('protected-a');
    const denied = await runtime.run('protected-a', [PHOTO_ID], destination, 'original');
    assert.deepEqual(denied, { exported: 0, failed: 1, cancelled: 0, previewTranscodes: 0 });
    assert.equal(failures, 1, 'failure sink receives no protected filename, id, hash, or error text');
    runtime.close();
    await runtime.drain();
    w.db.close();
  });

  test('relock during protected export destroys the stream and removes the partial plaintext file', async () => {
    const w = await world();
    w.authorities.authorize('protected-a', albumKey(w));
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedBlobs = {
      getStream: () =>
        Readable.from(
          (async function* () {
            yield Buffer.from('partial');
            started?.();
            await gate;
            yield Buffer.from('late plaintext');
          })(),
        ),
    } as unknown as ProtectedBlobStore;
    const service = new ProtectedLibraryService({
      libraryId: LIBRARY_ID,
      albums: w.albums,
      photos: w.photos,
      blobs: delayedBlobs,
      authorities: w.authorities,
    });
    const destination = mkdtempSync(join(tmpdir(), 'overlook-protected-export-revoke-'));
    const runtime = createProtectedExportRuntime({
      library: service,
      progress: () => undefined,
      pickDestination: () => Promise.resolve(destination),
    });
    const pending = runtime.run('protected-a', [PHOTO_ID], destination, 'original');
    await entered;
    w.authorities.relock('protected-a');
    release?.();
    assert.deepEqual(await pending, { exported: 0, failed: 1, cancelled: 0, previewTranscodes: 0 });
    assert.deepEqual(await readdir(destination), []);
    runtime.close();
    await runtime.drain();
    w.db.close();
  });

  test('cancel interrupts a protected original read and releases exactly once (#1217)', async (t) => {
    const w = await world();
    w.authorities.authorize('protected-a', albumKey(w));
    const stalled = new PassThrough();
    stalled.write('partial');
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let releases = 0;
    let failures = 0;
    const original = w.service.openOriginal.bind(w.service);
    t.mock.method(w.service, 'openOriginal', (albumId: string, photoId: string) => {
      const opened = original(albumId, photoId);
      opened.stream.destroy();
      entered?.();
      return {
        ...opened,
        stream: stalled,
        release: async () => {
          releases += 1;
          await opened.release();
        },
      };
    });
    const destination = mkdtempSync(join(tmpdir(), 'overlook-protected-export-cancel-'));
    const runtime = createProtectedExportRuntime({
      library: w.service,
      progress: () => undefined,
      pickDestination: () => Promise.resolve(destination),
      failure: () => {
        failures += 1;
      },
    });
    const pending = runtime.run('protected-a', [PHOTO_ID], destination);
    await started;
    runtime.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('protected cancellation waited for the stalled source')), 1_000);
        }),
      ]);
      assert.deepEqual(result, { exported: 0, failed: 0, cancelled: 1, previewTranscodes: 0 });
      await runtime.drain();
      assert.deepEqual(await readdir(destination), []);
      assert.equal(stalled.destroyed, true);
      assert.equal(releases, 1);
      assert.equal(failures, 0);
    } finally {
      clearTimeout(timer);
      stalled.end();
      await pending;
      runtime.close();
      await runtime.drain();
      w.db.close();
    }
  });
});
