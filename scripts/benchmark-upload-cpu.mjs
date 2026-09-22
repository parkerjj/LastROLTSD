// Run with: pnpm exec vite-node --config vitest.config.ts scripts/benchmark-upload-cpu.mjs
// Synthetic in-memory storage isolates JS preprocessing. This is not edge CPU billing.
import { Hono } from 'hono';
import { registerUploadRoute } from '../apps/worker/src/routes/upload.ts';
import { createListingStateService } from '../apps/worker/src/services/state-transition.ts';

const rounds = 3;
const iterations = 80;
const results = [];
const originalLog = console.log;
let logBytes = 0;
console.log = (value) => { logBytes += Buffer.byteLength(String(value)); };
try {
  for (const scenario of ['heartbeat', 'full-new', 'full-unchanged', 'delta']) {
    const source = { id: 'benchmark', name: 'Synthetic', apiKeyHash: '', status: 'active' };
    const repository = {
      findSourceByApiKeyHash: async () => source,
      getBatch: async () => null,
      insertBatch: async (input) => ({ id: 1, ...input, status: 'processing' }),
      completeBatch: async () => {},
      resolveShopObservations: async (inputs) => inputs.map((input, index) => ({
        internalShopId: index + 1, shopId: input.shopId, identityHash: input.identityHash,
        resolution: 'matched', status: 'opening', applied: true, readListings: scenario !== 'full-unchanged',
        session: { id: index + 1, shopId: index + 1, clientRunId: 'benchmark', startedAt: 1, lastSeenAt: 1, endedAt: null, initialSyncComplete: false, lastCompleteSnapshotId: null },
      })),
      recordSnapshotSessions: async () => {},
      loadListingsByObservations: async () => [],
      insertNewListingsBulk: async () => {},
      markListingsObservedBulk: async () => {},
      updateShopFullStateHashes: async () => {},
      getSnapshotParts: async () => [],
    };
    const mode = scenario.startsWith('full') ? 'full' : scenario;
    const payload = JSON.stringify({
      protocol_version: 2, client_run_id: 'benchmark', snapshot_id: 'benchmark',
      snapshot_mode: mode, part_index: 0, part_count: 2, observed_at: '2026-09-23T00:00:00Z',
      shops: Array.from({ length: 20 }, (_, shop) => ({
        uuid: `00000000-0000-4000-8000-${String(shop).padStart(12, '0')}`,
        shop_status: 'opening', vendor_account_id: `vendor-${shop}`, vendor_name: 'Synthetic vendor',
        title: 'Synthetic shop', shop_type: 'sell', map_name: 'prontera', x: shop, y: 100,
        items: mode === 'heartbeat' ? [] : Array.from({ length: 20 }, (_, item) => ({
          item_key: `slot-${item}`, item_id: item + 500, upgrade: 0, slots: 1, cards: [0, 0, 0, 0],
          price: 1000, quantity: 2, options: [{ type: 9, value: 2, param: 0 }, { type: 1, value: 10, param: 0 }],
        })),
      })),
    });
    const run = async () => {
      const app = new Hono();
      registerUploadRoute(app, { ENVIRONMENT: 'benchmark', BUILD_VERSION: 'benchmark', MAX_BODY_BYTES: 524288 }, repository, createListingStateService(repository));
      const response = await app.request('/api/v1/market/upload', {
        method: 'POST', headers: { authorization: 'Bearer synthetic', 'idempotency-key': 'benchmark/0' }, body: payload,
      });
      if (response.status !== 202) throw new Error(`Benchmark failed: ${response.status}`);
      await response.arrayBuffer();
    };
    for (let i = 0; i < 30; i++) await run();
    const samples = [];
    logBytes = 0;
    for (let round = 0; round < rounds; round++) {
      const start = process.cpuUsage();
      for (let i = 0; i < iterations; i++) await run();
      const cpu = process.cpuUsage(start);
      samples.push((cpu.user + cpu.system) / 1000 / iterations);
    }
    results.push({ scenario, body_bytes: Buffer.byteLength(payload), items: mode === 'heartbeat' ? 0 : 400, node_cpu_ms_samples: samples.map((value) => Number(value.toFixed(3))), log_bytes_per_request: logBytes / (rounds * iterations) });
  }
} finally {
  console.log = originalLog;
}
console.log(JSON.stringify({ runtime: process.version, note: 'Local Node process CPU; no MySQL network/driver or Cloudflare logging transport. Compare relative costs only.', results }, null, 2));
