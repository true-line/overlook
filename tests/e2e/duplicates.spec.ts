import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { expect, test } from './support/app.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

// #650 acceptance over the real app: import an original, a recompressed
// copy, a rotated copy and an unrelated photo; Review Duplicates groups the
// three copies (with the turn reported) and leaves the unrelated photo out.
// Move to Trash routes through the ordinary library delete, and marking one
// survivor Original removes the pair under #482's policy without a rescan.

const PHOTOS = join(import.meta.dirname, '../fixtures/photos');

async function makeCard(): Promise<string> {
  const card = join(mkE2eTmpDir('overlook-e2e-duplicates-card-'), 'DUPES');
  mkdirSync(card);
  const original = readFileSync(join(PHOTOS, 'summer-landscape.jpg'));
  copyFileSync(join(PHOTOS, 'summer-landscape.jpg'), join(card, 'landscape.jpg'));
  writeFileSync(join(card, 'landscape-web.jpg'), await sharp(original).resize({ width: 800 }).jpeg({ quality: 60 }).toBuffer());
  writeFileSync(join(card, 'landscape-turned.jpg'), await sharp(original).rotate(90).jpeg({ quality: 90 }).toBuffer());
  copyFileSync(join(PHOTOS, 'street-city.jpg'), join(card, 'street.jpg'));
  return card;
}

test('duplicates: review groups the copies, Trash and the Original policy reshape the group', async ({ launchOverlook }) => {
  test.setTimeout(120_000);
  const card = await makeCard();
  const { app, page } = await launchOverlook({
    prefix: 'overlook-e2e-duplicates-',
    readyTestId: null,
    env: { OVERLOOK_IMPORT_SOURCE: card },
  });
  await page.getByRole('button', { name: 'Start a new library' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('DUPES')).toBeVisible();
  await page.getByRole('button', { name: 'Import 4 photos' }).click();
  await expect(page.getByText('All 4 photos imported and encrypted.')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Show in library' }).click();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(4);

  // File → Review Duplicates… (⌥⌘D is this item's accelerator, which lives
  // on the native menu, so the item is what a synthetic key press cannot reach).
  // Windows/Linux run with no native menu bar (ADR-0024 §5), and the
  // renderer keymap defers this command to the (absent) native accelerator,
  // so deliver it over the same IPC event the menu item would have used.
  if (process.platform === 'darwin') {
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('library.duplicates');
      if (item?.click === undefined) throw new Error('menu item unavailable: library.duplicates');
      Reflect.apply(item.click, item, [
        item,
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
        { triggeredByAccelerator: false },
      ]);
    });
  } else {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (win === undefined) throw new Error('no window to receive library.duplicates');
      win.webContents.send('commands:invoked', { id: 'library.duplicates' });
    });
  }
  const dialog = page.getByRole('dialog', { name: 'Review Duplicates' });
  await expect(dialog).toBeVisible();
  const body = dialog.getByTestId('duplicates-dialog');
  await expect(body).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(body).toHaveAttribute('data-groups', '1');
  await expect(body).toHaveAttribute('data-indexed', '4');
  const group = dialog.getByTestId('duplicate-group');
  await expect(group).toHaveAttribute('data-count', '3');
  await expect(group).toContainText('landscape.jpg');
  await expect(group).toContainText('landscape-web.jpg');
  await expect(group).toContainText('landscape-turned.jpg');
  await expect(group).not.toContainText('street.jpg');
  const turned = dialog.locator('[data-testid="duplicate-photo"]', { hasText: 'landscape-turned.jpg' });
  await expect(turned).toContainText(/rotated (90|270)°/u);
  await expect(dialog.getByText(/of 64 bits differ/u).first()).toBeVisible();

  // Move to Trash is the ordinary delete: the copy leaves the group. From the
  // keyboard, focus moves on to the next candidate in the dialog, and the
  // groups left are announced (#1305).
  await dialog.getByRole('button', { name: 'Move to Trash: landscape-web.jpg' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ovl-toast-host')).toContainText('Moved landscape-web.jpg to Trash');
  await expect(group).toHaveAttribute('data-count', '2');
  await expect(group).not.toContainText('landscape-web.jpg');
  await expect(page.getByTestId('screen-reader-announcer-polite')).toHaveText('Moved landscape-web.jpg to Trash. 1 group left.', {
    timeout: 20_000,
  });
  await expect
    .poll(() =>
      page.evaluate<string | null>(
        `(() => { const el = document.activeElement; return el && el.closest('[role="dialog"]') ? el.getAttribute('aria-label') : null; })()`,
      ),
    )
    .toMatch(/^Move to Trash: landscape(-turned)?\.jpg$/u);

  // #482: an Original never pairs with a non-Original — the group is gone
  // the moment the marker lands, with no rescan.
  const originalId = await page.evaluate<string>(
    `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.find((p) => p.fileName === 'landscape.jpg').id)`,
  );
  await page.evaluate(`window.overlook.library.setOriginal({ photoIds: ['${originalId}'], isOriginal: true })`);
  await expect(body).toHaveAttribute('data-groups', '0');
  await expect(body).toContainText('No possible duplicates found.');

  // Both Originals: eligible again. A protected Original has no Trash
  // button; its row says why (#1305).
  const turnedId = await page.evaluate<string>(
    `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.find((p) => p.fileName === 'landscape-turned.jpg').id)`,
  );
  await page.evaluate(`window.overlook.library.setOriginal({ photoIds: ['${turnedId}'], isOriginal: true })`);
  await expect(body).toHaveAttribute('data-groups', '1');
  await expect(dialog.getByRole('region', { name: 'Possible duplicates, 2 photos, 2 protected Originals' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Move to Trash: /u })).toHaveCount(0);
  await expect(dialog.getByText('Protected Original — kept')).toHaveCount(2);
  await expect(dialog.getByText('To remove it, use Shift+Delete in the library').first()).toBeVisible();
});
