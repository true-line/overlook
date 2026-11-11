import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';

import { ProtectedAlbumAuthorityError, ProtectedAlbumAuthorityRegistry } from '../../src/main/crypto/protected-album-authority.js';
import type { ProtectedLibraryService } from '../../src/main/library/protected-library-service.js';
import { ProtectedMediaService } from '../../src/main/library/protected-media-service.js';

describe('protected album session authority (#325)', () => {
  test('owns a key copy and zeroizes it on relock', () => {
    const registry = new ProtectedAlbumAuthorityRegistry();
    const callerKey = randomBytes(32);
    registry.authorize('ALBUM1', callerKey);
    callerKey.fill(0);

    let held: Buffer | undefined;
    registry.withAuthority('ALBUM1', (key) => {
      held = key;
    });
    assert.equal(registry.isAuthorized('ALBUM1'), true);
    assert.equal(registry.relock('ALBUM1'), true);
    assert.equal(registry.relock('ALBUM1'), false);
    assert.deepEqual(held, Buffer.alloc(32));
    assert.throws(() => registry.withAuthority('ALBUM1', () => undefined), ProtectedAlbumAuthorityError);
  });

  test('replacement and lifecycle close revoke every prior key', () => {
    const registry = new ProtectedAlbumAuthorityRegistry();
    registry.authorize('A', randomBytes(32));
    let first: Buffer | undefined;
    registry.withAuthority('A', (key) => {
      first = key;
    });
    registry.authorize('A', randomBytes(32));
    assert.deepEqual(first, Buffer.alloc(32));

    let replacement: Buffer | undefined;
    registry.withAuthority('A', (key) => {
      replacement = key;
    });
    registry.authorize('B', randomBytes(32));
    let second: Buffer | undefined;
    registry.withAuthority('B', (key) => {
      second = key;
    });
    registry.close();
    assert.deepEqual(replacement, Buffer.alloc(32));
    assert.deepEqual(second, Buffer.alloc(32));
    assert.equal(registry.isAuthorized('A'), false);
    assert.equal(registry.isAuthorized('B'), false);
  });

  test('rejects malformed identities and keys', () => {
    const registry = new ProtectedAlbumAuthorityRegistry();
    assert.throws(() => registry.authorize('', randomBytes(32)), /album id/);
    assert.throws(() => registry.authorize('A', randomBytes(16)), /32 bytes/);
  });

  test('snapshots and listeners revoke stale cache and in-flight generations independently', () => {
    const registry = new ProtectedAlbumAuthorityRegistry();
    const revoked: string[] = [];
    const off = registry.onRevoked((albumId) => revoked.push(albumId));
    registry.authorize('ALBUM1', Buffer.alloc(32, 1));
    registry.authorize('ALBUM2', Buffer.alloc(32, 2));
    const first = registry.snapshot('ALBUM1');
    const second = registry.snapshot('ALBUM2');
    assert.equal(
      registry.withSnapshot(first, (key) => key[0]),
      1,
    );

    registry.authorize('ALBUM1', Buffer.alloc(32, 3));
    assert.equal(registry.isCurrent(first), false);
    assert.equal(registry.isCurrent(second), true);
    assert.throws(() => registry.withSnapshot(first, () => undefined), ProtectedAlbumAuthorityError);
    assert.deepEqual(revoked, ['ALBUM1']);

    registry.relock('ALBUM2');
    assert.equal(registry.isCurrent(second), false);
    assert.deepEqual(revoked, ['ALBUM1', 'ALBUM2']);
    off();
  });

  test('relockAll bumps generations, notifies revocation listeners once per unlocked album, and evicts ProtectedMediaService RAM caches (#1432)', async () => {
    const authorities = new ProtectedAlbumAuthorityRegistry();
    const revoked: string[] = [];
    authorities.onRevoked((albumId) => {
      assert.equal(authorities.isAuthorized(albumId), false, 'key must already be cleared before revocation listeners fire');
      revoked.push(albumId);
    });
    authorities.authorize('ALBUM1', Buffer.alloc(32, 7));
    authorities.authorize('ALBUM2', Buffer.alloc(32, 8));
    const snap1 = authorities.snapshot('ALBUM1');
    const snap2 = authorities.snapshot('ALBUM2');

    const fakeLibrary: Pick<ProtectedLibraryService, 'isAuthorizedPhoto' | 'media'> = {
      isAuthorizedPhoto: (albumId) => authorities.isAuthorized(albumId),
      media: (albumId, photoId, kind) =>
        Promise.resolve({
          bytes: Buffer.alloc(kind === 'original' ? 2048 : 512, 0xaa),
          opaqueRef: `${albumId}:${photoId}:${kind}`,
          fileKind: 'jpeg',
        }),
    };
    const media = new ProtectedMediaService({
      // Fake satisfies the two methods ProtectedMediaService invokes.
      library: fakeLibrary as ProtectedLibraryService,
      authorities,
    });
    try {
      assert.notEqual(await media.getThumb('ALBUM1', 'PHOTO1', 'thumb'), null);
      assert.notEqual(await media.getFull('ALBUM2', 'PHOTO2'), null);
      assert.deepEqual(media.stats(), { thumbBytes: 512, fullBytes: 2048 });

      authorities.relockAll();

      assert.deepEqual(revoked, ['ALBUM1', 'ALBUM2']);
      assert.equal(authorities.isCurrent(snap1), false);
      assert.equal(authorities.isCurrent(snap2), false);
      assert.deepEqual(media.stats(), { thumbBytes: 0, fullBytes: 0 });

      authorities.relockAll();
      assert.deepEqual(revoked, ['ALBUM1', 'ALBUM2'], 'repeated relockAll with no unlocked albums is a no-op');

      authorities.authorize('ALBUM1', Buffer.alloc(32, 9));
      assert.equal(authorities.isCurrent(snap1), false, 're-authorizing after relockAll never revives a pre-lock snapshot');
      assert.notEqual(authorities.snapshot('ALBUM1').generation, snap1.generation);
    } finally {
      await media.close();
      authorities.close();
    }
  });
});
