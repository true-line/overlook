import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import {
  authoredMetadataXmp,
  ExportEngine,
  ExportPreflightError,
  writeFileCleanly,
  type ExportEngineDeps,
} from '../../src/main/export/export-engine.js';
import { parseEditsXmp } from '../../src/main/export/edit-xmp.js';
import { compileDisclosurePlan, DEFAULT_DISCLOSURE_POLICY } from '../../src/shared/disclosure/policy.js';
import { transcodeToJpeg } from '../../src/main/export/transcode.js';
import type { EditRevisionView } from '../../src/main/db/edit-revision-repository.js';
import { IDENTITY_TRANSFORM, type EditTransform } from '../../src/shared/library/edit-revision.js';
import sharp from 'sharp';

import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

// #97 exit criteria against real components: seeded photos through the real
// encrypted store → byte-identical files on disk, ordered progress,
// cancellation keeping completed files only.

function fullRow(
  id: string,
  fileName: string,
  contentHash: string,
  bytes: number,
  fileKind: PhotoRecord['fileKind'] = 'jpeg',
): PhotoRecord {
  return {
    id,
    fileName,
    fileKind,
    mediaInfo: null,
    width: 1,
    height: 1,
    bytes,
    contentHash,
    derivativeKey: contentHash,
    variantSourceId: null,
    assetOwnerId: null,
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
    importedAt: '2026-07-13T00:00:00.000Z',
    importSource: 'test',
    favorite: false,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    syncState: 'local',
    coverage: 'included',
    locked: false,
    title: null,
    description: null,
    tags: [],
    userTags: [],
    importedKeywords: [],
    suppressedKeywords: [],
    metadataVersion: 1,
  };
}

async function seededWorld(count: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-export-'));
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const rows = new Map<string, PhotoRecord>();
  const bytesById = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    const bytes = sampleJpeg(index);
    const id = `PHOTO${String(index)}`;
    const ref = await store.putOriginal(Readable.from([bytes]), key, id);
    rows.set(id, fullRow(id, `IMG_${String(4021 + index)}.JPG`, ref.contentHash, bytes.length));
    bytesById.set(id, bytes);
  }
  const destination = mkdtempSync(join(tmpdir(), 'overlook-export-dest-'));
  const progress: [number, number][] = [];
  const deps: ExportEngineDeps = {
    repo: { get: (id) => rows.get(id) },
    blobs: store,
    resolveKey: () => key.key,
    writeFile: writeFileCleanly,
    exists: async (filePath) =>
      access(filePath).then(
        () => true,
        () => false,
      ),
    freeBytes: async (dir) => {
      const stats = await statfs(dir);
      return stats.bavail * stats.bsize;
    },
    joinPath: (dir, name) => join(dir, name),
    transcodeJpeg: transcodeToJpeg,
    bufferStream: async (stream) => {
      const chunks: Buffer[] = [];
      // type-coverage:ignore-next-line -- Readable yields untyped chunks
      for await (const chunk of stream) {
        // type-coverage:ignore-next-line -- Readable yields untyped chunks
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    },
    events: {
      progress: (done, total) => progress.push([done, total]),
    },
  };
  return { deps, destination, rows, bytesById, progress, key, store, engine: new ExportEngine(deps) };
}

