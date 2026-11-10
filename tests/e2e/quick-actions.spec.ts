import { expect, test } from './support/app.js';

test('Command-hover Quick Actions share targets and cleanup across gallery views (#532)', async ({ launchOverlook }) => {
  test.skip(process.platform !== 'darwin', 'Command-hover is a macOS interaction contract');
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-quick-actions-', env: { OVERLOOK_SEED: '4' } });
  const cells = page.locator('.ovl-grid__cell');
  await expect(cells).toHaveCount(4);

  const first = cells.first();
  await first.hover();
  await page.keyboard.down('Meta');
  const toolbar = page.getByRole('toolbar', { name: /Quick Actions for/u });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: /(?:Add to|Remove from) Favorites\. This photo/u })).toBeEnabled();
  await page.keyboard.up('Meta');
  await expect(toolbar).toHaveCount(0);

  await first.hover();
  await first.locator('.ovl-tile__select').click();
  const second = cells.nth(1);
  await second.hover();
  await second.locator('.ovl-tile__select').click();
  await first.locator('.ovl-tile__open').focus();
  await page.keyboard.down('Meta');
  await expect(toolbar).toContainText('This photo / Selection (2)');
  await expect(toolbar.getByRole('button', { name: /Export….*Selection \(2\)/u })).toBeEnabled();
  await page.mouse.wheel(0, 160);
  await expect(toolbar).toHaveCount(0);
  await page.keyboard.up('Meta');

  await page.getByRole('radio', { name: 'List' }).click();
  const firstRow = page.locator('.ovl-grid__cell').first();
  await firstRow.hover();
  await page.keyboard.down('Meta');
  await expect(toolbar).toBeVisible();
  await page.keyboard.up('Meta');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).click();
  const pane = page.getByTestId('settings-pane');
  await pane.getByRole('switch', { name: 'Move photo to Trash' }).click();
  await pane.getByRole('switch', { name: 'Restore photo' }).click();
  await pane.getByRole('button', { name: 'Up — Move Restore photo up' }).click();
  await expect
    .poll(() => page.evaluate(`window.overlook.settings.get().then(({ settings }) => settings.quickActions)`))
    .toEqual(['photo.favorite.toggle', 'album.membership.add', 'photo.restore', 'photo.export']);
  await page.keyboard.press('Escape');

  await firstRow.hover();
  await page.keyboard.down('Meta');
  await expect(toolbar.getByRole('button', { name: /Restore photo.*Available only for photos in Trash/u })).toBeDisabled();
  await page.keyboard.up('Meta');
});

test('configured Quick Actions drive platform-neutral More Actions menus (#532)', async ({ launchOverlook }) => {
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-quick-actions-menu-', env: { OVERLOOK_SEED: '4' } });
  const cells = page.locator('.ovl-grid__cell');
  await expect(cells).toHaveCount(4);

  const first = cells.first();
  await first.locator('.ovl-tile__select').click();
  await cells.nth(1).locator('.ovl-tile__select').click();
  const third = cells.nth(2);
  await third.getByRole('button', { name: /More actions for/u }).click();
  let menu = page.getByRole('menu', { name: /Actions for/u });
  await menu.getByRole('menuitem', { name: /Export… This photo/u }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export' });
  await expect(exportDialog).toContainText('1 photo selected');
  await exportDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('2 selected')).toBeVisible();

  await first.getByRole('button', { name: /More actions for/u }).click();
  menu = page.getByRole('menu', { name: /Actions for/u });
  await expect(menu.getByRole('menuitem', { name: /Export… Selection \(2\)/u })).toBeVisible();
  await page.keyboard.press('Escape');

  const moreActions = first.getByRole('button', { name: /More actions for/u });
  await moreActions.click();
  menu = page.getByRole('menu', { name: /Actions for/u });
  await menu.getByRole('menuitem', { name: /Add to album.*Selection \(2\)/u }).click();
  const albumPicker = page.getByTestId('album-picker');
  await expect(albumPicker).toHaveClass(/ovl-albumpicker--context/u);
  await expect(albumPicker.getByRole('menu', { name: 'Add to album' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(moreActions).toBeFocused();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).click();
  const pane = page.getByTestId('settings-pane');
  await pane.getByRole('switch', { name: 'Move photo to Trash' }).click();
  await pane.getByRole('switch', { name: 'Restore photo' }).click();
  await pane.getByRole('button', { name: 'Up — Move Restore photo up' }).click();
  await expect
    .poll(() => page.evaluate(`window.overlook.settings.get().then(({ settings }) => settings.quickActions)`))
    .toEqual(['photo.favorite.toggle', 'album.membership.add', 'photo.restore', 'photo.export']);
  await page.keyboard.press('Escape');

  await first.getByRole('button', { name: /More actions for/u }).click();
  await expect(menu.getByRole('menuitem', { name: /Restore photo.*Available only for photos in Trash/u })).toBeDisabled();
});
