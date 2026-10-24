import { expect, type Page } from '@playwright/test';

// Use the public composer menus in both fixture and opt-in native acceptance
// scripts, so those scripts follow the same interaction as a user.
export const modelTrigger = (page: Page) => page.getByRole('button', { name: /^模型与思考强度：/ });
export const permissionTrigger = (page: Page) => page.getByRole('button', { name: /^权限：/ });

async function choose(page: Page, group: '模型' | '思考强度', value: string) {
  const dialog = page.getByRole('dialog', { name: '模型与思考强度', exact: true });
  if (!await dialog.isVisible()) await modelTrigger(page).click();
  const selection = dialog.getByRole('radiogroup', { name: group, exact: true }).locator(`[role="radio"][data-value=${JSON.stringify(value)}]`);
  await selection.click();
  if (await dialog.isVisible()) await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

export const selectModel = (page: Page, model: string) => choose(page, '模型', model);
export const selectEffort = (page: Page, effort: string) => choose(page, '思考强度', effort);

export async function selectPermission(page: Page, value: 'read-only' | 'auto' | 'full-access') {
  const dialog = page.getByRole('dialog', { name: '权限', exact: true });
  if (!await dialog.isVisible()) await permissionTrigger(page).click();
  await dialog.locator(`[role="radio"][data-value=${JSON.stringify(value)}]`).click();
  if (await dialog.isVisible()) await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}
