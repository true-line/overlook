import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import { ExportEngine, writeFileCleanly, type ExportEngineDeps } from '../../src/main/export/export-engine.js';
import {
  resolveContainedExportPath,
  sanitizeExportFileName,
  sanitizeImportedFileName,
  sanitizeSidecarExtension,
} from '../../src/main/export/export-path-safety.js';
import { transcodeToJpeg } from '../../src/main/export/transcode.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

function photoRow(id: string, fileName: string, contentHash: string, bytes: number): PhotoRecord {
  return {
    id,
    fileName,
    fileKind: 'jpeg',
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
    importSource: 'google-drive',
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

function makeExportDeps(
  store: BlobStore,
  key: EnvelopeKey,
  rows: ReadonlyMap<string, PhotoRecord>,
  sidecarPayload: Buffer,
): ExportEngineDeps {
  return {
    repo: { get: (id) => rows.get(id) },
    blobs: store,
    sidecarsFor: () => [
      {
        fileName: 'IMG.xmp/../../escaped-sidecar',
        contentHash: 'a'.repeat(64),
        keyId: key.id,
        bytes: sidecarPayload.length,
      },
    ],
    sidecarStream: () => Readable.from([sidecarPayload]),
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
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    },
    events: { progress: () => {} },
  };
}

describe('export path safety (#1428)', () => {
  test('sanitizes untrusted imported, exported, and sidecar filenames', () => {
    assert.equal(sanitizeImportedFileName('../../outside.jpg'), 'outside.jpg');
    assert.equal(sanitizeImportedFileName('..\\..\\evil.png'), 'evil.png');
    assert.equal(sanitizeImportedFileName('2026/07/Summer\u0000Trip.JPG'), '2026_07_Summer_Trip.JPG');
    assert.equal(sanitizeImportedFileName('../..'), null);
    assert.equal(sanitizeImportedFileName('   '), null);
    assert.equal(sanitizeExportFileName('../..', '01JPHOTOID'), '01JPHOTOID');
    assert.equal(sanitizeSidecarExtension('IMG.xmp'), '.xmp');
    assert.equal(sanitizeSidecarExtension('IMG.xmp/../../pwn'), '._pwn');
    assert.equal(sanitizeSidecarExtension('IMG.xmp/sub'), '.xmp_sub');
    assert.equal(sanitizeSidecarExtension('no-extension'), '');
  });

  test('resolveContainedExportPath rejects traversal or root-escaping joinPath seams', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-export-contain-'));
    assert.throws(() => resolveContainedExportPath(join, root, '../escape.jpg'), /unsafe export leaf filename/u);
    assert.throws(() => resolveContainedExportPath(join, root, '..'), /unsafe export leaf filename/u);
    assert.throws(
      () => resolveContainedExportPath((dir) => join(dir, '..', 'escape.jpg'), root, 'safe.jpg'),
      /escapes destination directory/u,
    );
  });

  test('ExportEngine confines unsanitized legacy photo and sidecar filenames inside destination', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'overlook-export-sandbox-'));
    const destination = join(sandbox, 'chosen-export');
    mkdirSync(destination);

    const store = new BlobStore({ dataDir: mkdtempSync(join(tmpdir(), 'overlook-export-blobs-')) });
    await store.init();
    const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
    const jpeg = sampleJpeg(0);
    const ref = await store.putOriginal(Readable.from([jpeg]), key, 'P1');
    const sidecarPayload = Buffer.from('<x:xmpmeta>sidecar</x:xmpmeta>');
    const rows = new Map<string, PhotoRecord>([['P1', photoRow('P1', '../../escape.jpg', ref.contentHash, jpeg.length)]]);
    const deps = makeExportDeps(store, key, rows, sidecarPayload);

    const summary = await new ExportEngine(deps).exportPhotos(['P1'], destination, undefined, 'original', 'original');
    assert.equal(summary.exported, 1);
    assert.equal(summary.failed, 0);
    assert.equal(existsSync(join(sandbox, 'escape.jpg')), false);
    assert.deepEqual(readdirSync(sandbox), ['chosen-export']);
    const [exported] = summary.files;
    assert.ok(exported !== undefined);
    assert.equal(exported.fileName, 'escape.jpg');
    assert.equal(exported.renamed, true);
    assert.deepEqual(readFileSync(join(destination, 'escape.jpg')), jpeg);
    const [sidecarName] = exported.sidecarNames;
    assert.ok(sidecarName !== undefined);
    assert.deepEqual(readFileSync(join(destination, sidecarName)), sidecarPayload);
  });
});
