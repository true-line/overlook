import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type LaunchedApp, type LaunchSpec } from './support/app.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';
import { confirmNativeDisclosure } from './support/disclosure-consent.js';

// #90 exit criteria: the whole import path proven in CI — fixture folder in,
// encrypted library out. The OVERLOOK_IMPORT_SOURCE harness hook is the
// mock-file-dialog seam: it surfaces the fixture card as the first source.

const FIXTURES = join(import.meta.dirname, '../fixtures/exif');
const CARD_FILES = ['exif-full.jpg', 'sample.raf', 'exif-stripped.jpg'];
const XMP_MARKER = 'overlook-e2e-sidecar-keyword-aurora';
const RAW_EXTENSIONS = ['raf', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2'] as const;

function makeCard(): string {
  const card = join(mkE2eTmpDir('overlook-e2e-card-'), 'SDCARD');
  mkdirSync(card);
  for (const name of CARD_FILES) {
    copyFileSync(join(FIXTURES, name), join(card, name));
  }
  return card;
}

function makeRawMatrixCard(): string {
  const card = join(mkE2eTmpDir('overlook-e2e-raw-card-'), 'RAW-CARD');
  mkdirSync(card);
  const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
  for (const extension of RAW_EXTENSIONS) {
    writeFileSync(join(card, `sample.${extension}`), Buffer.concat([Buffer.from(`OVERLOOK-${extension}-`), jpeg]));
  }
  return card;
}

/** Every file under `dir` containing `marker` as raw bytes. */
function filesContaining(dir: string, marker: Buffer): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, name);
    try {
      if (statSync(path).isFile() && readFileSync(path).includes(marker)) {
        hits.push(name);
      }
    } catch {
      continue;
    }
  }
  return hits;
}

type LaunchOverlook = (spec: LaunchSpec) => Promise<LaunchedApp>;

async function launch(card: string, launchOverlook: LaunchOverlook): Promise<LaunchedApp> {
  const launched = await launchOverlook({
    prefix: 'overlook-e2e-import-',
    readyTestId: null,
    env: {
      OVERLOOK_IMPORT_SOURCE: card,
    },
  });
  await launched.page.getByRole('button', { name: 'Start a new library' }).click();
  return launched;
}

test('Copy import: dialog flow, encrypted at rest, grid + toast + counts', { tag: '@windows-import' }, async ({ launchOverlook }) => {
  const card = makeCard();
  const { page, userData, close } = await launch(card, launchOverlook);
  try {
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    // Options: the fixture card surfaced through the harness seam.
    await expect(page.getByText('SDCARD')).toBeVisible();
    await expect(page.getByText('3 new ·')).toBeVisible();
    await page.getByRole('button', { name: 'Import 3 photos' }).click();

    // Done: clean summary, then Show in library.
    await expect(page.getByText('All 3 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.clock.install();
    await page.getByRole('button', { name: 'Show in library' }).click();

    // Toast fires only after the modal is gone (#89 + PR #185 review).
    const toast = page.getByRole('group', { name: 'Notification' });
    await expect(toast).toContainText('Imported 3 photos');
    await expect(toast.getByRole('button', { name: 'Show' })).toBeVisible();

    // The grid shows the batch with real decoded thumbs; sidebar counts live.
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'All Photos 3' })).toBeVisible();

    // Action stays reachable past the ordinary 4s timeout, then activating it
    // dismisses the toast (#411).
    await page.clock.fastForward(4_200);
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Show' }).click();
    await expect(toast).toBeHidden();

    // Beneath the UI: complete DB rows through the typed bridge...
    const rows = await page.evaluate<{ camera: string | null; id: string; syncState: string }[]>(
      `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => ({ camera: p.camera, id: p.id, syncState: p.syncState })))`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.camera === 'FUJIFILM X-T5')).toBe(true);
    for (const row of rows) {
      expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    }

    // Auto-backup-on-import (#105/#111, default on): the batch uploads to
    // the mock provider in the background and every row lands synced.
    await expect
      .poll(
        async () =>
          page.evaluate<string[]>(
            `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => p.syncState))`,
          ),
        { timeout: 15_000 },
      )
      .toEqual(['synced', 'synced', 'synced']);

    // ...and no plaintext fixture bytes anywhere in the profile (blobs and
    // DB encrypted; derivatives strip metadata; no-store protocols).
    const needle = readFileSync(join(FIXTURES, 'exif-full.jpg')).subarray(600, 640);
    expect(filesContaining(userData, needle)).toEqual([]);

    // Copy mode: the card is untouched.
    expect(readdirSync(card).sort()).toEqual([...CARD_FILES].sort());
  } finally {
    await close();
  }
});

