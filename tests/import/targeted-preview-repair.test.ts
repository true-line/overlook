import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

import { migrate } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { run } from '../../src/main/db/sql.js';
import { RawRepairService, type RawRepairServiceOptions } from '../../src/main/import/raw-repair-service.js';

function world(t: TestContext) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrate(db);
  run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-09-22')");
  const repo = new PhotosRepository(db);
  repo.insert({
    id: 'root',
    fileName: 'root.jpg',
    fileKind: 'jpeg',
    width: 60,
    height: 40,
    bytes: 42,
    contentHash: 'a'.repeat(64),
    keyId: 1,
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
    importedAt: '2026-09-22',
    importSource: 'test',
  });
  repo.setDimensionStatus('root', 'verified');
  const root = repo.get('root');
  assert.ok(root);
  new VariantRepository(db).duplicate(root, 'sibling', '2026-09-22');
  repo.clearPreviewRepairDebt('sibling');
  repo.setPreviewFailure('root', 'corrupt');
  repo.setPreviewFailure('sibling', 'corrupt');
  repo.setGalleryPolicy({ showUnavailable: false, minimumMegapixels: null });
  const regenerated: string[] = [];
  const plaintext: Buffer[] = [];
  const changes: { ids: readonly string[]; membership: string }[] = [];
  const options: RawRepairServiceOptions = {
    candidates: (hashes, ids) => repo.previewRepairCandidates(hashes, ids),
    isUnavailable: (id) => {
      const photo = repo.get(id);
      return photo !== undefined && (photo.previewFailure !== null || photo.dimensionStatus === 'unavailable');
    },
    validThumbs: () => Promise.resolve(true),
    loadOriginal: () => {
      const bytes = Buffer.from('authenticated original');
      plaintext.push(bytes);
      return Promise.resolve(bytes);
    },
    extractMetadata: () =>
      Promise.resolve({
        width: 60,
        height: 40,
        camera: null,
        lens: null,
        iso: null,
        aperture: null,
        shutter: null,
        focalLength: null,
        takenAt: null,
        gpsLat: null,
        gpsLon: null,
      }),
    regenerate: (photo) => {
      regenerated.push(photo.id);
      return Promise.resolve({ generated: true, width: 60, height: 40 });
    },
    repairMetadata: (id, metadata) => repo.repairPreviewMetadata(id, metadata),
    repairGeneratedDimensions: (id, width, height) => repo.repairGeneratedDimensions(id, width, height),
    setDimensionStatus: (id, status) => repo.setDimensionStatus(id, status),
    setPreviewFailure: (id, failure) => repo.setPreviewFailure(id, failure),
    clearPreviewRepairDebt: (id) => repo.clearPreviewRepairDebt(id),
    setPreviewMissing: (id, missing) => repo.setPreviewMissing(id, missing),
    changed: (ids, membership) => changes.push({ ids, membership }),
    yieldTurn: () => Promise.resolve(),
  };
  const service = (overrides: Partial<RawRepairServiceOptions> = {}) => {
    const repair = new RawRepairService({ ...options, ...overrides });
    t.after(() => repair.close());
    return repair;
  };
  return { db, repo, options, service, regenerated, plaintext, changes };
}

test('explicit JPEG preview repair selects one variant and refreshes Unavailable membership (#1098)', async (t) => {
  const w = world(t);
  assert.deepEqual(w.repo.previewRepairCandidates(), [], 'JPEG failures are outside the background RAW/legacy scan');
  assert.deepEqual(
    w.repo.previewRepairCandidates(undefined, []).map((photo) => photo.id),
    [],
  );
  await w.service().repairPhoto('root');
  assert.deepEqual(w.regenerated, ['root'], 'a shared original is not a request to repair every sibling');
  assert.equal(w.repo.get('root')?.previewFailure, null);
  assert.equal(w.repo.get('sibling')?.previewFailure, 'corrupt');
  assert.deepEqual(
    w.repo.page({ source: 'unavailable', limit: 10 }).photos.map((photo) => photo.id),
    ['sibling'],
  );
  assert.deepEqual(
    w.repo.page({ source: 'all', limit: 10 }).photos.map((photo) => photo.id),
    ['root'],
  );
  assert.deepEqual(w.changes, [{ ids: ['root'], membership: 'library' }]);
  assert.ok(w.plaintext.every((bytes) => bytes.equals(Buffer.alloc(bytes.length))));
});