describe('export engine (#97)', () => {
  test('EXIT CRITERIA: N seeded photos → N byte-identical files; progress ordered', async () => {
    const world = await seededWorld(4);
    const summary = await world.engine.exportPhotos([...world.rows.keys()], world.destination);
    assert.deepEqual(
      { exported: summary.exported, failed: summary.failed, cancelled: summary.cancelled },
      { exported: 4, failed: 0, cancelled: 0 },
    );
    for (const [id, row] of world.rows) {
      const onDisk = readFileSync(join(world.destination, row.fileName));
      assert.deepEqual(onDisk, world.bytesById.get(id), `${row.fileName} byte-identical to source`);
    }
    assert.deepEqual(
      world.progress,
      [
        [1, 4],
        [2, 4],
        [3, 4],
        [4, 4],
      ],
      'progress stream is ordered n/total',
    );
  });

  test('offloaded originals export from policy-aware temporary custody and release it (#306)', async () => {
    const world = await seededWorld(1);
    const row = world.rows.get('PHOTO0');
    assert.notEqual(row, undefined);
    if (row !== undefined) world.rows.set(row.id, { ...row, syncState: 'offloaded' });
    let released = 0;
    const engine = new ExportEngine({
      ...world.deps,
      openOriginal: (photo) =>
        Promise.resolve({
          stream: Readable.from([world.bytesById.get(photo.id) ?? Buffer.alloc(0)]),
          release: () => {
            released += 1;
            return Promise.resolve();
          },
        }),
    });

    const summary = await engine.exportPhotos(['PHOTO0'], world.destination);
    assert.equal(summary.exported, 1);
    assert.deepEqual(readFileSync(join(world.destination, row?.fileName ?? '')), world.bytesById.get('PHOTO0'));
    assert.equal(released, 1, 'temporary encrypted custody releases after the destination write');
    assert.equal(world.rows.get('PHOTO0')?.syncState, 'offloaded');
  });

  test('collisions get a recorded numbered suffix — existing files never clobbered', async () => {
    const world = await seededWorld(1);
    const row = [...world.rows.values()][0];
    writeFileSync(join(world.destination, row?.fileName ?? ''), Buffer.from('already here'));
    const summary = await world.engine.exportPhotos([...world.rows.keys()], world.destination);
    assert.equal(summary.exported, 1);
    assert.equal(summary.files[0]?.renamed, true);
    assert.equal(summary.files[0]?.fileName, 'IMG_4021 (1).JPG');
    assert.equal(readFileSync(join(world.destination, row?.fileName ?? '')).toString(), 'already here');
  });

  test('EXIT CRITERIA: cancellation finishes the current file and keeps completed only', async () => {
    const world = await seededWorld(4);
    const controller = new AbortController();
    const deps: ExportEngineDeps = {
      ...world.deps,
      events: {
        progress: (done, total) => {
          world.progress.push([done, total]);
          if (done === 2) {
            controller.abort(); // Cancel clicked mid-batch
          }
        },
      },
    };
    const summary = await new ExportEngine(deps).exportPhotos([...world.rows.keys()], world.destination, controller.signal);
    assert.deepEqual({ exported: summary.exported, cancelled: summary.cancelled }, { exported: 2, cancelled: 2 });
    assert.equal(readdirSync(world.destination).length, 2, 'completed files only — no partials');
  });

  for (const mode of ['original', 'baked', 'original-sidecars'] as const) {
    test(`${mode} refuses mixed and all-locked batches before content or destination work`, async () => {
      const world = await seededWorld(2);
      const locked = world.rows.get('PHOTO1');
      assert.ok(locked);
      world.rows.set(locked.id, { ...locked, locked: true });
      const unexpected = (): never => {
        throw new Error('export crossed the locked-photo preflight');
      };
      const engine = new ExportEngine({
        ...world.deps,
        disclosure: unexpected,
        blobs: { getStream: unexpected },
        openOriginal: unexpected,
        sidecarsFor: unexpected,
        sidecarStream: unexpected,
        editHead: unexpected,
        freeBytes: unexpected,
        exists: unexpected,
        writeFile: unexpected,
        bufferStream: unexpected,
        transcodeJpeg: unexpected,
      });
      for (const ids of [['PHOTO0', 'PHOTO1'], ['PHOTO1']]) {
        await assert.rejects(
          engine.exportPhotos(ids, world.destination, undefined, 'original', 'original', { mode }),
          (error: unknown) => error instanceof ExportPreflightError && /Locked photos.*missing encryption keys/u.test(error.message),
        );
      }
      assert.deepEqual(world.progress, []);
      assert.deepEqual(readdirSync(world.destination), []);
      world.rows.set(locked.id, locked);
      const result = await world.engine.exportPhotos(['PHOTO0', 'PHOTO1'], world.destination, undefined, 'original', 'original', { mode });
      assert.equal(result.exported, 2, 'restored key availability permits a fresh export');
      assert.equal(result.failed, 0);
    });
  }

  test('missing companion key refuses the entire batch before writing; importing it permits retry', async () => {
    const world = await seededWorld(2);
    const companionKey = { id: 2, key: randomBytes(32) };
    const bytes = Buffer.from('encrypted companion');
    const ref = await world.store.putSidecar(Readable.from([bytes]), companionKey, 'PHOTO1');
    let imported = false;
    const resolveKey = (id: number): Buffer | undefined => (id === 1 ? world.key.key : imported ? companionKey.key : undefined);
    const engine = new ExportEngine({
      ...world.deps,
      resolveKey,
      sidecarsFor: (id) =>
        id === 'PHOTO1' ? [{ fileName: 'IMG_4022.xmp', contentHash: ref.contentHash, keyId: 2, bytes: bytes.length }] : [],
      sidecarStream: (id, hash) => world.store.getSidecarStream(id, hash, resolveKey),
      openOriginal: (photo) => {
        assert.ok(imported, 'no original is opened before the entire batch passes preflight');
        return Promise.resolve({ stream: world.store.getStream(photo.contentHash, resolveKey, photo.id) });
      },
    });
    await assert.rejects(
      engine.exportPhotos(['PHOTO0', 'PHOTO1'], world.destination),
      (error: unknown) => error instanceof ExportPreflightError && /Locked companion files/u.test(error.message),
    );
    assert.deepEqual(world.progress, []);
    assert.deepEqual(readdirSync(world.destination), []);
    imported = true;
    const result = await engine.exportPhotos(['PHOTO0', 'PHOTO1'], world.destination);
    assert.equal(result.exported, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.sidecarsExported, 1);
    assert.deepEqual(readFileSync(join(world.destination, 'IMG_4022.xmp')), bytes);
  });

  test('missing companion keys do not block modes that omit the encrypted companion', async () => {
    for (const [mode, metadata] of [
      ['original', 'original'],
      ['baked', 'original'],
      ['original-sidecars', 'none'],
      ['original-sidecars', 'overlook'],
    ] as const) {
      const world = await seededWorld(1);
      const engine = new ExportEngine({
        ...world.deps,
        resolveKey: (id) => (id === 1 ? world.key.key : undefined),
        sidecarsFor: () => [{ fileName: 'IMG_4021.xmp', contentHash: 'a'.repeat(64), keyId: 2, bytes: 12 }],
        sidecarStream: () => {
          throw new Error('excluded companion must not be opened');
        },
      });
      const result = await engine.exportPhotos(['PHOTO0'], world.destination, undefined, 'original', metadata, { mode });
      assert.equal(result.exported, 1);
      assert.equal(result.failed, 0);
    }
  });

  test('free-space preflight fails BEFORE any bytes move', async () => {
    const world = await seededWorld(2);
    const deps: ExportEngineDeps = { ...world.deps, freeBytes: async () => Promise.resolve(10) };
    await assert.rejects(new ExportEngine(deps).exportPhotos([...world.rows.keys()], world.destination), ExportPreflightError);
    assert.equal(readdirSync(world.destination).length, 0);
  });

  test('a mid-write failure leaves NO partial file (PR #194 review)', async () => {
    const world = await seededWorld(2);
    let call = 0;
    const deps: ExportEngineDeps = {
      ...world.deps,
      // First file's decrypt stream dies mid-flight: an errored Readable.
      blobs: {
        getStream: (contentHash, resolveKey, photoId) => {
          call += 1;
          if (call === 1) {
            const dead = new Readable({
              read() {
                this.destroy(new Error('device error mid-decrypt'));
              },
            });
            return dead;
          }
          return world.deps.blobs.getStream(contentHash, resolveKey, photoId);
        },
      },
    };
    const summary = await new ExportEngine(deps).exportPhotos([...world.rows.keys()], world.destination);
    assert.deepEqual({ exported: summary.exported, failed: summary.failed }, { exported: 1, failed: 1 });
    // The failed file was cleaned up — only the good one remains.
    assert.deepEqual(readdirSync(world.destination), ['IMG_4022.JPG']);
  });

  test('a missing photo fails that entry; the batch continues', async () => {
    const world = await seededWorld(1);
    const summary = await world.engine.exportPhotos(['GHOST', ...world.rows.keys()], world.destination);
    assert.deepEqual({ exported: summary.exported, failed: summary.failed }, { exported: 1, failed: 1 });
    assert.deepEqual(summary.failures, [{ photoId: 'GHOST', fileName: 'GHOST', reason: 'photo GHOST is not in the library' }]);
  });

  test('an original-access failure can attach exact custody truth without replacing the diagnostic (#734)', async () => {
    const world = await seededWorld(1);
    const status = {
      state: 'disconnected' as const,
      providerId: 'pcloud' as const,
      providerLabel: 'pCloud',
      accountLabel: 'owner@example.test',
    };
    const engine = new ExportEngine({
      ...world.deps,
      openOriginal: () => Promise.reject(new Error('provider is disconnected')),
      custodyStatus: (photoId, error) => {
        assert.equal(photoId, 'PHOTO0');
        assert.match(error instanceof Error ? error.message : '', /disconnected/u);
        return Promise.resolve(status);
      },
    });

    const summary = await engine.exportPhotos(['PHOTO0'], world.destination);
    assert.deepEqual(summary.failures, [
      {
        photoId: 'PHOTO0',
        fileName: 'IMG_4021.JPG',
        reason: 'provider is disconnected',
        custody: status,
      },
    ]);
  });

  test('metadata export writes authored XMP by choice or omits all sidecars for privacy (#508)', async () => {
    const authored = await seededWorld(1);
    const current = authored.rows.get('PHOTO0');
    assert.notEqual(current, undefined);
    if (current !== undefined) {
      authored.rows.set(current.id, {
        ...current,
        title: 'Night & light',
        description: 'A <private> note',
        tags: ['Portfolio', 'Travel'],
      });
    }
    const summary = await authored.engine.exportPhotos(['PHOTO0'], authored.destination, undefined, 'original', 'overlook');
    assert.deepEqual(summary.files[0]?.sidecarNames, ['IMG_4021.xmp']);
    const xmp = readFileSync(join(authored.destination, 'IMG_4021.xmp'), 'utf8');
    assert.match(xmp, /Night &amp; light/u);
    assert.match(xmp, /A &lt;private&gt; note/u);
    assert.match(xmp, /<rdf:li>Portfolio<\/rdf:li>/u);
    assert.deepEqual(authoredMetadataXmp(authored.rows.get('PHOTO0')!), Buffer.from(xmp));

    const privateExport = await seededWorld(1);
    const engine = new ExportEngine({
      ...privateExport.deps,
      sidecarsFor: () => [{ fileName: 'IMG_4021.xmp', contentHash: 'a'.repeat(64), keyId: 1, bytes: 12 }],
      sidecarStream: () => Readable.from(['source sidecar']),
    });
    const privateSummary = await engine.exportPhotos(['PHOTO0'], privateExport.destination, undefined, 'original', 'none');
    assert.deepEqual(privateSummary.files[0]?.sidecarNames, []);
    assert.deepEqual(readdirSync(privateExport.destination), ['IMG_4021.JPG']);
  });
});

