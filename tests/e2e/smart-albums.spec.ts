import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// The row's action button only accepts pointer events while its row is
// hovered (CSS), and Playwright checks the hit target before moving the
// mouse — so hover first, then click.
async function openActions(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name: `Actions for ${name}` });
  await button.hover({ force: true });
  await button.click();
}

async function launchSeeded(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkE2eTmpDir('overlook-e2e-smart-albums-');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_SEED: '12', OVERLOOK_INSECURE_KEYSTORE: '1' },
  });
  const page = await app.firstWindow();
  await page.getByTestId('virtual-grid').waitFor();
  await page.locator('.ovl-tile__img').first().waitFor();
  return { app, page };
}

// #514 / ADR-0030 §3, §6 acceptance over the real IPC boundary: values
// within a facet are an inclusive union, facets compose by an explicit
// Match all / Match any, the saved Smart Album shows the same photos as the
// live filter that made it, it survives a relaunch, an edit re-evaluates
// the saved query, a duplicate sits beside the original, and deleting one
// removes only the query — every photo stays.
//
// Seed geometry (src/main/library/seed.ts): 12 live photos; camera cycles
// FUJIFILM X-T5 / SONY A7 IV / APPLE iPHONE 15 PRO / RICOH GR III by index,
// RAW at every fifth index (0, 5, 10). So Fuji ∪ Sony = 6 photos, of which
// 2 are RAW; Fuji ∪ Sony ∪ RAW = 7.
test('smart albums: union within a facet, explicit composition, save, relaunch, edit, duplicate, delete', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchSeeded();
  try {
    const cells = page.locator('.ovl-grid__cell');
    const row = (name: string) =>
      page.locator('.ovl-sidebar__albumrow', { has: page.locator(`:scope > .ovl-siderow:has-text("${name}")`) });
    const rowButton = (name: string) => row(name).locator(':scope > .ovl-siderow');
    const facetBar = page.getByTestId('facet-bar');
    const panel = (facet: string) => facetBar.getByRole('group', { name: `${facet} values` });
    const allPhotos = (count: number) => page.getByRole('button', { name: `All Photos ${String(count)}` });
    await expect(cells).toHaveCount(12);

    // Live facets: a plain pick, a Shift-click union, a second facet ANDed, then ORed.
    await page.getByRole('button', { name: 'Filters' }).click();
    await facetBar.getByRole('button', { name: /^Camera/u }).click();
    await panel('Camera')
      .getByRole('button', { name: /^FUJIFILM X-T5/u })
      .click();
    await expect(cells).toHaveCount(3);
    await panel('Camera')
      .getByRole('button', { name: /^SONY A7 IV/u })
      .click({ modifiers: ['Shift'] });
    await expect(cells).toHaveCount(6);
    await expect(panel('Camera').getByRole('button', { name: /^SONY A7 IV/u })).toHaveAttribute('aria-pressed', 'true');
    await expect(facetBar.getByRole('button', { name: 'Camera · 2' })).toBeVisible();
    await facetBar.getByRole('button', { name: /^File type/u }).click();
    await panel('File type').getByRole('button', { name: /^RAW/u }).click();
    await expect(cells).toHaveCount(2);
    await expect(facetBar.getByRole('status')).toContainText('2 facets · match all');
    await facetBar.getByRole('radio', { name: 'Match any' }).click();
    await expect(cells).toHaveCount(7);
    await expect(facetBar.getByRole('status')).toContainText('2 facets · match any');

    // Save the live predicate as a Smart Album: same photos, listed in the sidebar with its count.
    await facetBar.getByRole('button', { name: 'Save as Smart Album…' }).click();
    const save = page.getByRole('dialog', { name: 'Save as Smart Album' });
    await save.getByRole('textbox', { name: 'Smart Album name' }).fill('Two cameras');
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Saved Smart Album Two cameras');
    await expect(row('Two cameras')).toHaveAttribute('data-kind', 'smart');
    await expect(rowButton('Two cameras')).toContainText('7');
    await expect(facetBar.getByRole('status')).toContainText('Editing Two cameras');
    await expect(cells).toHaveCount(7);
    await expect(allPhotos(12)).toBeVisible();

    // The saved query is library data: it survives a relaunch and re-evaluates on open.
    await page.reload();
    await page.locator('.ovl-tile__img').first().waitFor();
    await expect(cells).toHaveCount(12);
    await expect(rowButton('Two cameras')).toContainText('7');
    await rowButton('Two cameras').click();
    await expect(cells).toHaveCount(7);
    await expect(rowButton('Two cameras')).toHaveClass(/ovl-siderow--active/u);
    await expect(allPhotos(12)).not.toHaveClass(/ovl-siderow--active/u);
    await expect(facetBar.getByRole('status')).toContainText('2 facets · match any · Editing Two cameras');

    // Editing: dropping the RAW value narrows the query; Save changes writes it back.
    await facetBar.getByRole('button', { name: /^File type/u }).click();
    await panel('File type').getByRole('button', { name: /^RAW/u }).click();
    await expect(cells).toHaveCount(6);
    await facetBar.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Saved changes to Two cameras');
    await expect(rowButton('Two cameras')).toContainText('6');

    // Duplicate sits beside the original with the same query; delete removes only the query.
    await openActions(page, 'Two cameras');
    await expect(page.getByRole('menuitem', { name: /Hide from All Photos|Show in All Photos/u })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(rowButton('Two cameras copy')).toContainText('6');
    await openActions(page, 'Two cameras copy');
    await page.getByRole('menuitem', { name: 'Delete Smart Album…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Smart Album' });
    await expect(dialog).toContainText('only the saved query is removed');
    await expect(dialog).toContainText('6 photos match it today');
    await dialog.getByRole('button', { name: 'Delete Smart Album' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Deleted Smart Album Two cameras copy · photos kept');
    await expect(row('Two cameras copy')).toHaveCount(0);
    await expect(rowButton('Two cameras')).toContainText('6');
    await expect(allPhotos(12)).toBeVisible();
    await expect(page.getByTestId('statusbar-left')).toContainText('12 photos');
  } finally {
    await app.close();
  }
});
