import { test, expect } from '@playwright/test';

const optionsPayload = {
  version: 'options-lastro-70.83',
  options: [{
    type: 12,
    handle: 'VAR_SPACCELERATION',
    label_zh: 'SP恢复速度增加数值%',
    description_template: 'SP恢复速度增加{value}%',
    value_kind: 'integer',
    unit: '',
    scale: 1,
    allowed_operators: ['eq', 'gte', 'lte'],
    param_policy: { mode: 'ignored', filterable: false },
    repeat_policy: 'same',
    display_template: 'SP恢复速度增加{value}%',
    search_tokens: [],
  }],
};

const firstResults = {
  items: [{
    id: 1,
    itemId: 1234,
    itemName: '波利卡片',
    price: 50000,
    quantity: 2,
    mapName: '普隆德拉',
    vendorName: '玩家甲',
    title: '波利商店',
    options: [{ type: 12, value: 50, param: 0, display: 'SP恢复速度增加50%' }],
    lastSeenAt: 1,
  }],
  nextCursor: 'page-2',
};

async function mockApi(page: any, searchUrls: string[]): Promise<void> {
  await page.route('**/api/v1/options**', (route: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(optionsPayload) }));
  await page.route('**/api/v1/items**', (route: any) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ version: 'catalog-v1', items: [
      { itemId: 1234, name: '波利卡片', aliases: ['波利'] },
      { itemId: 1235, name: '波利帽', aliases: [] },
    ] }),
  }));
  await page.route('**/api/v1/market/search**', (route: any) => {
    const url = new URL(route.request().url());
    searchUrls.push(url.toString());
    const response = url.searchParams.get('cursor') === 'page-2'
      ? { items: [{ ...firstResults.items[0], id: 2, itemId: 1235, itemName: '波利帽', options: [] }], nextCursor: null }
      : firstResults;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.route('**/api/v1/market/listings/*/history**', (route: any) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      items: [{ id: 1, observedAt: 1, price: 50000, quantity: 2, eventType: 'observed' }],
      inferredSales: [],
      nextCursor: 'history-2',
    }),
  }));
}

test('中文搜索、metadata 词条、分页和历史抽屉可用', async ({ page }) => {
  const searchUrls: string[] = [];
  await mockApi(page, searchUrls);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'LastRO 市场' })).toBeVisible();
  const searchInput = page.getByRole('combobox', { name: '搜索物品、商店或玩家' });
  await searchInput.fill('波利');
  await expect(page.getByRole('option', { name: /波利卡片/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /波利帽/ })).toBeVisible();
  await page.getByRole('option', { name: /波利卡片/ }).click();

  await page.getByRole('button', { name: '添加词条条件' }).click();
  const row = page.locator('[data-option-row]').first();
  await row.getByLabel('词条', { exact: true }).selectOption('12');
  await expect(row.getByLabel('比较符').locator('option')).toHaveCount(3);
  await row.getByLabel('比较符').selectOption('gte');
  await row.getByLabel('词条数值').fill('50');
  await page.getByRole('radio', { name: '匹配任一' }).check();
  await page.getByRole('button', { name: '搜索' }).click();

  await expect(page.getByText('波利卡片')).toBeVisible();
  await expect(page.getByText('物品 ID：1234')).toBeVisible();
  expect(searchUrls.at(-1)).toContain('q=%E6%B3%A2%E5%88%A9');
  expect(searchUrls.at(-1)).toContain('option=12%3Agte%3A50');
  expect(searchUrls.at(-1)).toContain('option_mode=any');

  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('波利帽')).toBeVisible();
  expect(searchUrls.at(-1)).toContain('cursor=page-2');

  await page.getByRole('button', { name: /查看历史/ }).click();
  await expect(page.getByRole('heading', { name: '价格历史' })).toBeVisible();
  await page.getByRole('button', { name: '关闭历史' }).click();
  await expect(page.getByRole('heading', { name: '价格历史' })).toBeHidden();
});

test('词条字典错误可重试并恢复', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/v1/options**', (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '词条字典暂不可用' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(optionsPayload) });
  });
  await page.route('**/api/v1/market/search**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) }));
  await page.goto('/');

  await expect(page.getByRole('alert')).toContainText('词条字典暂不可用');
  await page.getByRole('button', { name: '重试词条字典' }).click();
  await expect(page.getByRole('button', { name: '添加词条条件' })).toBeEnabled();
});

test('移动端词条行不会横向溢出且控件可聚焦', async ({ page }) => {
  const searchUrls: string[] = [];
  await mockApi(page, searchUrls);
  await page.goto('/');
  await page.getByRole('button', { name: '添加词条条件' }).click();
  const row = page.locator('[data-option-row]').first();
  await row.getByLabel('词条', { exact: true }).focus();
  await expect(row.getByLabel('词条', { exact: true })).toBeFocused();
  const overflow = await row.evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(overflow).toBe(true);
  await expect(page.getByRole('button', { name: '删除词条' })).toHaveAttribute('aria-label', '删除词条');
});

test('键盘可选择中文物品建议', async ({ page }) => {
  const searchUrls: string[] = [];
  await mockApi(page, searchUrls);
  await page.goto('/');

  const searchInput = page.getByRole('combobox', { name: '搜索物品、商店或玩家' });
  await searchInput.fill('波利');
  await expect(page.getByRole('option', { name: /波利卡片/ })).toBeVisible();
  await searchInput.press('ArrowDown');
  await searchInput.press('Enter');

  await expect(page.getByLabel('物品 ID')).toHaveValue('1234');
  await expect(searchInput).toBeFocused();
});

test('不完整词条条件显示错误且不发送查询', async ({ page }) => {
  const searchUrls: string[] = [];
  await mockApi(page, searchUrls);
  await page.goto('/');
  await expect.poll(() => searchUrls.length).toBe(1);

  await page.getByRole('button', { name: '添加词条条件' }).click();
  const row = page.locator('[data-option-row]').first();
  await row.getByLabel('词条', { exact: true }).selectOption('12');
  await page.getByRole('button', { name: '搜索' }).click();

  await expect(page.getByRole('alert', { name: '' })).toContainText('请完整填写词条条件');
  expect(searchUrls).toHaveLength(1);
});
