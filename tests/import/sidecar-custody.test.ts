import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import { ImportEngine, type ImportEngineDeps, type ImportManifest } from '../../src/main/import/import-engine.js';
import { scanSource } from '../../src/main/import/source-scanner.js';
import { classifySidecarFile, sidecarStem } from '../../src/shared/library/sidecar-files.js';
import { ConsistencyChecker, LEFTOVER_MIN_AGE_MS } from '../../src/main/library/consistency.js';
import { ExportEngine, writeFileCleanly } from '../../src/main/export/export-engine.js';
import type { SidecarRecord } from '../../src/main/db/sidecar-repository.js';
import type { PhotoInsert, PhotoRecord } from '../../src/shared/library/types.js';

// Encrypted sidecar custody (#484, ADR-0031 §4): companions discovered beside
// an original import into per-photo encrypted custody, survive the Move
// verify-then-delete contract, export beside their original, purge with the
// photo, and never persist as durable plaintext.

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const XMP_BYTES = Buffer.from(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description><dc:subject><rdf:Bag><rdf:li>aurora</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>',
  'utf8',
);
const AAE_BYTES = Buffer.from('<?xml version="1.0"?><plist><dict><key>adjustmentData</key></dict></plist>', 'utf8');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('sidecar allowlist + association (#484)', () => {
  test('only reviewed formats classify; hidden and extensionless names never do', () => {
    assert.equal(classifySidecarFile('IMG_001.xmp'), 'xmp');
    assert.equal(classifySidecarFile('IMG_001.XMP'), 'xmp');
    assert.equal(classifySidecarFile('IMG_001.aae'), 'aae');
    assert.equal(classifySidecarFile('IMG_001.AAE'), 'aae');
    assert.equal(classifySidecarFile('IMG_001.txt'), null);
    assert.equal(classifySidecarFile('IMG_001.jpg'), null);
    assert.equal(classifySidecarFile('._IMG_001.xmp'), null);
    assert.equal(classifySidecarFile('.xmp'), null);
    assert.equal(classifySidecarFile('xmp'), null);
  });

  test('stems match case-insensitively across media and companion', () => {
    assert.equal(sidecarStem('IMG_001.JPG'), sidecarStem('img_001.xmp'));
    assert.notEqual(sidecarStem('IMG_001.JPG'), sidecarStem('IMG_0012.xmp'));
  });
});

describe('scanner sidecar discovery (#484)', () => {
  test('companions attach to every stem-matching media file; unmatched ones are counted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-sidecar-scan-'));
    writeFileSync(join(dir, 'IMG_1.jpg'), JPEG_BYTES);
    writeFileSync(join(dir, 'IMG_1.xmp'), XMP_BYTES);
    writeFileSync(join(dir, 'IMG_1.AAE'), AAE_BYTES);
    writeFileSync(join(dir, 'IMG_2.jpg'), Buffer.concat([JPEG_BYTES, Buffer.from([0x00])]));
    writeFileSync(join(dir, 'stray.xmp'), XMP_BYTES);

    const { summary, files } = await scanSource(dir, { hasContentHash: () => false });

    assert.equal(summary.total, 2);
    assert.equal(summary.newSidecars, 2, 'both companions of IMG_1 count');
    assert.equal(summary.unmatchedCompanions, 1, 'stray.xmp is reported, not dropped');
    const withSidecars = files.find((file) => file.fileName === 'IMG_1.jpg');
    assert.deepEqual(withSidecars?.sidecars.map((sidecar) => sidecar.fileName).sort(), ['IMG_1.AAE', 'IMG_1.xmp']);
    assert.deepEqual(files.find((file) => file.fileName === 'IMG_2.jpg')?.sidecars, []);
  });

  test('a companion beside a RAW+JPG pair attaches to both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-sidecar-pair-'));
    writeFileSync(join(dir, 'IMG_1.jpg'), JPEG_BYTES);
    // A fake RAF only needs the allowlist; the engine would reclassify.
    writeFileSync(join(dir, 'IMG_1.raf'), Buffer.from('FUJIFILMCCD-RAW fake'));
    writeFileSync(join(dir, 'IMG_1.xmp'), XMP_BYTES);

    const { files } = await scanSource(dir, { hasContentHash: () => false });
    for (const file of files) {
      assert.deepEqual(
        file.sidecars.map((sidecar) => sidecar.fileName),
        ['IMG_1.xmp'],
        `${file.fileName} owns the companion`,
      );
    }
  });
});

