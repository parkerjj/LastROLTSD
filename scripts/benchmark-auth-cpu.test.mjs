import assert from 'node:assert/strict';
import test from 'node:test';
import { createBenchmarkReport } from './benchmark-auth-cpu.mjs';

test('local CPU and wall samples never imply a production budget pass or expose input secrets', () => {
  const marker = 'SYNTHETIC_SECRET_MARKER';
  const report = createBenchmarkReport({
    metadata: {
      runtime: 'node-v24',
      environment: 'local-test',
      buildSHA: '0123456789abcdef',
      authorization: marker,
      cookie: marker,
      token: marker,
      password: marker,
      base64: marker,
      email: marker,
      secret: marker,
      url: marker,
    },
    scenarios: [{
      name: 'login_hot',
      wallSamplesMs: [0.3, 0.6, 0.9],
      localCpuSamplesMs: [0.2, 0.4, 0.5],
      remoteCpuSamplesMs: [],
      coldConfirmation: 'not_applicable_isolate_unconfirmed',
    }],
  });

  const serialized = JSON.stringify(report);
  assert.equal(report.production_budget.status, 'UNVERIFIED');
  assert.equal(report.scenarios[0].local_cpu_ms.max, 0.5);
  assert.equal(report.scenarios[0].remote_cpu_ms, null);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('UNVERIFIED'), true);
});
