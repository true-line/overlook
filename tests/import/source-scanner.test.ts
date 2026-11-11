import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { listVolumes, scanFiles, scanSource, folderSource, type VolumeListerDeps } from '../../src/main/import/source-scanner.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import { classifyMediaFile } from '../../src/shared/library/media-files.js';

describe('media-file allowlist (ADR-0006)', () => {
  test('classifies media extensions case-insensitively', () => {
    assert.equal(classifyMediaFile('IMG_4021.JPG'), 'jpeg');
    assert.equal(classifyMediaFile('img_4021.jpeg'), 'jpeg');
    assert.equal(classifyMediaFile('shot.PNG'), 'png');
    assert.equal(classifyMediaFile('live.HEIC'), 'heic');
    assert.equal(classifyMediaFile('scene.heif'), 'heic');
    for (const ext of ['RAF', 'cr2', 'CR3', 'nef', 'ARW', 'dng', 'orf', 'RW2']) {
      assert.equal(classifyMediaFile(`raw.${ext}`), 'raw', ext);
    }
  });

  test('rejects non-media, sidecars, and hidden files', () => {
    assert.equal(classifyMediaFile('clip.wmv'), null); // .mp4 admits as a video candidate since #549
    assert.equal(classifyMediaFile('notes.txt'), null);
    assert.equal(classifyMediaFile('.DS_Store'), null);
    assert.equal(classifyMediaFile('._IMG_0001.JPG'), null);
    assert.equal(classifyMediaFile('noextension'), null);
    assert.equal(classifyMediaFile('trailingdot.'), null);
  });
});

function fixtureCard(): { dir: string; jpegBytes: Buffer[] } {
  const dir = mkdtempSync(join(tmpdir(), 'overlook-card-'));
  mkdirSync(join(dir, 'DCIM', '100MSDCF'), { recursive: true });
  mkdirSync(join(dir, '.Trashes'), { recursive: true });
  const jpegBytes: Buffer[] = [];
  for (let index = 0; index < 4; index += 1) {
    const bytes = sampleJpeg(index);
    jpegBytes.push(bytes);
    writeFileSync(join(dir, 'DCIM', '100MSDCF', `IMG_${String(index)}.JPG`), bytes);
  }
  // Two "RAW" files (content is arbitrary — the scanner hashes, not decodes).
  writeFileSync(join(dir, 'DCIM', '100MSDCF', 'IMG_9000.RAF'), randomBytes(64));
  writeFileSync(join(dir, 'DCIM', '100MSDCF', 'IMG_9001.ARW'), randomBytes(64));
  writeFileSync(join(dir, 'DCIM', '100MSDCF', 'IMG_9002.HEIC'), randomBytes(48));
  // Noise the allowlist must ignore.
  writeFileSync(join(dir, 'DCIM', '100MSDCF', 'IMG_9000.XMP'), 'sidecar');
  writeFileSync(join(dir, 'DCIM', '.hiddenfile.jpg'), 'hidden');
  writeFileSync(join(dir, '.Trashes', 'ghost.jpg'), 'trash');
  return { dir, jpegBytes };
}

