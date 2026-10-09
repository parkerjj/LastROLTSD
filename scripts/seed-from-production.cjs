/**
 * 从生产站 https://ltsd.ro 抓取 100 条真实市场数据，导入本地 MySQL 作为测试数据。
 * 会替换掉 source_id = 'local-test' 的旧假数据。
 *
 * 用法：node scripts/seed-from-production.cjs [数量，默认100] [--snapshot]
 *   --snapshot  可选，把原始响应存到 scripts/local-market-snapshot.json
 */
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_ID = 'local-test';
const API_BASE = 'https://ltsd.ro/api/v1/market/search';
const PAGE_SIZE = 20;
const TARGET = Number(process.argv[2] || 100);
const SAVE_SNAPSHOT = process.argv.includes('--snapshot');

async function crawl(target) {
  const items = [];
  let cursor = null;
  while (items.length < target) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), sort: 'changed_desc' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${API_BASE}?${params}`);
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const page = await res.json();
    items.push(...page.items);
    console.log(`crawled ${items.length}/${target} (page +${page.items.length})`);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  return items.slice(0, target);
}

async function main() {
  const items = await crawl(TARGET);
  if (SAVE_SNAPSHOT) {
    fs.writeFileSync(
      path.join(__dirname, 'local-market-snapshot.json'),
      JSON.stringify({ fetchedAt: new Date().toISOString(), count: items.length, items }, null, 2)
    );
    console.log(`snapshot saved: ${items.length} listings`);
  }

  const conn = await mysql.createConnection('mysql://root:root@127.0.0.1:3306/ro_items');
  await conn.query('DELETE FROM shops WHERE source_id = ?', [SOURCE_ID]);
  await conn.query(
    'INSERT IGNORE INTO market_sources (id, name, api_key_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [SOURCE_ID, '本地测试源', 'a'.repeat(64), 'active', Date.now(), Date.now()]
  );

  // 按生产 shopId 分组，一家店一条 shops 记录
  const byShop = new Map();
  for (const item of items) {
    if (!byShop.has(item.shopId)) byShop.set(item.shopId, []);
    byShop.get(item.shopId).push(item);
  }

  let listingCount = 0;
  let optionCount = 0;
  for (const [shopId, shopItems] of byShop) {
    const first = shopItems[0];
    const [shop] = await conn.query(
      `INSERT INTO shops
        (source_id, identity_hash, public_shop_id, vendor_account_id, vendor_name, vendor_name_normalized,
         title, title_normalized, shop_type, map_name, x, y, status, profile_hash, state_version,
         last_status_observed_at, last_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        SOURCE_ID,
        crypto.createHash('sha256').update(shopId).digest('hex'),
        shopId,
        `ACC-${shopId.slice(-12)}`,
        first.vendorName,
        first.vendorName,
        first.title,
        first.title,
        first.shopType,
        first.mapName,
        first.x,
        first.y,
        'active',
        crypto.createHash('sha256').update(String(first.shopSessionId)).digest('hex'),
        1,
        first.lastChangedAt,
        first.lastChangedAt,
      ]
    );

    for (const item of shopItems) {
      const [listing] = await conn.query(
        `INSERT INTO listings
          (shop_id, item_fingerprint, item_key, item_id, upgrade, slots, card0, card1, card2, card3,
           price, quantity, status, state_version, first_seen_at, last_changed_at, last_changed_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shop.insertId,
          item.itemFingerprint,
          item.itemKey,
          item.itemId,
          item.upgrade,
          item.slots,
          item.cards[0], item.cards[1], item.cards[2], item.cards[3],
          item.price,
          item.quantity,
          'active',
          1,
          item.lastChangedAt,
          item.lastChangedAt,
          'snapshot-production-1',
        ]
      );
      listingCount++;
      for (let i = 0; i < (item.options || []).length; i++) {
        const o = item.options[i];
        await conn.query(
          'INSERT INTO listing_options (listing_id, option_index, option_type, option_value, option_param) VALUES (?, ?, ?, ?, ?)',
          [listing.insertId, i, o.type, o.value, o.param ?? 0]
        );
        optionCount++;
      }
    }
  }

  // 检查抓到的 itemId 在本地 item_catalog（分类数据）中的覆盖率
  const uniqueIds = [...new Set(items.map((i) => i.itemId))];
  const [rows] = await conn.query(
    `SELECT DISTINCT item_id FROM item_catalog WHERE item_id IN (?)`,
    [uniqueIds]
  );
  const covered = new Set(rows.map((r) => Number(r.item_id)));
  const missing = uniqueIds.filter((id) => !covered.has(id));

  console.log(`Done: ${byShop.size} shops, ${listingCount} listings, ${optionCount} options`);
  console.log(`catalog coverage: ${covered.size}/${uniqueIds.length} itemIds 有分类数据`);
  if (missing.length > 0) console.log(`missing itemIds: ${missing.join(', ')}`);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