describe('jpeg transcode export (#98)', () => {
  const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/exif');

  test('EXIT CRITERIA: a RAF exports as a decodable JPEG from its embedded preview', async () => {
    const world = await seededWorld(0);
    const raf = readFileSync(join(FIXTURES, 'sample.raf'));
    const id = 'RAFPHOTO';
    const ref = await world.store.putOriginal(Readable.from([raf]), world.key, id);
    world.rows.set(id, fullRow(id, 'IMG_4021.RAF', ref.contentHash, raf.length, 'raw'));

    const summary = await world.engine.exportPhotos([id], world.destination, undefined, 'jpeg');
    assert.deepEqual({ exported: summary.exported, previewTranscodes: summary.previewTranscodes }, { exported: 1, previewTranscodes: 1 });
    assert.equal(summary.files[0]?.fileName, 'IMG_4021.jpg', 'RAW re-extensions to .jpg');
    const onDisk = readFileSync(join(world.destination, 'IMG_4021.jpg'));
    assert.equal(onDisk[0], 0xff);
    assert.equal(onDisk[1], 0xd8, 'JPEG SOI — opens in OS viewers');
  });

  test('EXIF policy: transcode STRIPS metadata (camera identity and GPS never travel)', async () => {
    const world = await seededWorld(0);
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    const id = 'EXIFPHOTO';
    const ref = await world.store.putOriginal(Readable.from([jpeg]), world.key, id);
    world.rows.set(id, fullRow(id, 'IMG_4028.JPG', ref.contentHash, jpeg.length));

    const summary = await world.engine.exportPhotos([id], world.destination, undefined, 'jpeg');
    assert.equal(summary.exported, 1);
    assert.equal(summary.previewTranscodes, 0, 'a plain JPEG is not preview-capped');
    const onDisk = readFileSync(join(world.destination, 'IMG_4028.jpg'));
    assert.ok(jpeg.includes(Buffer.from('FUJIFILM', 'ascii')), 'source carries the make');
    assert.equal(onDisk.includes(Buffer.from('FUJIFILM', 'ascii')), false, 'transcode must not');
    assert.equal(onDisk.includes(Buffer.from('Exif', 'ascii')), false);
  });

  test('a v1-unrenderable RAW (no RAF preview) fails honestly; batch continues (PR #195 review)', async () => {
    const world = await seededWorld(1);
    const junk = Buffer.from(Array.from({ length: 256 }, (_, index) => (index * 131 + 7) % 256)); // an "ARW" container
    const id = 'ARWPHOTO';
    const ref = await world.store.putOriginal(Readable.from([junk]), world.key, id);
    world.rows.set(id, fullRow(id, 'IMG_9000.ARW', ref.contentHash, junk.length, 'raw'));

    const summary = await world.engine.exportPhotos([...world.rows.keys()], world.destination, undefined, 'jpeg');
    assert.deepEqual({ exported: summary.exported, failed: summary.failed }, { exported: 1, failed: 1 });
    assert.equal(readdirSync(world.destination).length, 1, 'no partial or bogus file for the failed RAW');
  });

  test('original format still streams byte-identical (transcode path not entangled)', async () => {
    const world = await seededWorld(1);
    const summary = await world.engine.exportPhotos([...world.rows.keys()], world.destination, undefined, 'original');
    assert.equal(summary.exported, 1);
    assert.equal(summary.previewTranscodes, 0);
    const row = [...world.rows.values()][0];
    assert.deepEqual(readFileSync(join(world.destination, row?.fileName ?? '')), world.bytesById.get(row?.id ?? ''));
  });
});

