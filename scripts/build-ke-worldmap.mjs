// 从进阶客户端（game.lastro.cn/ro/，roBrowser）内联的 WorldMap.html 模板中提取世界地图选图数据，
// 生成 apps/web/public/ke/worldmap.json，并下载 4 张层级底图到 apps/web/public/ke/worldmap/。
//
// 输入来源：
//   - WorldMap.html：从 %TEMP%\lastro-Online.js 的 define("text!UI/Components/WorldMap/WorldMap.html",...) 提取，
//     若 %TEMP%\WorldMap.html 已存在则直接使用，否则自动从 Online.js 重新提取。
//   - 中文名表：https://game.lastro.cn/ro/client_re/data/mapnametable.txt（GBK 编码）
//   - 底图：https://game.lastro.cn/statics/imgs/worldmap_{n,dimension_n,localizing1_n,localizing2_n}.jpg
//   - 关联地图（branch）：scripts/data/ke-world-branches.json，自进阶客户端 main.swbn 内嵌的
//     core/data/world/world-data.json 提取（字段 branch=该格子点击后可跳转的关联地图，
//     如 tur_dun01 -> tur_dun02/03/04、hu_fild01 -> tha_t01..12/thana_boss），
//     仅保留世界地图 214 个格子中 branch 非空的 34 条。
//
// 格子尺寸（来自 Online.js 内联 CSS，td 为默认 content-box，另有 1px 透明边框）：
//   normal 层 min-width 48 / height 46 → 步进 50x48；其余层 52/50 → 步进 54x52。
//
// 用法：node scripts/build-ke-worldmap.mjs [--skip-download]

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const OUT_JSON = path.join(REPO_ROOT, 'apps', 'web', 'public', 'ke', 'worldmap.json');
const OUT_IMG_DIR = path.join(REPO_ROOT, 'apps', 'web', 'public', 'ke', 'worldmap');
const TMP = os.tmpdir();
const WORLDMAP_HTML = path.join(TMP, 'WorldMap.html');
const ONLINE_JS = path.join(TMP, 'lastro-Online.js');
const BRANCHES_JSON = path.join(SCRIPT_DIR, 'data', 'ke-world-branches.json');

const BASE_IMG_URL = {
  normal: 'https://game.lastro.cn/statics/imgs/worldmap_n.jpg',
  dimension: 'https://game.lastro.cn/statics/imgs/worldmap_dimension_n.jpg',
  localizing1: 'https://game.lastro.cn/statics/imgs/worldmap_localizing1_n.jpg',
  localizing2: 'https://game.lastro.cn/statics/imgs/worldmap_localizing2_n.jpg',
};
const MAPNAME_URL = 'https://game.lastro.cn/ro/client_re/data/mapnametable.txt';

// td 步进 = CSS min-width/height + 两侧各 1px 透明边框（content-box）。
const CELL_SIZE = {
  normal: { cellW: 50, cellH: 48 },
  dimension: { cellW: 54, cellH: 52 },
  localizing1: { cellW: 54, cellH: 52 },
  localizing2: { cellW: 54, cellH: 52 },
};

const skipDownload = process.argv.includes('--skip-download');

function fail(message) {
  console.error(`[build-ke-worldmap] ERROR: ${message}`);
  process.exit(1);
}

