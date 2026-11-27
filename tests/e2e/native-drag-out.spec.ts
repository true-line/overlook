import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/app.js';
import type { Page } from '@playwright/test';
import { decodePhotoDrag, PHOTO_DRAG_TYPE } from '../../src/shared/library/photo-drag.js';
import { BOUNDARY_FIELDS, type DisclosureField } from '../../src/shared/disclosure/policy.js';

async function allowHarnessFields(page: Page, locationPublic: boolean): Promise<void> {
  await page.evaluate(
    async ({ fields, locationPublic: includeLocation }) => {
      const api = (
        globalThis as unknown as {
          overlook: { disclosure: { setField(request: { field: DisclosureField; class: 'public' | 'private' }): Promise<unknown> } };
        }
      ).overlook.disclosure;
      for (const field of fields) await api.setField({ field, class: field === 'location' && !includeLocation ? 'private' : 'public' });
    },
    { fields: [...BOUNDARY_FIELDS.export], locationPublic },
  );
}

test('selected photos enter the bounded materializer; this does not exercise a signed native session (#796/#1028)', async ({
  launchOverlook,
}) => {
  const destination = mkdtempSync(join(tmpdir(), 'overlook-e2e-native-drag-'));
  const running = await launchOverlook({
    prefix: 'overlook-e2e-native-drag-profile-',
    env: { OVERLOOK_SEED: '3', OVERLOOK_NATIVE_DRAG_DESTINATION: destination },
  });
  await running.page.locator('.ovl-tile__img').first().waitFor();
  await expect
    .poll(() => running.page.evaluate<{ available: boolean; reason: string | null }>('window.overlook.nativeDrag.status()'))
    .toEqual({ available: true, reason: null });
  await allowHarnessFields(running.page, true);
  await running.page.getByRole('button', { name: 'Select IMG_4021.RAF' }).click();
  await running.page.getByRole('button', { name: 'Select IMG_4028.JPG' }).click();

  const transfer = await running.page.evaluateHandle(
    () => new (globalThis as unknown as { DataTransfer: new () => object }).DataTransfer(),
  );
  await running.page.getByRole('button', { name: /Open IMG_4021\.RAF/u }).dispatchEvent('dragstart', { dataTransfer: transfer });
  await expect
    .poll(() =>
      readdirSync(destination)
        .sort()
        .map((name) => [name, readFileSync(join(destination, name)).length > 0]),
    )
    .toEqual([
      ['IMG_4021.RAF', true],
      ['IMG_4028.JPG', true],
    ]);
  expect(readFileSync(join(destination, 'IMG_4021.RAF')).length).toBeGreaterThan(0);
  expect(readFileSync(join(destination, 'IMG_4028.JPG')).length).toBeGreaterThan(0);
  await transfer.dispose();
});

test('private GPS refuses original materialization and retains the internal drag payload (#1137)', async ({ launchOverlook }) => {
  const source = mkdtempSync(join(tmpdir(), 'overlook-native-gps-source-'));
  const destination = mkdtempSync(join(tmpdir(), 'overlook-native-gps-receiver-'));
  copyFileSync(join(import.meta.dirname, '../fixtures/exif/exif-full.jpg'), join(source, 'native-gps.jpg'));
  const { page } = await launchOverlook({
    prefix: 'overlook-native-gps-profile-',
    env: { OVERLOOK_SEED: '1', OVERLOOK_IMPORT_SOURCE: source, OVERLOOK_NATIVE_DRAG_DESTINATION: destination },
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('button', { name: 'Import 1 photo', exact: true }).click();
  await page.getByRole('button', { name: 'Show in library' }).click();
  await allowHarnessFields(page, false);
  await page.getByRole('button', { name: /^(?:Select|Deselect) native-gps\.jpg$/u }).click();
  const transfer = await page.evaluateHandle(
    () => new (globalThis as unknown as { DataTransfer: new () => { getData(type: string): string } }).DataTransfer(),
  );
  await page.getByRole('button', { name: 'Open native-gps.jpg', exact: true }).dispatchEvent('dragstart', { dataTransfer: transfer });
  await expect(page.getByRole('group', { name: 'Notification' })).toContainText(
    'Original drag blocked. Withheld: Precise location. Use Export → Baked.',
  );
  expect(readdirSync(destination)).toEqual([]);
  const payload = decodePhotoDrag(await transfer.evaluate((value, mime) => value.getData(mime), PHOTO_DRAG_TYPE));
  expect(payload?.photoIds).toHaveLength(1);
  expect(payload?.sourceAlbumId).toBeNull();
  await transfer.dispose();
});