describe('gif/webp export (ADR-0026 §4, #547)', () => {
  const ANIMATED = join(import.meta.dirname, '../../../tests/fixtures/animated');

  test('JPEG transcode renders the first frame of animated media', async () => {
    for (const file of ['animated.gif', 'animated.webp', 'static.webp']) {
      const bytes = readFileSync(join(ANIMATED, file));
      const { jpeg, fromPreview } = await transcodeToJpeg(bytes, file.endsWith('.gif') ? 'gif' : 'webp');
      assert.equal(fromPreview, false, file);
      assert.equal(jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), true, `${file} produced a JPEG`);
    }
  });
});

// #497 / ADR-0031 §6: one declared payload mode. Bake renders the head
// transform into the pixels; Original + sidecars ships the byte-identical
// original with an XMP naming the edits; Original only ships nothing beside
// it. The preflight names what a mode cannot carry.
describe('edited export (#497, ADR-0031 §6)', () => {
  const ROTATED: EditTransform = { quarterTurns: 1, flipped: false, crop: null };
  const head = (transform: EditTransform, unsupported: string | null = null): EditRevisionView => ({
    id: '01J8EDT000000000000000000A',
    parentId: null,
    createdAt: '2026-09-02T10:00:00.000Z',
    operations: [],
    transform,
    unsupported,
  });
  const dims = async (bytes: Buffer): Promise<[number, number]> => {
    const meta = await sharp(bytes).metadata();
    return [meta.width ?? 0, meta.height ?? 0];
  };

  test('Bake renders the head transform at the chosen quality; an unedited photo bakes as plain JPEG', async () => {
    const world = await seededWorld(2);
    const engine = new ExportEngine({ ...world.deps, editHead: (id) => (id === 'PHOTO0' ? head(ROTATED) : null) });
    const summary = await engine.exportPhotos(['PHOTO0', 'PHOTO1'], world.destination, undefined, 'original', 'original', {
      mode: 'baked',
      quality: 80,
    });
    assert.deepEqual(
      { exported: summary.exported, bakedEdits: summary.bakedEdits, editSidecars: summary.editSidecars },
      { exported: 2, bakedEdits: 1, editSidecars: 0 },
    );
    const [sourceWidth, sourceHeight] = await dims(world.bytesById.get('PHOTO0') ?? Buffer.alloc(0));
    assert.deepEqual(
      await dims(readFileSync(join(world.destination, 'IMG_4021.jpg'))),
      [sourceHeight, sourceWidth],
      'a quarter turn swaps the edges',
    );
    assert.deepEqual(
      await dims(readFileSync(join(world.destination, 'IMG_4022.jpg'))),
      await dims(world.bytesById.get('PHOTO1') ?? Buffer.alloc(0)),
    );
    assert.deepEqual(readdirSync(world.destination).sort(), ['IMG_4021.jpg', 'IMG_4022.jpg'], 'no sidecars beside a bake');
  });

  test('Original + XMP ships the byte-identical original beside a sidecar that reads back as the head transform', async () => {
    const world = await seededWorld(1);
    const engine = new ExportEngine({ ...world.deps, editHead: () => head(ROTATED) });
    const summary = await engine.exportPhotos(['PHOTO0'], world.destination, undefined, 'original', 'none', { mode: 'original-sidecars' });
    assert.deepEqual(
      { exported: summary.exported, editSidecars: summary.editSidecars, bakedEdits: summary.bakedEdits },
      { exported: 1, editSidecars: 1, bakedEdits: 0 },
    );
    assert.deepEqual(readFileSync(join(world.destination, 'IMG_4021.JPG')), world.bytesById.get('PHOTO0'));
    const xmp = readFileSync(join(world.destination, 'IMG_4021.xmp'), 'utf8');
    assert.deepEqual(parseEditsXmp(xmp), ROTATED, 'the reviewed reader returns what the writer meant');
    assert.equal(xmp.includes('<dc:'), false, 'Metadata: None adds no authored fields');
  });

  test('the generated packet keeps the canonical stem; a retained XMP companion is preserved under the suffix', async () => {
    const world = await seededWorld(1);
    const engine = new ExportEngine({
      ...world.deps,
      editHead: () => head(ROTATED),
      sidecarsFor: () => [{ fileName: 'IMG_4021.xmp', contentHash: 'a'.repeat(64), keyId: 1, bytes: 14 }],
      sidecarStream: () => Readable.from(['source sidecar']),
    });
    const summary = await engine.exportPhotos(['PHOTO0'], world.destination, undefined, 'original', 'original', {
      mode: 'original-sidecars',
    });
    assert.deepEqual(summary.files[0]?.sidecarNames, ['IMG_4021.xmp', 'IMG_4021 (1).xmp']);
    assert.deepEqual(parseEditsXmp(readFileSync(join(world.destination, 'IMG_4021.xmp'), 'utf8')), ROTATED, 'the stem carries the edits');
    assert.equal(readFileSync(join(world.destination, 'IMG_4021 (1).xmp'), 'utf8'), 'source sidecar', 'the companion is not lost');
    // Without edits to carry, the companion keeps the stem as before.
    const plain = new ExportEngine({
      ...world.deps,
      sidecarsFor: () => [{ fileName: 'IMG_4021.xmp', contentHash: 'a'.repeat(64), keyId: 1, bytes: 14 }],
      sidecarStream: () => Readable.from(['source sidecar']),
    });
    const other = await seededWorld(1);
    const untouched = await plain.exportPhotos(['PHOTO0'], other.destination, undefined, 'original', 'original', {
      mode: 'original-sidecars',
    });
    assert.deepEqual(untouched.files[0]?.sidecarNames, ['IMG_4021.xmp']);
    // Metadata: Edits ('overlook') writes the disclosure-projected XMP + edits
    // and never copies unfiltered source companions (#1142, #1438).
    const editsOnlyWorld = await seededWorld(1);
    const editsOnly = await engine.exportPhotos(['PHOTO0'], editsOnlyWorld.destination, undefined, 'original', 'overlook', {
      mode: 'original-sidecars',
    });
    assert.deepEqual(editsOnly.files[0]?.sidecarNames, ['IMG_4021.xmp']);
    assert.deepEqual(readdirSync(editsOnlyWorld.destination).sort(), ['IMG_4021.JPG', 'IMG_4021.xmp']);
  });

  test('Original only writes nothing beside the original, whatever the metadata policy', async () => {
    const world = await seededWorld(1);
    const row = world.rows.get('PHOTO0');
    assert.ok(row);
    world.rows.set('PHOTO0', { ...row, title: 'Titled' });
    const engine = new ExportEngine({ ...world.deps, editHead: () => head(ROTATED) });
    const summary = await engine.exportPhotos(['PHOTO0'], world.destination, undefined, 'original', 'overlook', { mode: 'original' });
    assert.equal(summary.exported, 1);
    assert.deepEqual(readdirSync(world.destination), ['IMG_4021.JPG']);
    assert.deepEqual(readFileSync(join(world.destination, 'IMG_4021.JPG')), world.bytesById.get('PHOTO0'));
  });

  test('format: jpeg stays Baked on the wire; format: original stays Original + sidecars', async () => {
    const world = await seededWorld(1);
    const engine = new ExportEngine({ ...world.deps, editHead: () => head(ROTATED) });
    const baked = await engine.exportPhotos(['PHOTO0'], world.destination, undefined, 'jpeg');
    assert.equal(baked.bakedEdits, 1);
    const original = await engine.exportPhotos(['PHOTO0'], world.destination, undefined, 'original');
    assert.equal(original.editSidecars, 1);
  });

  test('the preflight names an operation this build cannot carry; Original only reports the omission instead', async () => {
    const world = await seededWorld(3);
    const engine = new ExportEngine({
      ...world.deps,
      editHead: (id) => (id === 'PHOTO0' ? head(IDENTITY_TRANSFORM, 'tone-curve v2') : id === 'PHOTO1' ? head(ROTATED) : null),
    });
    const ids = ['PHOTO0', 'PHOTO1', 'PHOTO2'];
    assert.deepEqual(engine.preflightEdits(ids, 'baked'), {
      edited: 2,
      losses: [{ photoId: 'PHOTO0', fileName: 'IMG_4021.JPG', reason: 'tone-curve v2' }],
    });
    assert.equal(engine.preflightEdits(ids, 'original-sidecars').losses.length, 1);
    assert.deepEqual(engine.preflightEdits(ids, 'original'), { edited: 2, losses: [] });
    // A bake of the unsupported stack fails that entry honestly; the batch continues.
    const summary = await engine.exportPhotos(ids, world.destination, undefined, 'original', 'original', { mode: 'baked' });
    assert.deepEqual(
      { exported: summary.exported, failed: summary.failed, bakedEdits: summary.bakedEdits },
      { exported: 2, failed: 1, bakedEdits: 1 },
    );
    assert.match(summary.failures[0]?.reason ?? '', /cannot render \(tone-curve v2\)/u);
    // Original + sidecars ships the bytes and names no edit it cannot serialize.
    const sidecars = await engine.exportPhotos(['PHOTO0'], world.destination, undefined, 'original', 'none', { mode: 'original-sidecars' });
    assert.equal(sidecars.exported, 1);
    assert.equal(sidecars.editSidecars, 0);
  });
});

