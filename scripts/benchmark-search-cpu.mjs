import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

// Synthetic database/cache boundaries: measures application CPU, not TCP/TLS,
// MySQL packet parsing, Cloudflare Cache API overhead, or edge CPU accounting.
const server = await createServer({
  configFile: false, server: { middlewareMode: true }, appType: 'custom',
  resolve: { alias: { '@lastroweb/protocol': resolve('packages/protocol/src/index.ts') } },
});
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const originalPool = mysql.createPool;
const originalLog = console.log;
const originalCaches = globalThis.caches;
const rows = Array.from({ length: 21 }, (_, index) => ({
  id: 100 - index, shop_id: 1, item_fingerprint: 'a'.repeat(64), item_key: null,
  item_id: 501, upgrade: 0, slots: 0, card0: 0, card1: 0, card2: 0, card3: 0,
  price: 100, quantity: 1, status: 'active', state_version: 1, missing_full_count: 0,
  last_changed_at: 1000 - index, shop_id_display: 'shop-1', shop_status: 'active',
  shop_key: 'shop-1', title: 'Synthetic shop', vendor_name: 'Synthetic vendor',
  map_name: 'prontera', x: 100, y: 100, shop_type: 'sell',
}));
const options = rows.slice(0, 20).flatMap((row) => [1, 2, 3, 4].map((type) => ({
  listing_id: row.id, option_type: type, option_value: 10, option_param: 0,
})));
const bindings = { ENVIRONMENT: 'test', BUILD_VERSION: 'benchmark', MYSQL_URL: 'mysql://test:synthetic@localhost/test' };
let queries = 0;
mysql.createPool = () => ({
  async execute(sql) {
    queries++;
    return [(sql.includes('FROM listing_options') ? options : rows).map((row) => ({ ...row })), []];
  },
  async end() {},
});
console.log = () => {};
const cache = new Map();
globalThis.caches = { default: {
  async match(request) {
    const cached = cache.get(request.url);
    return cached && new Response(cached.body, { headers: cached.headers });
  },
  async put(request, response) {
    cache.set(request.url, { body: await response.text(), headers: [...response.headers] });
  },
} };

try {
  const { default: worker } = await server.ssrLoadModule('/apps/worker/src/index.ts');
  const search = await server.ssrLoadModule('/apps/worker/src/domain/search.ts');
  const baseUrl = 'https://benchmark.test/api/v1/market/search?limit=20&sort=changed_desc';
  const run = async (url, bypass) => {
    const response = await worker.fetch(new Request(url, { headers: {
      'cf-ray': 'benchmark', ...(bypass ? { 'cache-control': 'no-store' } : {}),
    } }), bindings);
    if (response.status !== 200) throw new Error(`Unexpected status ${response.status}`);
    return response.text();
  };
  const page = JSON.parse(await run(baseUrl, true));
  const nextUrl = `${baseUrl}&cursor=${encodeURIComponent(page.nextCursor)}`;
  const filters = { limit: 20, sort: 'changed_desc', catalogVersion: 'static', optionVersion: 'options-lastro-71.0', searchIndexVersion: 'active-shop-bounded-v1' };
  const cursorWork = () => {
    const context = search.searchCursorContext(filters);
    const cursor = search.encodeCursor({ sort: 'changed_desc', sortValue: 1000, id: 42, context });
    search.decodeCursor(cursor, { context });
  };
  const results = [];
  for (const [name, work, iterations] of [
    ['cursor_context_sign_verify', cursorWork, 20000],
    ['first_page_uncached', () => run(baseUrl, true), 1000],
    ['next_page_uncached', () => run(nextUrl, true), 1000],
    ['repeated_first_page', () => run(baseUrl, false), 1000],
  ]) {
    for (let i = 0; i < 1000; i++) await work();
    const samples = [];
    const beforeQueries = queries;
    for (let trial = 0; trial < 7; trial++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < iterations; i++) await work();
      const cpu = process.threadCpuUsage(start);
      samples.push((cpu.user + cpu.system) / iterations / 1000);
    }
    samples.sort((a, b) => a - b);
    results.push({ name, medianCpuMs: samples[3], minCpuMs: samples[0], maxCpuMs: samples[6], queriesPerInvocation: (queries - beforeQueries) / (7 * iterations) });
  }
  const report = { runtime: process.version, note: 'Local warmed Node thread CPU; synthetic DB and cache; not Cloudflare CPU measurements.', results };
  const json = JSON.stringify(report, null, 2);
  const output = process.argv[2];
  if (output) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json + '\n');
  }
  originalLog(json);
} finally {
  mysql.createPool = originalPool;
  console.log = originalLog;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
  await server.close();
}