test('explicit dimension retry decodes despite positive stale dimensions and valid previews (#1098)', async (t) => {
  const w = world(t);
  w.repo.setPreviewFailure('root', null);
  w.repo.setDimensionStatus('root', 'unavailable');
  await w.service().repairPhoto('root');
  assert.deepEqual(w.regenerated, ['root']);
  assert.equal(w.repo.get('root')?.dimensionStatus, 'verified');
  assert.deepEqual(w.changes, [{ ids: ['root'], membership: 'library' }]);
});

test('failed explicit preview generation retains a failure even when old previews authenticate (#1098)', async (t) => {
  const w = world(t);
  await w
    .service({ regenerate: () => Promise.resolve({ generated: false, width: null, height: null, failure: 'unsupported-codec' }) })
    .repairPhoto('root');
  assert.equal(w.repo.get('root')?.previewFailure, 'unsupported-codec');
  assert.equal(w.repo.get('root')?.dimensionStatus, 'unavailable');
  assert.ok(w.repo.page({ source: 'unavailable', limit: 10 }).photos.some((photo) => photo.id === 'root'));
});

test(
  'a photo retry queued during background work waits for that decode and then selects a fresh row (#1098)',
  { timeout: 5_000 },
  async (t) => {
    const w = world(t);
    w.repo.setDimensionStatus('root', 'legacy');
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0;
    const repair = w.service({
      regenerate: async (photo, bytes, signal) => {
        active += 1;
        assert.equal(active, 1, 'manual retry must share the sequential decode budget');
        try {
          if (photo.id === 'root') {
            entered();
            await held;
          }
          return await w.options.regenerate(photo, bytes, signal);
        } finally {
          active -= 1;
        }
      },
    });
    const background = repair.repair();
    await started;
    const requested = repair.repairPhoto('sibling');
    // The queued request must not capture the stale unavailable dimension state.
    w.repo.setDimensionStatus('sibling', 'unavailable');
    release();
    await Promise.all([background, requested]);
    assert.deepEqual(w.regenerated, ['root', 'sibling']);
    assert.equal(w.repo.get('sibling')?.dimensionStatus, 'verified');
    assert.equal(w.repo.get('sibling')?.previewFailure, null);
  },
);

for (const state of ['locked', 'offloaded', 'trashed', 'missing', 'closed'] as const) {
  test(`explicit repair does not decode a ${state} target (#1098)`, async (t) => {
    const w = world(t);
    if (state === 'offloaded') run(w.db, "UPDATE sync_ledger SET status = 'offloaded' WHERE photo_id = 'root'");
    if (state === 'trashed') w.repo.softDelete(['root']);
    const repair = w.service(
      state === 'locked'
        ? {
            candidates: (hashes, ids) => w.options.candidates(hashes, ids).map((photo) => ({ ...photo, locked: true })),
          }
        : {},
    );
    if (state === 'closed') repair.close();
    await repair.repairPhoto(state === 'missing' ? 'absent' : 'root');
    assert.deepEqual(w.regenerated, []);
    assert.deepEqual(w.plaintext, []);
    assert.equal(w.repo.get('root')?.previewFailure, 'corrupt');
  });
}

for (const kind of ['video', 'audio', 'other'] as const) {
  test(`explicit image repair leaves ${kind} media untouched (#1098)`, async (t) => {
    const w = world(t);
    run(w.db, "UPDATE photos SET file_kind = ?, width = 0, height = 0 WHERE id = 'root'", kind);
    w.repo.setDimensionStatus('root', 'unavailable');
    const before = w.repo.get('root');
    assert.deepEqual(w.repo.previewRepairCandidates(undefined, ['root']), []);
    await w.service({ validThumbs: () => Promise.resolve(false) }).repairPhoto('root');
    assert.deepEqual(w.plaintext, [], 'non-image originals must never be buffered by the image pipeline');
    assert.deepEqual(w.regenerated, []);
    assert.deepEqual(w.changes, []);
    assert.deepEqual(w.repo.get('root'), before, 'media placeholders retain their original availability state');
  });
}

for (const kind of ['jpeg', 'png', 'raw', 'heic', 'gif', 'webp'] as const) {
  test(`explicit image repair retains ${kind} eligibility (#1098)`, async (t) => {
    const w = world(t);
    run(w.db, "UPDATE photos SET file_kind = ? WHERE id = 'root'", kind);
    await w.service().repairPhoto('root');
    assert.deepEqual(w.regenerated, ['root']);
    assert.equal(w.repo.get('root')?.previewFailure, null);
  });
}