interface World {
  readonly sourceDir: string;
  readonly dataDir: string;
  readonly store: BlobStore;
  readonly key: EnvelopeKey;
  readonly deps: ImportEngineDeps;
  readonly rows: Map<string, PhotoInsert>;
  readonly sidecarRows: SidecarRecord[];
  journal: ImportManifest | null;
}

function world(): World {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-sidecar-src-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-sidecar-lib-'));
  const store = new BlobStore({ dataDir });
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const rows = new Map<string, PhotoInsert>();
  const hashes = new Set<string>();
  const sidecarRows: SidecarRecord[] = [];
  let idCounter = 0;
  const holder: { journal: ImportManifest | null } = { journal: null };
  const deps: ImportEngineDeps = {
    readFile: async (path) => readFile(path),
    deleteFile: async (path) => unlink(path),
    journal: {
      read: () => Promise.resolve(holder.journal),
      begin: (manifest) => {
        holder.journal = manifest;
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
      clear: () => {
        holder.journal = null;
        return Promise.resolve();
      },
    },
    repo: {
      hasContentHash: (hash) => hashes.has(hash),
      get: (id) => rows.get(id) as unknown as PhotoRecord | undefined,
      insert: (photo) => {
        rows.set(photo.id, photo);
        hashes.add(photo.contentHash);
      },
      insertSidecar: (record) => {
        if (!sidecarRows.some((row) => row.photoId === record.photoId && row.contentHash === record.contentHash)) {
          sidecarRows.push(record);
        }
      },
      addImportedKeywords: (photoId, keywords) => {
        const current = rows.get(photoId);
        if (current === undefined) return false;
        rows.set(photoId, { ...current, importedKeywords: [...keywords] });
        return true;
      },
      repairGeneratedDimensions: () => false,
      setDimensionStatus: () => false,
      setPreviewFailure: () => false,
    },
    blobs: store,
    generateThumbs: () => Promise.resolve({ generated: false, width: 1, height: 1 }),
    extractMetadata: () =>
      Promise.resolve({
        width: null,
        height: null,
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
    currentKey: () => key,
    resolveKey: () => key.key,
    newId: () => `01SIDECAR${String((idCounter += 1)).padStart(17, '0')}`,
    now: () => '2026-07-29T00:00:00.000Z',
    events: { copyProgress: () => undefined, thumbProgress: () => undefined },
    sourceExists: existsSync,
    parentIdentity: () => Promise.resolve('src-parent'),
  };
  return {
    sourceDir,
    dataDir,
    store,
    key,
    deps,
    rows,
    sidecarRows,
    get journal() {
      return holder.journal;
    },
    set journal(value) {
      holder.journal = value;
    },
  };
}

async function initWorld(w: World): Promise<void> {
  await w.store.init();
}

describe('sidecar import custody (#484)', () => {
  test('ACCEPTANCE: copy import lands one photo record with encrypted companion custody, byte-identical on decrypt', async () => {
    const w = world();
    await initWorld(w);
    writeFileSync(join(w.sourceDir, 'IMG_1.jpg'), JPEG_BYTES);
    writeFileSync(join(w.sourceDir, 'IMG_1.xmp'), XMP_BYTES);

    const summary = await new ImportEngine(w.deps).importFiles(
      [
        {
          path: join(w.sourceDir, 'IMG_1.jpg'),
          fileName: 'IMG_1.jpg',
          kind: 'jpeg',
          sidecars: [{ path: join(w.sourceDir, 'IMG_1.xmp'), fileName: 'IMG_1.xmp', role: 'xmp' }],
        },
      ],
      'copy',
      w.sourceDir,
    );

    assert.equal(summary.imported, 1);
    assert.equal(summary.sidecars, 1);
    assert.equal(w.rows.size, 1, 'the companion is never a separate photo');
    assert.deepEqual([...w.rows.values()][0]?.importedKeywords, ['aurora'], 'search projection retains XMP keyword provenance');
    assert.equal(w.sidecarRows.length, 1);
    const row = w.sidecarRows[0];
    assert.ok(row);
    assert.equal(row.role, 'xmp');
    assert.equal(row.contentHash, sha256(XMP_BYTES));

    // Custody: encrypted at rest, no durable plaintext anywhere in the library.
    const decrypted = await buffer(w.store.getSidecarStream(row.photoId, row.contentHash, () => w.key.key));
    assert.deepEqual(decrypted, XMP_BYTES, 'byte-identical after decrypt');
    const sidecarFiles = readdirSync(join(w.dataDir, 'sidecars'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.equal(sidecarFiles.length, 1);
    const onDisk = readFileSync(join(sidecarFiles[0]!.parentPath, sidecarFiles[0]!.name));
    assert.ok(!onDisk.includes(Buffer.from('aurora')), 'ciphertext never contains sidecar plaintext');
    assert.equal(onDisk.subarray(0, 4).toString('ascii'), 'OVLK', 'companion is a real envelope');

    // Source files untouched by Copy.
    assert.ok(existsSync(join(w.sourceDir, 'IMG_1.xmp')));
  });

  test('the envelope AAD binds the owning photo — a companion re-pointed at another photo fails to decrypt', async () => {
    const w = world();
    await initWorld(w);
    const put = await w.store.putSidecar(Readable.from([XMP_BYTES]), w.key, 'photo-a');
    assert.equal(await w.store.verifySidecar('photo-a', put.contentHash, () => w.key.key), true);
    // Same bytes claimed under a different photo id: not present, and even a
    // copied ciphertext would fail its AAD.
    assert.equal(await w.store.verifySidecar('photo-b', put.contentHash, () => w.key.key), false);
    const ciphertext = await buffer(w.store.getEncryptedSidecarStream('photo-a', put.contentHash));
    await assert.rejects(
      w.store.restoreSidecar('photo-b', put.contentHash, Readable.from([ciphertext]), () => w.key.key),
      /verification/,
    );
  });

  test('ACCEPTANCE: Move deletes companion sources only after verified encrypted custody; a vanished companion fails honestly', async () => {
    const w = world();
    await initWorld(w);
    writeFileSync(join(w.sourceDir, 'IMG_1.jpg'), JPEG_BYTES);
    writeFileSync(join(w.sourceDir, 'IMG_1.xmp'), XMP_BYTES);
    writeFileSync(join(w.sourceDir, 'IMG_1.aae'), AAE_BYTES);

    const summary = await new ImportEngine(w.deps).importFiles(
      [
        {
          path: join(w.sourceDir, 'IMG_1.jpg'),
          fileName: 'IMG_1.jpg',
          kind: 'jpeg',
          sidecars: [
            { path: join(w.sourceDir, 'IMG_1.xmp'), fileName: 'IMG_1.xmp', role: 'xmp' },
            { path: join(w.sourceDir, 'IMG_1.aae'), fileName: 'IMG_1.aae', role: 'aae' },
          ],
        },
      ],
      'move',
      w.sourceDir,
    );
    assert.equal(summary.moved, 1);
    assert.equal(summary.sidecars, 2);
    assert.ok(!existsSync(join(w.sourceDir, 'IMG_1.jpg')), 'original source removed');
    assert.ok(!existsSync(join(w.sourceDir, 'IMG_1.xmp')), 'xmp source removed after verify');
    assert.ok(!existsSync(join(w.sourceDir, 'IMG_1.aae')), 'aae source removed after verify');

    // A second photo whose companion vanishes mid-import: the photo's own
    // custody stands (status imported), the file reports the failure, and
    // nothing pretends the companion landed.
    writeFileSync(join(w.sourceDir, 'IMG_2.jpg'), Buffer.concat([JPEG_BYTES, Buffer.from([1])]));
    const missing = join(w.sourceDir, 'IMG_2.xmp');
    const summary2 = await new ImportEngine(w.deps).importFiles(
      [
        {
          path: join(w.sourceDir, 'IMG_2.jpg'),
          fileName: 'IMG_2.jpg',
          kind: 'jpeg',
          sidecars: [{ path: missing, fileName: 'IMG_2.xmp', role: 'xmp' }],
        },
      ],
      'copy',
      w.sourceDir,
    );
    assert.equal(summary2.imported, 1, 'the photo itself imported');
    assert.equal(summary2.sidecars, 0, 'no phantom companion custody');
  });

  test('REGRESSION (PR #849): a companion shared by a RAW+JPG pair is deleted only after BOTH owners record custody', async () => {
    const w = world();
    await initWorld(w);
    writeFileSync(join(w.sourceDir, 'IMG_1.jpg'), JPEG_BYTES);
    writeFileSync(join(w.sourceDir, 'IMG_1.raf'), Buffer.concat([Buffer.from('FUJIFILM-RAW-'), JPEG_BYTES]));
    writeFileSync(join(w.sourceDir, 'IMG_1.xmp'), XMP_BYTES);
    const shared = { path: join(w.sourceDir, 'IMG_1.xmp'), fileName: 'IMG_1.xmp', role: 'xmp' as const };

    const summary = await new ImportEngine(w.deps).importFiles(
      [
        { path: join(w.sourceDir, 'IMG_1.jpg'), fileName: 'IMG_1.jpg', kind: 'jpeg', sidecars: [shared] },
        { path: join(w.sourceDir, 'IMG_1.raf'), fileName: 'IMG_1.raf', kind: 'raw', sidecars: [shared] },
      ],
      'move',
      w.sourceDir,
    );

    assert.equal(summary.moved, 2);
    assert.equal(summary.sidecars, 2, 'both owners hold authenticated custody');
    assert.equal(w.sidecarRows.length, 2, 'one row per owner');
    for (const row of w.sidecarRows) {
      assert.equal(await w.store.verifySidecar(row.photoId, row.contentHash, () => w.key.key), true, `${row.photoId} custody verifies`);
    }
    assert.ok(!existsSync(join(w.sourceDir, 'IMG_1.xmp')), 'shared source deleted once, after the LAST owner');
  });

  test('duplicate photos skip companion import — the existing custody stays authoritative', async () => {
    const w = world();
    await initWorld(w);
    writeFileSync(join(w.sourceDir, 'IMG_1.jpg'), JPEG_BYTES);
    writeFileSync(join(w.sourceDir, 'IMG_1.xmp'), XMP_BYTES);
    const input = [
      {
        path: join(w.sourceDir, 'IMG_1.jpg'),
        fileName: 'IMG_1.jpg',
        kind: 'jpeg' as const,
        sidecars: [{ path: join(w.sourceDir, 'IMG_1.xmp'), fileName: 'IMG_1.xmp', role: 'xmp' as const }],
      },
    ];
    await new ImportEngine(w.deps).importFiles(input, 'copy', w.sourceDir);
    const again = await new ImportEngine(w.deps).importFiles(input, 'copy', w.sourceDir);
    assert.equal(again.duplicates, 1);
    assert.equal(w.sidecarRows.length, 1, 'no duplicate custody rows');
  });
});

describe('sidecar export (#484, ADR-0031 §6)', () => {
  test('EXIT CRITERIA: sidecars export beside the original under its RESOLVED collision name', async () => {
    const w = world();
    await initWorld(w);
    const photoId = 'photo-1';
    const originalHash = sha256(JPEG_BYTES);
    await w.store.putOriginal(Readable.from([JPEG_BYTES]), w.key, photoId);
    const sidecarPut = await w.store.putSidecar(Readable.from([XMP_BYTES]), w.key, photoId);

    const destination = mkdtempSync(join(tmpdir(), 'overlook-sidecar-export-'));
    // Occupy the natural name so the export must suffix the whole group.
    writeFileSync(join(destination, 'IMG_1.jpg'), Buffer.from('occupied'));

    const photo = {
      id: photoId,
      fileName: 'IMG_1.jpg',
      contentHash: originalHash,
      bytes: JPEG_BYTES.length,
      fileKind: 'jpeg',
    } as unknown as PhotoRecord;
    const engine = new ExportEngine({
      repo: { get: () => photo },
      blobs: { getStream: (hash, resolve, id) => w.store.getStream(hash, resolve, id) },
      resolveKey: () => w.key.key,
      sidecarsFor: () => [{ fileName: 'IMG_1.xmp', contentHash: sidecarPut.contentHash, keyId: w.key.id, bytes: XMP_BYTES.length }],
      sidecarStream: (id, hash) => w.store.getSidecarStream(id, hash, () => w.key.key),
      writeFile: writeFileCleanly,
      exists: (path) => Promise.resolve(existsSync(path)),
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
      joinPath: (dir, name) => join(dir, name),
      transcodeJpeg: () => Promise.reject(new Error('not used')),
      bufferStream: async (stream) => buffer(stream),
      events: { progress: () => undefined },
    });

    const summary = await engine.exportPhotos([photoId], destination);
    assert.equal(summary.exported, 1);
    assert.equal(summary.sidecarsExported, 1);
    assert.deepEqual(readFileSync(join(destination, 'IMG_1 (1).jpg')), JPEG_BYTES);
    assert.deepEqual(readFileSync(join(destination, 'IMG_1 (1).xmp')), XMP_BYTES, 'companion follows the resolved stem');
  });
});

describe('sidecar consistency scan (#484)', () => {
  test('owned companions are never orphans; unknown ones age-gate then repair per photo', async () => {
    const w = world();
    await initWorld(w);
    const owned = await w.store.putSidecar(Readable.from([XMP_BYTES]), w.key, 'photo-live');
    const debris = await w.store.putSidecar(Readable.from([AAE_BYTES]), w.key, 'photo-gone');

    const checker = (age: () => Promise<{ photoId: string; hash: string; ageMs: number }[]>): ConsistencyChecker =>
      new ConsistencyChecker({
        rows: () => [],
        ownedSidecars: () => [{ photoId: 'photo-live', contentHash: owned.contentHash }],
        blobs: {
          listOriginalHashes: () => Promise.resolve([]),
          listThumbHashes: () => Promise.resolve([]),
          listSidecarEntries: age,
          listStaged: () => Promise.resolve([]),
          hasOriginal: () => true,
          deleteOriginal: () => Promise.resolve(undefined),
          deleteThumbs: () => Promise.resolve(undefined),
          deleteSidecars: async (photoId) => w.store.deleteSidecars(photoId),
          removeStaged: () => Promise.resolve(undefined),
        },
        remoteHas: () => Promise.resolve(false),
        setStatus: () => undefined,
        libraryChanged: () => undefined,
        audit: () => undefined,
      });

    // Fresh entries are live writes, never reaped.
    const fresh = await checker(async () => w.store.listSidecarEntries()).scan();
    assert.deepEqual(fresh.orphanSidecars, []);

    // Aged debris under a photo with no rows at all repairs away; the owned
    // companion survives.
    const aged = checker(async () => (await w.store.listSidecarEntries()).map((entry) => ({ ...entry, ageMs: LEFTOVER_MIN_AGE_MS + 1 })));
    const report = await aged.repair();
    assert.deepEqual(report.orphanSidecars, [`photo-gone:${debris.contentHash}`]);
    assert.equal(await w.store.verifySidecar('photo-live', owned.contentHash, () => w.key.key), true, 'owned custody intact');
    assert.equal(w.store.hasSidecar('photo-gone', debris.contentHash), false, 'debris removed');
  });
});
