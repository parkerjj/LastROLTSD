import { test, expect } from '@playwright/test';

test('query UI renders its initial workflow on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LastRO Market' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search' })).toBeVisible();
  await page.getByPlaceholder('Item, shop, vendor').fill('sword');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('status').or(page.getByRole('alert'))).toBeVisible();
});
