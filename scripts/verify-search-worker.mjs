import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { build } = require('esbuild');
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const root = fileURLToPath(new URL('..', import.meta.url));
// Exercise the actual Worker/Cache API/native crypto with a synthetic SQL driver.
const bundle = await build({
  stdin: { contents: `
    import mysql from 'mysql2/promise';
    import worker from './apps/worker/src/index';
    let reads = 0;
    let closed = 0;
    mysql.createPool = () => ({
      async execute(sql) {
        reads++;
        if (sql.includes('FROM listing_options')) return [[{ listing_id: 100, option_type: 1, option_value: 10, option_param: 0 }], []];
        return [Array.from({ length: 21 }, (_, i) => ({
          id: 100 - i, shop_id: 1, item_fingerprint: 'a'.repeat(64), item_key: null,
          item_id: 501, upgrade: 0, slots: 0, card0: 0, card1: 0, card2: 0, card3: 0,
          price: 100, quantity: 1, status: 'active', state_version: 1, missing_full_count: 0,
          last_changed_at: 1000 - i, shop_id_display: 'shop-1', shop_status: 'active',
          shop_key: 'shop-1', title: 'Synthetic shop', vendor_name: 'Synthetic vendor',
          map_name: 'prontera', x: 100, y: 100, shop_type: 'sell'
        })), []];
      },
      async end() { closed++; }
    });
    export default { async fetch(request, env) {
      const response = await worker.fetch(request, env);
      response.headers.set('x-test-reads', String(reads));
      response.headers.set('x-test-closed', String(closed));
      return response;
    } };
  `, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
  external: ['node:*'], alias: { '@lastroweb/protocol': './packages/protocol/src/index.ts' },
  plugins: [{ name: 'synthetic-sql-driver', setup(plugin) {
    plugin.onResolve({ filter: /^mysql2\/promise$/ }, () => ({ path: 'mysql2/promise', namespace: 'synthetic-sql' }));
    plugin.onLoad({ filter: /.*/, namespace: 'synthetic-sql' }, () => ({ contents: 'export default { createPool: undefined };' }));
  } }],
});
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-09-18', compatibilityFlags: ['nodejs_compat'],
  bindings: { ENVIRONMENT: 'test', BUILD_VERSION: 'smoke', MYSQL_URL: 'mysql://synthetic:synthetic@localhost/test', CURSOR_SECRET: 'test-cursor-secret-123' },
  log: new Log(LogLevel.ERROR),
}));
try {
  const url = 'https://example.test/api/v1/market/search?limit=20&sort=changed_desc';
  const first = await runtime.dispatchFetch(url, { headers: { 'cf-ray': 'first' } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-search-cache'), 'MISS');
  const page = await first.json();
  assert.equal(page.items.length, 20);
  assert.equal(page.items[0].options[0].display, 'MHP+10');
  assert.equal(typeof page.nextCursor, 'string');
  assert.equal(first.headers.get('x-test-reads'), '2');
  assert.equal(first.headers.get('x-test-closed'), '1');

  const second = await runtime.dispatchFetch(url, { headers: { 'cf-ray': 'second' } });
  assert.equal(second.headers.get('x-search-cache'), 'HIT');
  assert.equal(second.headers.get('x-request-id'), 'second');
  assert.equal(second.headers.get('x-test-reads'), '2');
  assert.equal(second.headers.get('x-test-closed'), '1');
  assert.deepEqual(await second.json(), page);

  const next = await runtime.dispatchFetch(url + '&cursor=' + encodeURIComponent(page.nextCursor));
  assert.equal(next.status, 200);
  assert.equal(next.headers.get('x-test-reads'), '4');
  await next.text();
  const invalid = await runtime.dispatchFetch(url + '&item_id=502&cursor=' + encodeURIComponent(page.nextCursor));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('x-test-reads'), '4');
  await invalid.text();
  console.log('Search workerd smoke passed: native crypto, result/options, cache hit without SQL, request ID, cursor validation.');
} finally {
  await runtime.dispose();
}
