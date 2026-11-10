import { test, expect, _electron as electron } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// #509 exit criteria over the real app: Settings ▸ Privacy lists every
// classifiable field with its ADR-0032 §6 default and the pinned-private
// set; a class change round-trips through main and survives a relaunch;
// the Export dialog shows the disclosure preview — what crosses, what is
// withheld, and the destination choice — before anything leaves.

test('disclosure: §6 defaults, a persisted class change, and the pre-export preview', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-disclosure-');
  const destination = mkE2eTmpDir('overlook-e2e-disclosure-dest-');
  const env = {
    ...process.env,
    OVERLOOK_USER_DATA: userData,
    OVERLOOK_INSECURE_KEYSTORE: '1',
    OVERLOOK_SEED: '4',
    OVERLOOK_EXPORT_DESTINATION: destination,
  };
  let app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    const section = page.getByTestId('disclosure-settings');
    await expect(section).toBeVisible();
    await expect(page.getByTestId('disclosure-field-location')).toHaveAttribute('data-class', 'private');
    await expect(page.getByTestId('disclosure-field-ratings')).toHaveAttribute('data-class', 'private');
    await expect(page.getByTestId('disclosure-field-faces')).toHaveAttribute('data-class', 'private');
    await expect(page.getByTestId('disclosure-field-title')).toHaveAttribute('data-class', 'shared');
    await expect(page.getByTestId('disclosure-field-captureTime')).toHaveAttribute('data-class', 'shared');
    await expect(section.locator('[data-class="public"]')).toHaveCount(0);
    await expect(page.getByTestId('disclosure-pinned')).toContainText('key material');
    await expect(page.getByTestId('disclosure-pinned')).toContainText('protected-album');

    // Narrow capture time to private: main stores it and the row reflects the stored answer.
    const group = page.getByRole('radiogroup', { name: 'Disclosure class for Capture time' });
    await group.getByRole('radio', { name: 'Private' }).click();
    await expect(page.getByTestId('disclosure-field-captureTime')).toHaveAttribute('data-class', 'private');
    await page.keyboard.press('Escape');

    // The preview before a crossing: the export dialog names what leaves.
    await page.locator('.ovl-grid__cell').nth(1).getByRole('button', { name: 'Select' }).click();
    await page.getByTestId('selection-pill').getByRole('button', { name: 'Export' }).click();
    const preview = page.getByTestId('disclosure-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('What leaves');
    // Destination is a named choice (#1308), defaulting to a named recipient.
    const destination = preview.getByRole('radiogroup', { name: 'Destination' });
    await expect(destination.getByRole('radio', { name: 'Named recipient' })).toBeChecked();
    await expect(destination).toHaveAccessibleDescription(
      'A folder you choose, Apple Photos, or a keyed provider. Shared and Public fields cross.',
    );
    await expect(page.getByTestId('disclosure-preview-loading')).toHaveCount(0);
    // Seeded photos carry a capture time in their bytes and no GPS: with capture
    // time now private, an Original export is blocked until it is included.
    await expect(page.getByTestId('disclosure-row-captureTime')).toHaveAttribute('data-disclosed', '0');
    await expect(page.getByTestId('disclosure-blocked')).toBeVisible();
    // A choice, not an error: no alert, a polite announcement instead.
    await expect(preview.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('screen-reader-announcer-polite')).toHaveText(
      'The originals can’t leave while Capture time is withheld.',
      {
        timeout: 20_000,
      },
    );
    // Unavailable, and saying why (#1307).
    await expect(page.getByRole('button', { name: 'Export 1 photo' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('export-reason')).toHaveText('Include the withheld field, or export Baked.');
    await page.getByTestId('disclosure-widen-captureTime').getByRole('checkbox').click();
    await expect(page.getByTestId('disclosure-blocked')).toHaveCount(0);
    await expect(page.getByTestId('disclosure-row-captureTime')).toHaveAttribute('data-disclosed', '1');
    await page.keyboard.press('Escape');
  } finally {
    await app.close();
  }

  // The class change persisted in the library, not in renderer state.
  app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    await expect(page.getByTestId('disclosure-field-captureTime')).toHaveAttribute('data-class', 'private');
    await expect(page.getByTestId('disclosure-field-title')).toHaveAttribute('data-class', 'shared');
  } finally {
    await app.close();
  }
});
