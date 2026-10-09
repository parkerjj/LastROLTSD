/**
 * 本地测试数据：按道具分类均匀生成假 shops/listings，
 * 保证每个主要小类都有可检索结果。仅供本地开发，不提交（.gitignore 外的脚本仅开发用）。
 *
 * 用法：node scripts/seed-local.cjs
 */
const mysql = require('mysql2/promise');

const SOURCE_ID = 'local-test';
const MAPS = ['prontera', 'morocc', 'geffen', 'payon', 'alberta', 'izlude', 'aldebaran'];
const VENDORS = ['波利商人', '露天小摊', '初心者商铺', '低价甩卖', '路过的铁匠', '神秘商人', '卡片收藏家'];

async function main() {
  const conn = await mysql.createConnection('mysql://root:root@127.0.0.1:3306/ro_items');

  // 清空旧的本地测试数据
  await conn.query('DELETE FROM shops WHERE source_id = ?', [SOURCE_ID]);
  console.log('Cleared old local-test shops/listings');

  // 确保数据源存在
  await conn.query(
    'INSERT IGNORE INTO market_sources (id, name, api_key_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [SOURCE_ID, '本地测试源', 'a'.repeat(64), 'active', Date.now(), Date.now()]
  );

  // 每个叶子分类取最多 3 个有代表性的道具（优先有中文名的）
  const [groups] = await conn.query(
    `SELECT category_code, type_code,
            GROUP_CONCAT(item_id ORDER BY (name_zh <> '') DESC, item_id SEPARATOR ',') AS ids
     FROM item_catalog
     WHERE category_code <> ''
     GROUP BY category_code, type_CODE`
  );

  const now = Date.now();
  let listingCount = 0;
  let seq = 0;

  for (const group of groups) {
    const ids = String(group.ids).split(',').map(Number).slice(0, 3);
    for (const itemId of ids) {
      seq++;
      const [meta] = await conn.query(
        'SELECT name_zh, name, buy_price FROM item_catalog WHERE item_id = ?',
        [itemId]
      );
      const m = meta[0];
      const baseName = m.name_zh || m.name || `道具${itemId}`;
      const price = m.buy_price > 0
        ? Math.floor(m.buy_price * (0.8 + Math.random() * 0.6))
        : Math.floor(Math.random() * 500000) + 1000;
      const shopType = Math.random() > 0.35 ? 'sell' : 'buy';

      const [shop] = await conn.query(
        `INSERT INTO shops
          (source_id, identity_hash, public_shop_id, vendor_account_id, vendor_name, vendor_name_normalized,
           title, title_normalized, shop_type, map_name, x, y, status, profile_hash, state_version,
           last_status_observed_at, last_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          SOURCE_ID,
          `fake-${itemId}-${seq}`,
          `SHOP-${itemId}-${seq}`,
          `ACC-${1000 + seq}`,
          VENDORS[seq % VENDORS.length],
          VENDORS[seq % VENDORS.length],
          `${baseName}商店`,
          `${baseName}商店`,
          shopType,
          MAPS[seq % MAPS.length],
          50 + (seq % 150),
          50 + ((seq * 7) % 150),
          'active',
          Buffer.from(String(seq).padStart(64, 'b')).toString('hex').slice(0, 64),
          1,
          now,
          now,
        ]
      );

      await conn.query(
        `INSERT INTO listings
          (shop_id, item_fingerprint, item_key, item_id, upgrade, slots, card0, card1, card2, card3,
           price, quantity, status, state_version, first_seen_at, last_changed_at, last_changed_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shop.insertId,
          `fp-${itemId}-${seq}`,
          `key-${itemId}`,
          itemId,
          0,
          0,
          0, 0, 0, 0,
          price,
          1 + (seq % 9),
          'active',
          1,
          now,
          now,
          'snapshot-local-1',
        ]
      );
      listingCount++;
    }
  }

  const [[{ c: shops }]] = await conn.query("SELECT COUNT(*) c FROM shops WHERE source_id = 'local-test'");
  const [[{ c: listings }]] = await conn.query(
    `SELECT COUNT(*) c FROM listings l JOIN shops s ON l.shop_id = s.id WHERE s.source_id = 'local-test'`
  );
  console.log(`Done: ${groups.length} categories, ${shops} shops, ${listings} listings`);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