test('ACCEPTANCE (#484): sidecars import into encrypted custody — no plaintext at rest — and export beside the original', async ({
  launchOverlook,
}) => {
  // A card with one photo + its XMP companion, plus a companion nobody owns.
  const card = join(mkE2eTmpDir('overlook-e2e-sidecar-card-'), 'SDCARD');
  mkdirSync(card);
  copyFileSync(join(FIXTURES, 'exif-full.jpg'), join(card, 'exif-full.jpg'));
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description><dc:subject><rdf:Bag><rdf:li>${XMP_MARKER}</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>`;
  writeFileSync(join(card, 'exif-full.xmp'), xmp, 'utf8');
  writeFileSync(join(card, 'stray.xmp'), xmp, 'utf8');

  const destination = mkE2eTmpDir('overlook-e2e-sidecar-export-');
  const { app, page, userData, close } = await launchOverlook({
    prefix: 'overlook-e2e-sidecar-',
    readyTestId: null,
    env: {
      OVERLOOK_IMPORT_SOURCE: card,
      OVERLOOK_EXPORT_DESTINATION: destination,
    },
  });
  try {
    await page.getByRole('button', { name: 'Start a new library' }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    // The scan card reports the companion and the unmatched stray honestly.
    await expect(page.getByText(/JPG · 1 sidecar$/u)).toBeVisible();
    await expect(page.getByText('1 sidecar file without a matching photo skipped')).toBeVisible();
    await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click();
    await expect(page.getByText('All 1 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();

    // Encrypted custody: the XMP text exists nowhere in the library profile.
    expect(filesContaining(userData, Buffer.from(XMP_MARKER))).toEqual([]);
    const sidecarEnvelopes = readdirSync(join(userData, 'library', 'sidecars'), { recursive: true, encoding: 'utf8' }).filter((name) =>
      statSync(join(userData, 'library', 'sidecars', name)).isFile(),
    );
    expect(sidecarEnvelopes).toHaveLength(1);

    // Export: the companion lands beside the original, byte-identical.
    await page.getByTestId('virtual-grid').waitFor();
    await page.locator('.ovl-tile__img, .ovl-tile').first().waitFor();
    await page.locator('.ovl-grid__cell').first().getByRole('button', { name: 'Select' }).click();
    await page.getByTestId('selection-pill').getByRole('button', { name: 'Export' }).click();
    // The original embeds a precise location: disclosure (#509) holds the
    // export until the user widens it for this operation. Widen before the
    // folder is chosen: a destination authorization is bound to the intent
    // and is discarded when the intent changes.
    await expect(page.getByTestId('disclosure-blocked')).toBeVisible();
    await page.getByTestId('disclosure-widen-location').getByRole('checkbox').click();
    await expect(page.getByTestId('disclosure-blocked')).toHaveCount(0);
    await expect(page.getByTestId('disclosure-sidecars')).toContainText('Tags');
    await expect(page.getByTestId('disclosure-sidecars')).toContainText(XMP_MARKER);
    await page.getByRole('button', { name: /Choose folder/u }).click();
    await confirmNativeDisclosure(app, 'Export folder');
    await page.getByRole('button', { name: 'Export 1 photo', exact: true }).click();
    await expect(page.getByText('1 photo exported and decrypted.')).toBeVisible({ timeout: 20_000 });

    expect(readFileSync(join(destination, 'exif-full.xmp'), 'utf8')).toBe(xmp);
    expect(existsSync(join(destination, 'exif-full.jpg'))).toBe(true);
  } finally {
    await close();
  }
});

test('Move import: warning shown, sources emptied only after verified import', async ({ launchOverlook }) => {
  const card = makeCard();
  const { page, close } = await launch(card, launchOverlook);
  try {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('radio', { name: 'Move' }).click();
    await expect(page.getByRole('alert')).toContainText('only after encrypted custody and decrypt/hash verification');
    await expect(page.getByRole('button', { name: 'Import 3 photos' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /I understand verified source files/u }).click();
    await page.getByRole('button', { name: 'Import 3 photos' }).click();
    await expect(page.getByText('3 moved · 0 retained after encrypted custody verification.')).toBeVisible({ timeout: 30_000 });

    // Every file verified (decrypt + re-hash) before its source was removed.
    expect(readdirSync(card)).toEqual([]);
    for (const name of CARD_FILES) {
      expect(existsSync(join(card, name))).toBe(false);
    }
  } finally {
    await close();
  }
});

test('RAW matrix: every accepted extension imports with a visible tile and lightbox preview (#368)', async ({ launchOverlook }) => {
  const { page, close } = await launch(makeRawMatrixCard(), launchOverlook);
  try {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('8 new ·')).toBeVisible();
    await page.getByRole('button', { name: 'Import 8 photos' }).click();
    await expect(page.getByText('All 8 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();

    const images = page.getByTestId('virtual-grid').locator('.ovl-tile__img');
    await expect(images).toHaveCount(8);
    await expect
      .poll(async () =>
        images.evaluateAll((nodes) => nodes.every((node) => (node as unknown as { readonly naturalWidth: number }).naturalWidth > 0)),
      )
      .toBe(true);
    const rows = await page.evaluate<{ fileKind: string; width: number; height: number }[]>(
      `window.overlook.library.page({ source: 'all', limit: 20 }).then((r) => r.photos.map((p) => ({ fileKind: p.fileKind, width: p.width, height: p.height })))`,
    );
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.fileKind === 'raw' && row.width > 0 && row.height > 0)).toBe(true);

    await page
      .getByRole('button', { name: /Open sample\./u })
      .first()
      .click();
    await expect(page.getByText('Preview', { exact: true })).toBeVisible();
    await expect(page.getByText('Preview unavailable')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('Folder Move (#489): explicit consent, verified per-file deletion, and folder preservation', async ({ launchOverlook }) => {
  const folder = makeCard();
  const { page, close } = await launchOverlook({
    prefix: 'overlook-e2e-import-',
    readyTestId: null,
    env: {
      // No OVERLOOK_IMPORT_SOURCE: the folder path is the source under test.
      OVERLOOK_IMPORT_FOLDER: folder,
    },
  });
  try {
    await page.getByRole('button', { name: 'Start a new library' }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    // Source picker (#237): switch to Local folder and pick through the
    // harness-seamed dialog.
    await page.getByRole('radio', { name: 'Local folder' }).click();
    await page.getByText('Choose a folder to import').click();
    await expect(page.getByText(folder)).toBeVisible();
    await expect(page.getByText('3 new ·')).toBeVisible();

    await page.getByRole('radio', { name: 'Move' }).click();
    await expect(page.getByRole('alert')).toContainText('The folder and unrelated files stay.');
    await expect(page.getByRole('button', { name: 'Import 3 photos' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /I understand verified source files/u }).click();
    await page.getByRole('button', { name: 'Import 3 photos' }).click();
    await expect(page.getByText('3 moved · 0 retained after encrypted custody verification.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);

    expect(readdirSync(folder)).toEqual([]);
    expect(existsSync(folder)).toBe(true);
  } finally {
    await close();
  }
});

test('Google Drive import (#465): selected cloud files use the copy-only encrypted pipeline', async ({ launchOverlook }) => {
  const driveFiles = makeCard();
  const { page, close } = await launchOverlook({
    prefix: 'overlook-e2e-drive-import-',
    readyTestId: null,
    env: {
      OVERLOOK_GOOGLE_DRIVE_IMPORT_SOURCE: driveFiles,
    },
  });
  try {
    await page.getByRole('button', { name: 'Start a new library' }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('radio', { name: 'Google Drive' }).click();
    await page.getByText('Choose photos from Google Drive').click();

    await expect(page.getByText('3 photos selected from Google Drive')).toBeVisible();
    await expect(page.getByText('3 new ·')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Move' })).toBeDisabled();
    await page.getByRole('button', { name: 'Import 3 photos' }).click();
    await expect(page.getByText('All 3 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);

    const sources = await page.evaluate<string[]>(
      `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => p.importSource))`,
    );
    expect(sources).toEqual(['Google Drive', 'Google Drive', 'Google Drive']);
    expect(readdirSync(driveFiles).sort()).toEqual([...CARD_FILES].sort());
  } finally {
    await close();
  }
});
