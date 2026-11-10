import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/app.js';

test('explicit Apple Photos review imports and add-only export writes the selected original (#798)', async ({ launchOverlook }) => {
  const importSource = mkdtempSync(join(tmpdir(), 'overlook-e2e-photokit-source-'));
  const exportDestination = mkdtempSync(join(tmpdir(), 'overlook-e2e-photokit-export-'));
  copyFileSync(join(import.meta.dirname, '../fixtures/exif/exif-full.jpg'), join(importSource, 'photos-fixture.jpg'));
  const running = await launchOverlook({
    prefix: 'overlook-e2e-photokit-profile-',
    env: {
      OVERLOOK_SEED: '1',
      OVERLOOK_PHOTOKIT_IMPORT_SOURCE: importSource,
      OVERLOOK_PHOTOKIT_EXPORT_DESTINATION: exportDestination,
    },
  });
  const { page } = running;

  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('radio', { name: 'Apple Photos' }).click();
  await page.getByRole('button', { name: 'Review photos from Apple Photos' }).click();
  await expect(page.getByTestId('photokit-review')).toContainText('0 of 1 selected');
  await page.getByRole('checkbox', { name: 'photos-fixture.jpg · image' }).click();
  await page.getByRole('button', { name: 'Import 1 photos' }).click();
  await expect(page.getByText('All 1 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Show in library' }).click();
  await expect(page.getByRole('button', { name: 'All Photos 2' })).toBeVisible();

  await page.locator('.ovl-grid__cell').first().getByRole('button', { name: 'Select' }).click();
  await page.getByTestId('selection-pill').getByRole('button', { name: 'Export' }).click();
  await page.getByRole('radio', { name: 'Apple Photos' }).click();
  // #509: the fixture carries GPS and precise location is Private by default, so the
  // original cannot leave until the user includes it for this one export.
  await expect(page.getByTestId('disclosure-blocked')).toBeVisible();
  // Unavailable, and saying why (#1307).
  await expect(page.getByRole('button', { name: 'Export 1 photo', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('export-reason')).toHaveText('Include the withheld field, or export Baked.');
  await page.getByTestId('disclosure-widen-location').getByRole('checkbox').click();
  await expect(page.getByTestId('disclosure-blocked')).toHaveCount(0);
  await page.getByRole('button', { name: 'Export 1 photo', exact: true }).click();
  await expect(page.getByText('1 photo exported and decrypted to Apple Photos.')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => readdirSync(exportDestination).length).toBe(1);
});
