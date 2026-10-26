// 生成「挂机地图 → 怪物 / 掉落物」预设数据 apps/web/public/ke/map-mobs.json。
// 用途：挂机配置页选择挂机地图后，询问是否把该图所有怪物加入怪物规则、
// 把所有怪物的掉落物品加入拾取物品与物品规则。
//
// 输入来源（均为进阶客户端 main.swbn 提取物的固化副本，见 scripts/data/）：
//   - scripts/data/ke-world-data.json：core/data/world/world-data.json，map → { mobs: 怪物ID[], name, branch, hasBoss }
//   - scripts/data/ke-mob-drops.json：怪物掉落库，mobId → { name, lv, drops: [itemId], mvp: [itemId] }
//
// 输出结构：{ generatedAt, source, maps: { [mapCode]: { mobs: number[], drops: number[] } } }
//   - mobs：该图全部怪物 ID（与 /ke/options.json 的 monsters[].id 对应，前端按 ID 显示中文名）
//   - drops：该图所有怪物常规掉落物 ID 去重并集（不含 MVP 额外奖励——MVP 奖励直接进背包，
//     不掉落在地上，不需要拾取/物品规则）。itemId 与 options.json 的 items[].id 对应。
// 仅包含有怪物的地图（城镇等无怪图不在表中，前端查不到时不弹询问）。
//
// 用法：node scripts/build-ke-map-mobs.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const WORLD_DATA = path.join(SCRIPT_DIR, 'data', 'ke-world-data.json');
const MOB_DROPS = path.join(SCRIPT_DIR, 'data', 'ke-mob-drops.json');
const OUT_JSON = path.join(REPO_ROOT, 'apps', 'web', 'public', 'ke', 'map-mobs.json');

function fail(message) {
  console.error(`[build-ke-map-mobs] ERROR: ${message}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(WORLD_DATA)) fail(`缺少 ${WORLD_DATA}`);
  if (!fs.existsSync(MOB_DROPS)) fail(`缺少 ${MOB_DROPS}`);
  const world = JSON.parse(fs.readFileSync(WORLD_DATA, 'utf8'));
  const mobdb = JSON.parse(fs.readFileSync(MOB_DROPS, 'utf8'));

  const maps = {};
  const missingMobs = new Set();
  for (const [code, info] of Object.entries(world)) {
    const mobs = [...new Set((Array.isArray(info.mobs) ? info.mobs : []).filter((id) => Number.isInteger(id)))];
    if (mobs.length === 0) continue;
    const drops = new Set();
    for (const mob of mobs) {
      const entry = mobdb[mob];
      if (!entry) {
        missingMobs.add(mob);
        continue;
      }
      for (const item of entry.drops ?? []) drops.add(item);
    }
    maps[code] = { mobs, drops: [...drops].sort((a, b) => a - b) };
  }
  if (missingMobs.size > 0) {
    fail(`world-data 中有 ${missingMobs.size} 个怪物 ID 在掉落库中找不到：${[...missingMobs].slice(0, 10).join(',')}`);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      maps: 'scripts/data/ke-world-data.json (from main.swbn core/data/world/world-data.json)',
      drops: 'scripts/data/ke-mob-drops.json (from main.swbn 怪物掉落库)',
    },
    maps,
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload)}\n`);

  const mobTotal = Object.values(maps).reduce((sum, m) => sum + m.mobs.length, 0);
  const dropTotal = new Set(Object.values(maps).flatMap((m) => m.drops)).size;
  console.log(`[build-ke-map-mobs] 地图 ${Object.keys(maps).length} 张，怪物引用 ${mobTotal} 条，掉落物全集 ${dropTotal} 件`);
  console.log(`[build-ke-map-mobs] 已写出 ${OUT_JSON}（${fs.statSync(OUT_JSON).size} bytes）`);
}

main();