describe('disclosure classes at the export boundary (#509, ADR-0032 §6)', () => {
  const planner: NonNullable<ExportEngineDeps['disclosure']> = (_photoId, intent) =>
    compileDisclosurePlan({
      boundary: 'export',
      destination: intent.destination,
      chain: { library: DEFAULT_DISCLOSURE_POLICY },
      operation: intent.operation,
    });

  async function worldWithLocation() {
    const world = await seededWorld(1);
    const current = world.rows.get('PHOTO0')!;
    world.rows.set(current.id, { ...current, title: 'Harbour at dusk', gpsLat: 52.37, gpsLon: 4.9 });
    return { ...world, engine: new ExportEngine({ ...world.deps, disclosure: planner }) };
  }

  function onDisk(destination: string): string {
    return readdirSync(destination)
      .map((name) => readFileSync(join(destination, name), 'latin1'))
      .join('\n');
  }

  test('an original whose bytes embed a private field is refused, crosses when the operation widens it, and crosses Baked untouched', async () => {
    const refused = await worldWithLocation();
    await assert.rejects(refused.engine.exportPhotos(['PHOTO0'], refused.destination, undefined, 'original'), (error: unknown) => {
      assert.ok(error instanceof ExportPreflightError);
      assert.match(error.message, /disclosure: location \(1\)/u);
      return true;
    });
    assert.deepEqual(readdirSync(refused.destination), [], 'nothing crossed');

    const widened = await worldWithLocation();
    const summary = await widened.engine.exportPhotos(['PHOTO0'], widened.destination, undefined, 'original', 'none', undefined, {
      destination: 'shared',
      operation: { narrow: [], widen: ['location'] },
    });
    assert.equal(summary.files.length, 1);
    assert.deepEqual(readdirSync(widened.destination), ['IMG_4021.JPG']);

    const baked = await worldWithLocation();
    const bakedSummary = await baked.engine.exportPhotos(['PHOTO0'], baked.destination, undefined, 'jpeg');
    assert.equal(bakedSummary.files.length, 1, 'a baked payload carries no embedded metadata, so nothing is withheld');
  });

  test('authored XMP carries only what the plan discloses; a public destination discloses nothing by default', async () => {
    const disclosed = await worldWithLocation();
    await disclosed.engine.exportPhotos(['PHOTO0'], disclosed.destination, undefined, 'jpeg', 'overlook');
    assert.ok(onDisk(disclosed.destination).includes('Harbour at dusk'), 'a shared title crosses to a named recipient');

    const narrowed = await worldWithLocation();
    const summary = await narrowed.engine.exportPhotos(['PHOTO0'], narrowed.destination, undefined, 'jpeg', 'overlook', undefined, {
      destination: 'shared',
      operation: { narrow: ['title'], widen: [] },
    });
    assert.equal(summary.files.length, 1);
    assert.ok(!onDisk(narrowed.destination).includes('Harbour at dusk'), 'the narrowed title never reaches disk');

    const published = await worldWithLocation();
    await published.engine.exportPhotos(['PHOTO0'], published.destination, undefined, 'jpeg', 'overlook', undefined, {
      destination: 'public',
      operation: { narrow: [], widen: [] },
    });
    assert.ok(!onDisk(published.destination).includes('Harbour at dusk'), 'nothing defaults to public');
  });
});