// 从 Online.js 中提取 WorldMap.html 模板字符串并反转义 \xNN / \uNNNN。
function extractWorldMapHtml(bundleText) {
  const marker = 'define("text!UI/Components/WorldMap/WorldMap.html",[],function(){return';
  const start = bundleText.indexOf(marker);
  if (start < 0) fail('Online.js 中找不到 WorldMap.html 模块标记');
  let i = start + marker.length;
  while (i < bundleText.length && bundleText[i] !== '"' && bundleText[i] !== "'") i += 1;
  if (i >= bundleText.length) fail('WorldMap.html 模块后未找到字符串字面量');
  const quote = bundleText[i];
  i += 1;
  let out = '';
  while (i < bundleText.length) {
    const ch = bundleText[i];
    if (ch === quote) return out;
    if (ch === '\\') {
      const next = bundleText[i + 1];
      if (next === 'x') {
        out += String.fromCharCode(parseInt(bundleText.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      if (next === 'u') {
        out += String.fromCharCode(parseInt(bundleText.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      if (next === 'n') { out += '\n'; i += 2; continue; }
      if (next === 't') { out += '\t'; i += 2; continue; }
      if (next === 'r') { out += '\r'; i += 2; continue; }
      out += next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  fail('WorldMap.html 模板字符串未闭合');
}

function loadWorldMapHtml() {
  if (fs.existsSync(WORLDMAP_HTML)) {
    console.log(`[build-ke-worldmap] 使用已提取的 ${WORLDMAP_HTML}`);
    return fs.readFileSync(WORLDMAP_HTML, 'utf8');
  }
  if (!fs.existsSync(ONLINE_JS)) fail(`缺少 ${WORLDMAP_HTML} 且 ${ONLINE_JS} 不存在，无法提取`);
  console.log(`[build-ke-worldmap] 从 ${ONLINE_JS} 重新提取 WorldMap.html`);
  const html = extractWorldMapHtml(fs.readFileSync(ONLINE_JS, 'utf8'));
  fs.writeFileSync(WORLDMAP_HTML, html);
  return html;
}

function parseAttrs(attrText) {
  const attrs = {};
  const re = /([\w-]+)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(attrText)) !== null) {
    attrs[m[1]] = m[2] === undefined ? '' : m[2];
  }
  return attrs;
}

// 解析一层 table：返回 { cols, rows, points }。
function parseTable(tableBody) {
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(tableBody)) !== null) {
    rows.push(tr[1]);
  }
  const points = [];
  let cols = 0;
  rows.forEach((rowHtml, rowIndex) => {
    const tdRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/g;
    let td;
    let col = 0;
    while ((td = tdRe.exec(rowHtml)) !== null) {
      const attrs = parseAttrs(td[1]);
      const inner = td[2];
      const span = attrs.colspan ? parseInt(attrs.colspan, 10) : 1;
      const dataMap = attrs['data-map'];
      if (dataMap !== undefined && dataMap !== '') {
        // id="map_a b c" 的一格多码情形（tur_dun 等）；cave 格 data-map="Mhtmltip" 需用 id 里的真实码。
        let codes = null;
        if (attrs.id && attrs.id.startsWith('map_')) {
          codes = attrs.id.slice(4).split(/\s+/).filter(Boolean);
        }
        if (!codes || codes.length === 0) codes = [dataMap];
        const code = dataMap === 'Mhtmltip' ? codes[0] : dataMap;
        const point = { code, row: rowIndex, col, span };
        if (codes.length > 1) point.codes = codes;
        if (/<span\b[^>]*class="mvpMap"/.test(inner)) point.mvp = true;
        points.push(point);
      }
      col += span;
    }
    cols = Math.max(cols, col);
  });
  return { cols, rows: rows.length, points };
}

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`下载失败 ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// 格子小图来自进阶客户端内嵌清单指向的静态目录（main.swbn 资源清单 source 字段）
const TILE_BASE = 'https://game.lastro.cn/statics/imgs/map/s';
const TILE_DIR = path.join(OUT_IMG_DIR, 'tiles');

/** 下载全部格子小图（含 branch 关联地图），返回下载数 */
async function downloadTiles(layers) {
  const codes = new Set();
  for (const layer of layers) {
    for (const p of layer.points) {
      for (const c of p.codes ?? [p.code]) {
        if (c !== 'Mhtmltip') codes.add(c);
      }
    }
  }
  fs.mkdirSync(TILE_DIR, { recursive: true });
  let downloaded = 0;
  for (const code of [...codes].sort()) {
    const buf = await fetchBytes(`${TILE_BASE}/${code}.png`);
    if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) fail(`格子图不是合法 PNG: ${code}`);
    fs.writeFileSync(path.join(TILE_DIR, `${code}.png`), buf);
    downloaded += 1;
  }
  return downloaded;
}

async function main() {
  const html = loadWorldMapHtml();

  // 层级名称来自 <select class="mapblock"> 的 option 顺序（与 table 的 data-index 对应）。
  const selectMatch = html.match(/<select class="mapblock">([\s\S]*?)<\/select>/);
  if (!selectMatch) fail('找不到 <select class="mapblock">');
  const layerNames = [...selectMatch[1].matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1].trim());
  if (layerNames.length !== 4) fail(`层级数量应为 4，实际 ${layerNames.length}`);

  const tableRe = /<table[^>]*class="bigworld (\w+)" data-index=(\d)>([\s\S]*?)<\/table>/g;
  const tables = [];
  let tm;
  while ((tm = tableRe.exec(html)) !== null) {
    tables.push({ id: tm[1], index: parseInt(tm[2], 10), body: tm[3] });
  }
  tables.sort((a, b) => a.index - b.index);
  if (tables.length !== 4) fail(`bigworld 表格数量应为 4，实际 ${tables.length}`);

  // 中文名表（GBK）：行格式 [N@]code.rsw#名称# 或 code.gat#名称#，同名先出现者优先。
  const nameBuf = await fetchBytes(MAPNAME_URL);
  const nameText = new TextDecoder('gbk').decode(nameBuf);
  const names = new Map();
  for (const line of nameText.split(/\r?\n/)) {
    const m = line.match(/^(?:\d+@)?([A-Za-z0-9_]+)\.(?:rsw|gat)#(.*)#$/);
    if (!m) continue;
    if (!names.has(m[1])) names.set(m[1], m[2]);
  }
  console.log(`[build-ke-worldmap] 中文名表条目：${names.size}`);

  // 关联地图（branch）：格子点击后的二级选项，来自客户端 world-data.json。
  if (!fs.existsSync(BRANCHES_JSON)) fail(`缺少关联地图数据 ${BRANCHES_JSON}`);
  const branches = JSON.parse(fs.readFileSync(BRANCHES_JSON, 'utf8'));
  console.log(`[build-ke-worldmap] 关联地图数据条目：${Object.keys(branches).length}`);

  const layers = [];
  const missingNames = [];
  for (const table of tables) {
    const size = CELL_SIZE[table.id];
    if (!size) fail(`未知层级 id：${table.id}`);
    const { cols, rows, points } = parseTable(table.body);
    for (const point of points) {
      const zh = names.get(point.code);
      if (zh) {
        point.name = zh;
      } else {
        missingNames.push(`${table.id}:${point.code}`);
      }
      // branch 优先于 HTML 一格多码（tur_dun01 两者一致），统一为 codes = [本图, ...branch]
      const branch = branches[point.code];
      if (Array.isArray(branch) && branch.length > 0) {
        point.codes = [point.code, ...branch.filter((c) => c !== point.code)];
      }
      if (point.codes) {
        point.codeNames = {};
        for (const c of point.codes) {
          const n = names.get(c);
          if (n) point.codeNames[c] = n;
        }
      }
    }
    layers.push({
      id: table.id,
      name: layerNames[table.index],
      image: `/ke/worldmap/${table.id}.jpg`,
      cols,
      rows,
      cellW: size.cellW,
      cellH: size.cellH,
      points,
    });
  }

  if (!skipDownload) {
    fs.mkdirSync(OUT_IMG_DIR, { recursive: true });
    for (const layer of layers) {
      const buf = await fetchBytes(BASE_IMG_URL[layer.id]);
      const outPath = path.join(OUT_IMG_DIR, `${layer.id}.jpg`);
      fs.writeFileSync(outPath, buf);
      console.log(`[build-ke-worldmap] 底图 ${layer.id}.jpg <- ${buf.length} bytes`);
    }
    const tileCount = await downloadTiles(layers);
    console.log(`[build-ke-worldmap] 格子图 ${tileCount} 张`);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      worldmapHtml: 'https://game.lastro.cn/ro/Online.js (text!UI/Components/WorldMap/WorldMap.html)',
      mapNames: MAPNAME_URL,
      images: BASE_IMG_URL,
      branches: 'scripts/data/ke-world-branches.json (from main.swbn core/data/world/world-data.json)',
    },
    layers,
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

  // 摘要：便于人工核验。
  let totalPoints = 0;
  let totalMvp = 0;
  for (const layer of layers) {
    totalPoints += layer.points.length;
    totalMvp += layer.points.filter((p) => p.mvp).length;
    const multi = layer.points.filter((p) => p.codes);
    console.log(
      `[build-ke-worldmap] 层 ${layer.id}（${layer.name}）：${layer.cols}x${layer.rows} 格，`
      + `点位 ${layer.points.length}，mvp ${layer.points.filter((p) => p.mvp).length}`
      + (multi.length > 0 ? `，一格多码 ${multi.map((p) => p.codes.join('/')).join('、')}` : ''),
    );
  }
  console.log(`[build-ke-worldmap] 总点位 ${totalPoints}，总 mvp ${totalMvp}`);
  if (missingNames.length > 0) {
    console.log(`[build-ke-worldmap] 警告：${missingNames.length} 个点位无中文名（将回退为代码）：`);
    console.log(`  ${missingNames.slice(0, 20).join(', ')}${missingNames.length > 20 ? ' ...' : ''}`);
  }
  console.log(`[build-ke-worldmap] 已写出 ${OUT_JSON}（${fs.statSync(OUT_JSON).size} bytes）`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
