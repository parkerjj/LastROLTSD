// pnpm exec vite-node --config vitest.config.ts scripts/benchmark-upload-cpu.mjs
// Local Node CPU only. Synthetic storage excludes MySQL driver/network, TLS and edge billing.
import { createHash } from 'node:crypto';
import * as worker from '../apps/worker/src/index.ts';
import { parseUploadRequest } from '../packages/protocol/src/schema.ts';

const iterations = Number(process.env.BENCHMARK_ITERATIONS ?? 100);
const rounds = Number(process.env.BENCHMARK_ROUNDS ?? 5);
if (!Number.isSafeInteger(iterations) || iterations < 1 || !Number.isSafeInteger(rounds) || rounds < 1) throw new Error('Positive benchmark counts required');
const source = { id: 'benchmark', name: 'Synthetic', api_key_hash: createHash('sha256').update('synthetic').digest('hex'), status: 'active' };
const env = { ENVIRONMENT: 'benchmark', BUILD_VERSION: 'benchmark', MAX_BODY_BYTES: 524288 };

function payload(shops, items, options) {
  return JSON.stringify({ protocol_version: 2, client_run_id: 'benchmark', snapshot_id: 'benchmark', snapshot_mode: 'full',
    part_index: 0, part_count: 2, observed_at: '2026-09-30T00:00:00Z',
    shops: Array.from({ length: shops }, (_, shop) => ({
      uuid: `00000000-0000-4000-8000-${String(shop).padStart(12, '0')}`, shop_status: 'opening',
      vendor_account_id: `vendor-${shop}`, vendor_name: 'Synthetic vendor', title: 'Synthetic shop',
      shop_type: 'sell', map_name: 'prontera', x: shop, y: 100,
      items: Array.from({ length: items }, (_, item) => ({ item_key: `slot-${item}`, item_id: item + 500,
        upgrade: 0, slots: 1, cards: [0, 0, 0, 0], price: 1000, quantity: 2,
        options: Array.from({ length: options }, (_, option) => ({ type: option + 1, value: option + 2, param: 0 })),
      })),
    })),
  });
}

let coldInvocation = 0;
function database(duplicateReceipt, ready, sourceId) {
  const authenticatedSource = { ...source, id: sourceId };
  let receipt = duplicateReceipt;
  let statements = 0;
  let boundBytes = 0;
  const db = {
    async first(sql) {
      statements++;
      if (sql.includes('api_key_hash =')) return authenticatedSource;
      if (sql.includes('FROM market_sources')) return { id: sourceId };
      if (sql.startsWith('SELECT payload_hash')) return duplicateReceipt ? receipt : null;
      if (sql.startsWith('SELECT * FROM market_snapshots')) return { snapshot_id: 'benchmark', client_run_id: 'benchmark',
        observed_at: Date.parse('2026-09-30T00:00:00Z'), part_count: 2, accepted_parts: ready ? 1 : 0, status: 'receiving' };
      return null;
    },
    async run(sql, values = []) {
      statements++;
      for (const value of values) if (typeof value === 'string') boundBytes += Buffer.byteLength(value);
      if (sql.startsWith('INSERT INTO upload_batches')) receipt = { payload_hash: values[5], response_json: values[8] };
      return { affectedRows: 1, insertId: 1 };
    },
    async transaction(work) { return work(db); },
    async close() {},
    counters() { return { statements, boundBytes }; },
  };
  return db;
}

async function http(raw, scenario, duplicateReceipt) {
  const sourceId = scenario === 'full-new-cold' ? `cold-source-${coldInvocation++}` : source.id;
  const db = database(scenario === 'full-duplicate' ? duplicateReceipt : undefined, scenario === 'full-last-part', sourceId);
  const request = new Request('https://example.test/api/v1/market/upload', { method: 'POST',
    headers: { authorization: 'Bearer synthetic', 'idempotency-key': 'benchmark/0', 'cf-ray': 'benchmark-ray' }, body: raw });
  const runtimeEnv = scenario === 'full-last-part' ? { ...env, SNAPSHOT_QUEUE: { async send() {} } } : env;
  const response = typeof worker.fetchUpload === 'function'
    ? await worker.fetchUpload(request, runtimeEnv, db)
    : await worker.createApp(runtimeEnv, db).fetch(request);
  await db.close();
  if (response.status !== 202) throw new Error(`Benchmark failed: ${response.status}: ${await response.text()}`);
  await response.arrayBuffer();
  return db.counters();
}

async function measure(run) {
  for (let index = 0; index < 30; index++) await run();
  const samples = [];
  let counters;
  for (let round = 0; round < rounds; round++) {
    const start = process.cpuUsage();
    for (let index = 0; index < iterations; index++) counters = await run();
    const cpu = process.cpuUsage(start);
    samples.push((cpu.user + cpu.system) / 1000 / iterations);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  return { cpu_ms_samples: samples.map((value) => Number(value.toFixed(3))),
    median_cpu_ms: Number(ordered[Math.floor(ordered.length / 2)].toFixed(3)), ...counters };
}

const results = [];
for (const [name, shops, items, options] of [['small', 10, 10, 2], ['normal', 20, 20, 2], ['large', 50, 40, 2], ['many-options', 10, 50, 20]]) {
  const raw = payload(shops, items, options);
  if (Buffer.byteLength(raw) > env.MAX_BODY_BYTES) throw new Error('Synthetic payload exceeds production byte limit');
  const parsedInput = JSON.parse(raw);
  // Seed retries outside the timed region; both revisions receive the same stored bytes.
  const duplicateReceipt = { payload_hash: createHash('sha256').update(JSON.stringify(parseUploadRequest(parsedInput))).digest('hex'),
    response_json: JSON.stringify({ accepted: true, batch_id: 'benchmark/0', duplicate: false, processed_shops: 0,
      processed_listings: 0, changed_listings: 0, sold_events: 0, next: null, shops: [],
      reconciliation: { status: 'pending', snapshot_id: 'benchmark', stage: 'materialize_parts' } }) };
  for (const scenario of ['validate', 'full-new', 'full-new-cold', 'full-duplicate', 'full-last-part']) {
    const result = await measure(scenario === 'validate' ? async () => { parseUploadRequest(parsedInput); } : () => http(raw, scenario, duplicateReceipt));
    results.push({ size: name, scenario, body_bytes: Buffer.byteLength(raw), shops, items: shops * items, options: shops * items * options, ...result });
  }
}
console.log(JSON.stringify({ runtime: process.version, iterations, rounds,
  entry: typeof worker.fetchUpload === 'function' ? 'direct-upload' : 'createApp',
  note: 'Local Node process CPU, synthetic storage. Not Cloudflare CPU or MySQL/TLS cost. Retry seeding excluded. full-new is warm-cache; full-new-cold changes authenticated source each invocation to force identity cache misses.', results }, null, 2));
