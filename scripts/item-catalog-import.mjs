#!/usr/bin/env node
/**
 * 从 rAthena 道具宽表 CSV 生成：
 * 1. migrations/mysql/007_item_catalog_data.sql  — 29,356 条 INSERT 数据
 * 2. apps/web/public/catalog/item-categories.json — 前端分类树（taxonomy）
 *
 * 用法：
 *   node scripts/item-catalog-import.mjs --input-file E:\LastROLTSD\ro-items-full.csv --version rathena-20261004
 *   node scripts/item-catalog-import.mjs --dry-run --input-file ... --version ...
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--dry-run') flags.add(token);
    else if (token.startsWith('--')) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      values.set(token, value);
      i++;
    } else throw new Error(`unexpected argument: ${token}`);
  }
  const inputFile = values.get('--input-file');
  if (!inputFile) throw new Error('--input-file is required');
  const version = values.get('--version') ?? 'rathena-unknown';
  return { inputFile, version, dryRun: flags.has('--dry-run') };
}

// ── CSV 解析（支持引号内含逗号/换行/双引号） ───────────────────────────────

function parseCSV(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length < 2) throw new Error('CSV has no data rows');
  const headers = splitCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // 处理跨行引号字段
    let full = line;
    while (true) {
      const quoteCount = (full.match(/"/g) ?? []).length;
      if (quoteCount % 2 === 0) break;
      if (i + 1 >= lines.length) throw new Error(`CSV unterminated quote at line ${i + 1}`);
      full += '\n' + lines[++i];
    }
    const values = splitCSVLine(full);
    if (values.length !== headers.length) throw new Error(`CSV line ${i + 1}: expected ${headers.length} columns, got ${values.length}`);
    rows.push(Object.fromEntries(headers.map((h, idx) => [h, values[idx]])));
  }
  return rows;
}

function splitCSVLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      values.push(current);
      current = '';
    } else current += ch;
  }
  if (quoted) throw new Error('unterminated quoted field');
  values.push(current);
  return values;
}

// ── 分类树定义（dvg 口径） ──────────────────────────────────────────────────

const ITEM_TYPES = [
  { code: 'Weapon',      nameZh: '武器',       sortOrder: 1 },
  { code: 'Armor',       nameZh: '防具',       sortOrder: 2 },
  { code: 'Card',        nameZh: '卡片',       sortOrder: 3 },
  { code: 'Shadowgear',  nameZh: '影子装备',   sortOrder: 4 },
  { code: 'Ammo',        nameZh: '弹药',       sortOrder: 5 },
  { code: 'Petarmor',    nameZh: '宠物装备',   sortOrder: 6 },
  { code: 'Healing',     nameZh: '恢复道具',   sortOrder: 7 },
  { code: 'Usable',      nameZh: '消耗道具',   sortOrder: 8 },
  { code: 'DelayConsume',nameZh: '延迟消耗道具', sortOrder: 9 },
  { code: 'Cash',        nameZh: '商城道具',   sortOrder: 10 },
  { code: 'Etc',         nameZh: '其他道具',   sortOrder: 11 },
  { code: 'Petegg',      nameZh: '宠物蛋',     sortOrder: 12 },
];

// (type_code, 筛选分类) → 子分类 code
const CATEGORY_SLUGS = {
  'Weapon:Dagger':        'dagger',
  'Weapon:1hSword':       '1h_sword',
  'Weapon:2hSword':       '2h_sword',
  'Weapon:1hSpear':       '1h_spear',
  'Weapon:2hSpear':       '2h_spear',
  'Weapon:1hAxe':         '1h_axe',
  'Weapon:2hAxe':         '2h_axe',
  'Weapon:Mace':          'mace',
  'Weapon:Staff':         'staff',
  'Weapon:2hStaff':       '2h_staff',
  'Weapon:Bow':           'bow',
  'Weapon:Knuckle':       'knuckle',
  'Weapon:Musical':       'musical',
  'Weapon:Whip':          'whip',
  'Weapon:Book':          'book',
  'Weapon:Katar':         'katar',
  'Weapon:Revolver':      'revolver',
  'Weapon:Rifle':         'rifle',
  'Weapon:Gatling':       'gatling',
  'Weapon:Shotgun':       'shotgun',
  'Weapon:Grenade':       'grenade',
  'Weapon:Huuma':         'huuma',
  'Weapon:Shuriken':      'shuriken',
  'Weapon:Throwweapon':   'throwweapon',
  'Weapon:Kunai':         'kunai',
  'Armor:头饰(上)':       'head_top',
  'Armor:头饰(中)':       'head_mid',
  'Armor:头饰(下)':       'head_low',
  'Armor:头饰(上中下)':   'head_top_mid_low',
  'Armor:头饰(上中)':     'head_top_mid',
  'Armor:头饰(中下)':     'head_mid_low',
  'Armor:头饰(上下)':     'head_top_low',
  'Armor:铠甲':           'armor',
  'Armor:盾牌':           'shield',
  'Armor:披肩':           'garment',
  'Armor:鞋子':           'shoes',
  'Armor:装饰品':         'accessory',
  'Armor:时装头饰(上)':   'costume_head_top',
  'Armor:时装头饰(中)':   'costume_head_mid',
  'Armor:时装头饰(下)':   'costume_head_low',
  'Armor:时装头饰(上中)': 'costume_head_top_mid',
  'Armor:时装头饰(上中下)': 'costume_head_top_mid_low',
  'Armor:时装头饰(中上)': 'costume_head_mid_top',
  'Armor:时装头饰(中下)': 'costume_head_mid_low',
  'Armor:时装头饰(上下)': 'costume_head_top_low',
  'Armor:时装披风':       'costume_garment',
  'Card:卡片-武器':       'card_weapon',
  'Card:卡片-铠甲':       'card_armor',
  'Card:卡片-盾牌':       'card_shield',
  'Card:卡片-披肩':       'card_garment',
  'Card:卡片-鞋子':       'card_shoes',
  'Card:卡片-头盔':       'card_headgear',
  'Card:卡片-饰品':       'card_accessory',
  'Card:卡片-其他':       'card_other',
  'Card:附魔卡':          'card_enchant',
  'Shadowgear:影子武器':  'shadow_weapon',
  'Shadowgear:影子铠甲':  'shadow_armor',
  'Shadowgear:影子盾牌':  'shadow_shield',
  'Shadowgear:影子鞋子':  'shadow_shoes',
  'Shadowgear:影子耳环':  'shadow_earring',
  'Shadowgear:影子吊坠':  'shadow_pendant',
  'Ammo:Arrow':           'arrow',
  'Ammo:Bullet':          'bullet',
  'Ammo:Cannonball':      'cannonball',
  'Ammo:CannonBall':      'cannonball',
  'Ammo:Kunai':           'ammo_kunai',
  'Ammo:Shuriken':        'ammo_shuriken',
  'Ammo:Throwweapon':     'ammo_throwweapon',
  'Ammo:Dagger':          'ammo_dagger',
  'Ammo:Grenade':         'ammo_grenade',
};

// 小类中文名（用于前端显示）
const CATEGORY_NAMES_ZH = {
  'dagger': '短剑', '1h_sword': '单手剑', '2h_sword': '双手剑',
  '1h_spear': '单手矛', '2h_spear': '双手矛', '1h_axe': '单手斧', '2h_axe': '双手斧',
  'mace': '钝器', 'staff': '单手杖', '2h_staff': '双手杖', 'bow': '弓',
  'knuckle': '拳套', 'musical': '乐器', 'whip': '鞭子', 'book': '书籍',
  'katar': '拳刃', 'revolver': '左轮', 'rifle': '来福', 'gatling': '格林',
  'shotgun': '散弹', 'grenade': '榴弹', 'huuma': '风魔飞镖',
  'shuriken': '手里剑', 'throwweapon': '投掷武器', 'kunai': '苦无',
  'head_top': '头饰(上)', 'head_mid': '头饰(中)', 'head_low': '头饰(下)',
  'head_top_mid_low': '头饰(上中下)', 'head_top_mid': '头饰(上中)',
  'head_mid_low': '头饰(中下)', 'head_top_low': '头饰(上下)',
  'armor': '铠甲', 'shield': '盾牌', 'garment': '披肩', 'shoes': '鞋子',
  'accessory': '装饰品',
  'costume_head_top': '时装头饰(上)', 'costume_head_mid': '时装头饰(中)',
  'costume_head_low': '时装头饰(下)', 'costume_head_top_mid': '时装头饰(上中)',
  'costume_head_top_mid_low': '时装头饰(上中下)', 'costume_head_mid_top': '时装头饰(中上)',
  'costume_head_mid_low': '时装头饰(中下)', 'costume_head_top_low': '时装头饰(上下)',
  'costume_garment': '时装披风',
  'card_weapon': '卡片-武器', 'card_armor': '卡片-铠甲', 'card_shield': '卡片-盾牌',
  'card_garment': '卡片-披肩', 'card_shoes': '卡片-鞋子', 'card_headgear': '卡片-头盔',
  'card_accessory': '卡片-饰品', 'card_enchant': '附魔卡', 'card_other': '卡片-其他',
  'shadow_weapon': '影子武器', 'shadow_armor': '影子铠甲', 'shadow_shield': '影子盾牌',
  'shadow_shoes': '影子鞋子', 'shadow_earring': '影子耳环', 'shadow_pendant': '影子吊坠',
  'arrow': '箭矢', 'bullet': '子弹', 'cannonball': '炮弹',
  'ammo_kunai': '苦无', 'ammo_shuriken': '手里剑', 'ammo_throwweapon': '投掷武器',
  'ammo_dagger': '飞刀', 'ammo_grenade': '榴弹弹药',
};

// ── 数值工具 ────────────────────────────────────────────────────────────────

function intVal(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function boolVal(v) {
  const s = String(v ?? '').trim();
  return s === '是' || s === '1' || s === 'true' ? 1 : 0;
}

function strVal(v) {
  return String(v ?? '').trim().replace(/\r\n?/g, '\n');
}

// ── SQL 转义 ────────────────────────────────────────────────────────────────

function escSql(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = resolve(args.inputFile);
  const raw = await readFile(csvPath, 'utf8');
  // 去掉 BOM
  const text = raw.replace(/^\uFEFF/, '');
  const rows = parseCSV(text);

  // 收集分类树
  const typeMap = new Map(); // type_code → { nameZh, sortOrder, leaves: Map<code, nameZh> }
  for (const t of ITEM_TYPES) typeMap.set(t.code, { ...t, leaves: new Map() });

  const items = [];
  let skipped = 0;

  for (const row of rows) {
    const typeCode = strVal(row['类型代码']);
    const categoryLabel = strVal(row['筛选分类']);
    const subCode = strVal(row['子类型代码']);
    const itemId = intVal(row['item_id']);
    if (!itemId || !typeCode) { skipped++; continue; }

    // 叶子分类 code
    let categoryCode = '';
    if (typeCode === 'Weapon' || typeCode === 'Ammo') {
      categoryCode = CATEGORY_SLUGS[`${typeCode}:${subCode}`] ?? '';
      if (!categoryCode) {
        console.warn(`未映射的子类型: ${typeCode}:${subCode} (item_id=${itemId})`);
        skipped++;
        continue;
      }
    } else if (typeCode === 'Armor' || typeCode === 'Card' || typeCode === 'Shadowgear') {
      categoryCode = CATEGORY_SLUGS[`${typeCode}:${categoryLabel}`] ?? '';
      if (!categoryCode) {
        console.warn(`未映射的筛选分类: ${typeCode}:${categoryLabel} (item_id=${itemId})`);
        skipped++;
        continue;
      }
    } else {
      // 无小类的 7 个大类（Etc/Usable/...）：category_code 直接用大类 code，
      // 既满足 NOT NULL，也满足 item_categories 外键（对应同名自指分类行）。
      categoryCode = typeCode;
    }

    const typeEntry = typeMap.get(typeCode);
    if (!typeEntry) {
      console.warn(`未知类型代码: ${typeCode} (item_id=${itemId})`);
      skipped++;
      continue;
    }
    // 只有真正的叶子分类进分类树；自指分类不进 leaves（前端小类下拉保持禁用）
    if (categoryCode !== typeCode && !typeEntry.leaves.has(categoryCode)) {
      typeEntry.leaves.set(categoryCode, CATEGORY_NAMES_ZH[categoryCode] ?? categoryCode);
    }

    items.push({
      itemId,
      name: strVal(row['名称(英文)']),
      nameZh: strVal(row['名称(中文)']),
      typeCode,
      categoryCode,
      buy: intVal(row['购买价格(Zeny)']),
      sell: intVal(row['出售价格(Zeny)']),
      weight: intVal(row['重量']),
      attack: intVal(row['攻击力']),
      magicAttack: intVal(row['魔法攻击力']),
      defense: intVal(row['防御力']),
      range: intVal(row['攻击距离']),
      slots: intVal(row['插槽数']),
      weaponLevel: intVal(row['武器等级']),
      armorLevel: intVal(row['防具等级']),
      equipLevelMin: intVal(row['最低装备等级']),
      equipLevelMax: intVal(row['最高装备等级']),
      refineable: boolVal(row['可精炼']),
      gradable: boolVal(row['可分级(Gradable)']),
      view: strVal(row['View(外观)']),
      jobs: strVal(row['可装备职业']),
      classes: strVal(row['职业阶级']),
      gender: strVal(row['装备性别']),
      location: strVal(row['装备部位']),
      description: strVal(row['描述(中文,已清洗)']) || null,
      script: strVal(row['使用/装备脚本']) || null,
      equipScript: strVal(row['装备时脚本']) || null,
      unequipScript: strVal(row['卸下脚本']) || null,
      stackAmount: intVal(row['可堆叠数量']),
      bindOnEquip: boolVal(row['装备绑定']),
      uniqueItem: boolVal(row['唯一堆叠(UniqueId)']),
      noConsume: boolVal(row['使用不消耗']),
      delayDuration: intVal(row['使用延迟(秒)']),
      tradeNoDrop: boolVal(row['可丢弃']) === 0 ? 1 : 0,
      tradeNoTrade: boolVal(row['可交易']) === 0 ? 1 : 0,
      tradeNoSell: boolVal(row['可出售NPC']) === 0 ? 1 : 0,
      tradeNoCart: boolVal(row['可放手推车']) === 0 ? 1 : 0,
      tradeNoStorage: boolVal(row['可存仓']) === 0 ? 1 : 0,
      tradeNoGuildStorage: boolVal(row['可存公会仓']) === 0 ? 1 : 0,
      tradeNoMail: boolVal(row['可邮寄']) === 0 ? 1 : 0,
      tradeNoAuction: boolVal(row['可拍卖']) === 0 ? 1 : 0,
      tradePartner: boolVal(row['可交易给伴侣']),
      buyingStore: boolVal(row['可露天收购']),
      aliasName: strVal(row['AliasName(外观别名)']),
      iconSmall: strVal(row['小图标URL']),
      iconLarge: strVal(row['大图标URL']),
      dvgUrl: strVal(row['dvg详情页']),
      sourceFile: strVal(row['rAthena来源文件']),
    });
  }

  // ── 生成 SQL ──────────────────────────────────────────────────────────────

  const now = Math.floor(Date.now() / 1000);
  const version = args.version;

  const sqlLines = [];
  sqlLines.push('-- item_types');
  for (const t of ITEM_TYPES) {
    sqlLines.push(`INSERT IGNORE INTO item_types (code, name_zh, sort_order) VALUES (${escSql(t.code)}, ${escSql(t.nameZh)}, ${t.sortOrder});`);
  }

  sqlLines.push('\n-- item_categories');
  for (const t of ITEM_TYPES) {
    const entry = typeMap.get(t.code);
    let sortOrder = 0;
    for (const [code, nameZh] of entry.leaves) {
      sortOrder++;
      sqlLines.push(`INSERT IGNORE INTO item_categories (code, type_code, name_zh, sort_order) VALUES (${escSql(code)}, ${escSql(t.code)}, ${escSql(nameZh)}, ${sortOrder});`);
    }
    // 无小类的大类插一条同名自指分类，作为该类道具 category_code 的外键目标
    if (entry.leaves.size === 0) {
      sqlLines.push(`INSERT IGNORE INTO item_categories (code, type_code, name_zh, sort_order) VALUES (${escSql(t.code)}, ${escSql(t.code)}, ${escSql(t.nameZh)}, 1);`);
    }
  }

  sqlLines.push('\n-- item_catalog');
  for (const item of items) {
    sqlLines.push(
      `INSERT IGNORE INTO item_catalog (item_id, name, name_zh, type_code, category_code, buy_price, sell_price, weight, attack, magic_attack, defense, \`range\`, slots, weapon_level, armor_level, equip_level_min, equip_level_max, refineable, gradable, view, jobs, classes, gender, location, description, script, equip_script, unequip_script, stack_amount, bind_on_equip, unique_item, no_consume, delay_duration, trade_no_drop, trade_no_trade, trade_no_sell, trade_no_cart, trade_no_storage, trade_no_guild_storage, trade_no_mail, trade_no_auction, trade_partner, buying_store, alias_name, icon_small, icon_large, dvg_url, source_file, catalog_version, created_at, updated_at) VALUES (${item.itemId}, ${escSql(item.name)}, ${escSql(item.nameZh)}, ${escSql(item.typeCode)}, ${escSql(item.categoryCode)}, ${item.buy}, ${item.sell}, ${item.weight}, ${item.attack}, ${item.magicAttack}, ${item.defense}, ${item.range}, ${item.slots}, ${item.weaponLevel}, ${item.armorLevel}, ${item.equipLevelMin}, ${item.equipLevelMax}, ${item.refineable}, ${item.gradable}, ${escSql(item.view)}, ${escSql(item.jobs)}, ${escSql(item.classes)}, ${escSql(item.gender)}, ${escSql(item.location)}, ${escSql(item.description)}, ${escSql(item.script)}, ${escSql(item.equipScript)}, ${escSql(item.unequipScript)}, ${item.stackAmount}, ${item.bindOnEquip}, ${item.uniqueItem}, ${item.noConsume}, ${item.delayDuration}, ${item.tradeNoDrop}, ${item.tradeNoTrade}, ${item.tradeNoSell}, ${item.tradeNoCart}, ${item.tradeNoStorage}, ${item.tradeNoGuildStorage}, ${item.tradeNoMail}, ${item.tradeNoAuction}, ${item.tradePartner}, ${item.buyingStore}, ${escSql(item.aliasName)}, ${escSql(item.iconSmall)}, ${escSql(item.iconLarge)}, ${escSql(item.dvgUrl)}, ${escSql(item.sourceFile)}, ${escSql(version)}, ${now}, ${now});`
    );
  }

  // ── 生成分类树 JSON ────────────────────────────────────────────────────────

  // 全部 12 个大类都输出；7 个无小类的大类 leaves 为空数组（前端只按大类筛选）
  const taxonomy = ITEM_TYPES
    .map((t) => {
      const entry = typeMap.get(t.code);
      return {
        code: t.code,
        nameZh: t.nameZh,
        sortOrder: t.sortOrder,
        leaves: [...entry.leaves.entries()].map(([code, nameZh], idx) => ({
          code, nameZh, sortOrder: idx + 1,
        })),
      };
    });

  const categoryTree = { version, taxonomy };

  // ── 单文件输出 ─────────────────────────────────────────────────────────────

  const sqlContent = sqlLines.join('\n') + '\n';
  const treeContent = JSON.stringify(categoryTree, null, 2) + '\n';

  if (args.dryRun) {
    console.log(`dry-run: items=${items.length} skipped=${skipped} types=${ITEM_TYPES.length} categories=${taxonomy.reduce((s, t) => s + t.leaves.length, 0) + taxonomy.filter((t) => t.leaves.length === 0).length} (含自指)`);
    console.log(`  sqlBytes=${Buffer.byteLength(sqlContent, 'utf8')} treeBytes=${Buffer.byteLength(treeContent, 'utf8')}`);
    for (const t of taxonomy) {
      console.log(`  ${t.code} (${t.nameZh}): ${t.leaves.map((l) => l.nameZh).join(', ')}`);
    }
    return;
  }

  const sqlPath = resolve(__dirname, '../migrations/mysql/007_item_catalog_data.sql');
  const treePath = resolve(__dirname, '../apps/web/public/catalog/item-categories.json');
  await mkdir(dirname(sqlPath), { recursive: true });
  await mkdir(dirname(treePath), { recursive: true });
  await writeFile(sqlPath, sqlContent, 'utf8');
  await writeFile(treePath, treeContent, 'utf8');

  console.log(`written: items=${items.length} skipped=${skipped}`);
  console.log(`  sql  → ${sqlPath}`);
  console.log(`  tree → ${treePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