describe('source scan (#84)', () => {
  test('EXIT CRITERIA: exact new/total/RAW/JPG/bytes against a fixture card', async () => {
    const { dir, jpegBytes } = fixtureCard();
    // The library already owns jpeg #0 — presence by content hash.
    const known = new Set([
      createHash('sha256')
        .update(jpegBytes[0] ?? Buffer.alloc(0))
        .digest('hex'),
    ]);
    const progress: number[] = [];
    const { summary, files } = await scanSource(dir, { hasContentHash: (hash) => known.has(hash) }, (snapshot) => {
      progress.push(snapshot.scanned);
    });

    assert.equal(summary.total, 7, 'allowlist media only — sidecars/hidden/trash ignored');
    assert.equal(summary.newCount, 6);
    assert.equal(summary.newRaw, 2);
    assert.equal(summary.newJpg, 3);
    assert.equal(summary.newOther, 1, 'HEIC is not a JPG (PR #174 review)');
    const expectedBytes = jpegBytes.slice(1).reduce((sum, bytes) => sum + bytes.length, 0) + 64 + 64 + 48;
    assert.equal(summary.newBytes, expectedBytes);
    assert.equal(files.length, 7);
    assert.equal(files.filter((file) => !file.isNew).length, 1);
    assert.equal(progress.at(-1), 7, 'a final done snapshot always fires');
  });

  test('re-scan after "import" reports 0 new (dedupe by content hash)', async () => {
    const { dir } = fixtureCard();
    const first = await scanSource(dir, { hasContentHash: () => false });
    assert.equal(first.summary.newCount, 7);
    // "Import" = the library now knows every hash the scan found.
    const known = new Set(first.files.map((file) => file.contentHash));
    const second = await scanSource(dir, { hasContentHash: (hash) => known.has(hash) });
    assert.equal(second.summary.newCount, 0);
    assert.equal(second.summary.newBytes, 0);
    assert.equal(second.summary.total, 7, 'the card itself is unchanged');
  });

  test('an unreadable directory is skipped, never fatal (PR #174 review)', { skip: process.platform === 'win32' }, async () => {
    const { dir } = fixtureCard();
    const locked = join(dir, 'System Volume Information');
    mkdirSync(locked);
    writeFileSync(join(locked, 'ghost.jpg'), 'unreachable');
    chmodSync(locked, 0o000);
    try {
      const { summary } = await scanSource(dir, { hasContentHash: () => false });
      assert.equal(summary.total, 7, 'valid media still counted');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('scanner hash matches the repository dedupe primitive end to end', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-scan-db-'));
    const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'w', '2026-07-01T00:00:00Z')`);
    const repo = new PhotosRepository(db);

    const { dir } = fixtureCard();
    const scan = await scanSource(dir, { hasContentHash: (hash) => repo.hasContentHash(hash) });
    const firstNew = scan.files.find((file) => file.isNew);
    assert.notEqual(firstNew, undefined);
    repo.insert({
      id: '01J8SCANTEST0001',
      fileName: firstNew?.fileName ?? '',
      fileKind: firstNew?.kind ?? 'jpeg',
      width: 1,
      height: 1,
      bytes: firstNew?.bytes ?? 0,
      contentHash: firstNew?.contentHash ?? '',
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
      importedAt: '2026-07-12T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    });
    const rescan = await scanSource(dir, { hasContentHash: (hash) => repo.hasContentHash(hash) });
    assert.equal(rescan.summary.newCount, scan.summary.newCount - 1);
  });
});

describe('dropped-file scan (#237)', () => {
  test('explicit paths: allowlist filter, NEW dedupe, and per-file skip of vanished paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-scanfiles-'));
    writeFileSync(join(dir, 'a.jpg'), randomBytes(64));
    writeFileSync(join(dir, 'b.raf'), randomBytes(64));
    writeFileSync(join(dir, 'notes.txt'), 'not media');
    const { summary, files } = await scanFiles([join(dir, 'a.jpg'), join(dir, 'b.raf'), join(dir, 'notes.txt'), join(dir, 'gone.jpg')], {
      hasContentHash: () => false,
    });
    // notes.txt fails the allowlist; gone.jpg vanished — neither sinks the
    // batch (PR #249 review), and the two real photos scan through.
    assert.equal(summary.newCount, 2);
    assert.equal(summary.newRaw, 1);
    assert.equal(summary.newJpg, 1);
    assert.deepEqual(files.map((file) => file.fileName).sort(), ['a.jpg', 'b.raf']);
  });

  test('P0 #406: dropped folders recurse and mixed entries deduplicate paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-drop-folder-'));
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const direct = join(root, 'direct.jpg');
    const child = join(nested, 'child.nef');
    writeFileSync(direct, randomBytes(64));
    writeFileSync(child, randomBytes(64));

    const { summary, files } = await scanFiles([root, direct, root], { hasContentHash: () => false });
    assert.equal(summary.newCount, 2);
    assert.deepEqual(
      files.map(({ path }) => path).sort(),
      [direct, child].sort(),
      'folder expansion and explicit duplicates produce one candidate per path',
    );
  });

  test('#548: container kinds are signature-gated — an unimportable .ts is never counted or attempted', async () => {
    const videoFixtures = join(import.meta.dirname, '../../../tests/fixtures/video');
    const { summary, files } = await scanFiles(
      [
        join(videoFixtures, 'supported-h264-aac.ts'), // real H.264/AAC transport stream → importable video
        join(videoFixtures, 'malformed-no-cadence.ts'), // no 0x47 cadence, not an image → will be rejected at import
        join(videoFixtures, 'spoofed-jpeg.ts'), // JPEG bytes behind a .ts suffix → imports as the still it truly is
      ],
      { hasContentHash: () => false },
    );
    // The malformed .ts is dropped at scan time, so the ready count never
    // promises an import that the engine would then reject — and `total`
    // counts survivors only, so it never keeps a rejected drop "ready".
    assert.deepEqual(files.map((file) => file.fileName).sort(), ['spoofed-jpeg.ts', 'supported-h264-aac.ts']);
    assert.equal(summary.newCount, 2);
    assert.equal(summary.total, 2);
  });

  test('#548: a drop of only unimportable containers reports total 0 — the no-supported-files path (#745 review)', async () => {
    const videoFixtures = join(import.meta.dirname, '../../../tests/fixtures/video');
    const { summary, files } = await scanFiles([join(videoFixtures, 'malformed-no-cadence.ts')], { hasContentHash: () => false });
    // total === 0 is the signal the renderer + Google Drive use to take the
    // "no supported files were dropped" path instead of opening an empty dialog.
    assert.equal(summary.total, 0);
    assert.equal(summary.newCount, 0);
    assert.equal(files.length, 0);
  });

  test('#489/#1438: symlinks and package directories (including .overlooklibrary) are never expanded into scan candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-drop-boundaries-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'overlook-drop-target-')), 'outside.jpg');
    writeFileSync(outside, randomBytes(64));
    symlinkSync(outside, join(root, 'linked.jpg'));
    const photosLibrary = join(root, 'System.photoslibrary');
    mkdirSync(photosLibrary);
    writeFileSync(join(photosLibrary, 'hidden.jpg'), randomBytes(64));
    const overlookBundle = join(root, 'Personal.overlooklibrary');
    mkdirSync(join(overlookBundle, 'blobs'), { recursive: true });
    writeFileSync(join(overlookBundle, 'blobs', 'inside-bundle.jpg'), randomBytes(64));
    const admitted = join(root, 'admitted.jpg');
    writeFileSync(admitted, randomBytes(64));

    const dropped = await scanFiles([root, join(root, 'linked.jpg')], { hasContentHash: () => false });
    assert.deepEqual(
      dropped.files.map((file) => file.path),
      [admitted],
    );
    const scanned = await scanSource(root, { hasContentHash: () => false });
    assert.deepEqual(
      scanned.files.map((file) => file.path),
      [admitted],
    );
  });
});

describe('volume enumeration (#84)', () => {
  test('darwin lists /Volumes entries, skipping the boot-volume symlink and dotfiles', async () => {
    const deps: VolumeListerDeps = {
      platform: 'darwin',
      listDir: (dir) => Promise.resolve(dir === '/Volumes' ? ['Macintosh HD', 'SONY 128GB', '.timemachine'] : []),
      isSymlink: (path) => Promise.resolve(path === '/Volumes/Macintosh HD'),
      exists: () => Promise.resolve(true),
    };
    assert.deepEqual(await listVolumes(deps), [{ path: '/Volumes/SONY 128GB', label: 'SONY 128GB', kind: 'volume' }]);
  });

  test('win32 probes drive letters D–Z', async () => {
    const deps: VolumeListerDeps = {
      platform: 'win32',
      listDir: () => Promise.resolve([]),
      isSymlink: () => Promise.resolve(false),
      exists: (path) => Promise.resolve(path === 'E:\\'),
    };
    assert.deepEqual(await listVolumes(deps), [{ path: 'E:\\', label: 'E:', kind: 'volume' }]);
  });

  test('folder sources take the basename as the label', () => {
    assert.deepEqual(folderSource('/Users/me/Pictures/Kyoto Trip'), {
      path: '/Users/me/Pictures/Kyoto Trip',
      label: 'Kyoto Trip',
      kind: 'folder',
    });
  });
});
