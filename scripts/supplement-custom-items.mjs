/**
 * 扫描 items.json 中所有 item_id，把 item_catalog 缺失的补录进去。
 * 类型推断规则：
 *   魔物蛋 / 怪物蛋 → Petegg
 *   [时装] / 转蛋 / 扭蛋 → Cash
 *   放大镜 → Usable
 *   金币 / 代币 → Etc
 *   其余 2M+ → Etc（默认兜底）
 * 同时追加到数据 SQL 文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function inferType(name) {
  if (/魔物蛋|怪物蛋/.test(name)) return 'Petegg';
  if (/^\[时装\]|转蛋|扭蛋/.test(name)) return 'Cash';
  if (/放大镜/.test(name)) return 'Usable';
  if (/金币|代币/.test(name)) return 'Etc';
  return 'Etc';
}

function escSql(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function main() {
  const itemsJson = JSON.parse(fs.readFileSync('apps/web/public/catalog/items.json', 'utf8'));
  const allIds = itemsJson.items.map((i) => i.itemId);

  const c = await mysql.createConnection('mysql://root:root@127.0.0.1:3306/ro_items');
  const [existing] = await c.query('SELECT item_id FROM item_catalog WHERE item_id IN (?)', [allIds]);
  const existingSet = new Set(existing.map((r) => Number(r.item_id)));

  const missing = itemsJson.items.filter((i) => !existingSet.has(i.itemId));
  console.log(`items.json: ${allIds.length} ids, already in catalog: ${existingSet.size}, missing: ${missing.length}`);

  if (missing.length === 0) {
    console.log('nothing to supplement');
    await c.end();
    return;
  }

  // 插入本地库
  const inserts = [];
  for (const item of missing) {
    const type = inferType(item.name);
    inserts.push({ itemId: item.itemId, name: item.name, type });
    await c.query(
      'INSERT IGNORE INTO item_catalog (item_id, type_code, category_code, name_zh) VALUES (?,?,?,?)',
      [item.itemId, type, type, item.name]
    );
  }
  console.log(`inserted ${inserts.length} items`);
  console.log(inserts.slice(0, 20).map((i) => `${i.itemId}:${i.name}:${i.type}`).join('\n'));
  if (inserts.length > 20) console.log(`... and ${inserts.length - 20} more`);

  // 追加到数据 SQL
  const sqlPath = path.join(__dirname, '..', 'migrations', 'mysql', '007_item_catalog_data.sql');
  let sql = fs.readFileSync(sqlPath, 'utf8');
  const block = `\n-- server-custom items from items.json (not in rAthena source)\n` +
    inserts.map((i) =>
      `INSERT IGNORE INTO item_catalog (item_id, type_code, category_code, name_zh) VALUES (${i.itemId}, ${escSql(i.type)}, ${escSql(i.type)}, ${escSql(i.name)});`
    ).join('\n') + '\n';

  if (sql.includes('-- server-custom items from items.json')) {
    sql = sql.replace(/-- server-custom items from items\.json[\s\S]*$/, block);
  } else {
    sql += block;
  }
  fs.writeFileSync(sqlPath, sql);
  console.log(`SQL updated: ${sqlPath}`);

  const [[total]] = await c.query('SELECT COUNT(*) c FROM item_catalog');
  console.log('item_catalog total:', total.c);
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
