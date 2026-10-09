const mysql = require('mysql2/promise');
const fs = require('fs');
(async () => {
  const items = JSON.parse(fs.readFileSync('apps/web/public/catalog/items.json', 'utf8'));
  const itemIdSet = new Set(items.items.map(i => i.itemId));

  const c = await mysql.createConnection('mysql://root:root@127.0.0.1:3306/ro_items');
  // Get all items that are in items.json but have no rAthena data (name_zh only, no other fields)
  const [all] = await c.query(
    "SELECT item_id, type_code, category_code, name_zh FROM item_catalog WHERE item_id >= 1000000 ORDER BY item_id"
  );
  const customItems = all.filter(r => itemIdSet.has(r.item_id));
  console.log('custom items to append:', customItems.length);

  if (customItems.length === 0) { console.log('nothing to do'); await c.end(); return; }

  const block = '\n-- server-custom items from items.json (not in rAthena source)\n' +
    customItems.map(r => "INSERT IGNORE INTO item_catalog (item_id, type_code, category_code, name_zh) VALUES (" +
      r.item_id + ", '" + r.type_code + "', '" + r.category_code + "', '" +
      r.name_zh.replace(/'/g, "''") + "');").join('\n') + '\n';

  fs.appendFileSync('migrations/mysql/007_item_catalog_data.sql', block);
  console.log('appended to 007_item_catalog_data.sql');

  // Verify total INSERT count
  const sql = fs.readFileSync('migrations/mysql/007_item_catalog_data.sql', 'utf8');
  const totalInserts = (sql.match(/INSERT IGNORE INTO item_catalog /g) || []).length;
  console.log('total item_catalog INSERTs in SQL:', totalInserts);

  const [[t]] = await c.query('SELECT COUNT(*) c FROM item_catalog');
  console.log('total in DB:', t.c);
  await c.end();
})();
