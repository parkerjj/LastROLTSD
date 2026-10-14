import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCENARIO_NAMES = new Set([
  'login_cold_first_entry',
  'login_hot',
  'register_password_5_unicode',
  'register_password_256_unicode',
  'profile',
  'me',
  'refresh',
  'avatar_32kib',
  'register_body_64kib_plus_1',
  'password_change',
  'password_reset_request',
  'password_reset_confirm',
  'single_mail_send',
  'cleanup_50_expired_sessions',
]);

const COLD_CONFIRMATIONS = new Map([
  ['first_worker_module_import_inside_vitest_isolate_unconfirmed', 'First Worker module import was included inside an already-started Vitest process; Node/Vitest startup and Cloudflare isolate cold state are unconfirmed.'],
  ['subsequent_local_entry_request_isolate_unconfirmed', 'Worker module was already loaded; Cloudflare isolate cold state is unconfirmed.'],
  ['not_applicable_isolate_unconfirmed', 'Not applicable; Cloudflare isolate cold state is unconfirmed.'],
]);

export function createBenchmarkReport(input) {
  if (!input || typeof input !== 'object' || !input.metadata || !Array.isArray(input.scenarios)) {
    throw new Error('invalid benchmark input');
  }

  const scenarios = input.scenarios.map((scenario) => {
    if (!scenario || typeof scenario !== 'object' || !SCENARIO_NAMES.has(scenario.name)) {
      throw new Error('invalid benchmark input');
    }
    const wallSamples = finiteSamples(scenario.wallSamplesMs);
    const localCpuSamples = finiteSamples(scenario.localCpuSamplesMs);
    const remoteCpuSamples = finiteSamples(scenario.remoteCpuSamplesMs ?? []);
    if (wallSamples.length === 0
      || (localCpuSamples.length > 0 && localCpuSamples.length !== wallSamples.length)
      || (remoteCpuSamples.length > 0 && remoteCpuSamples.length !== wallSamples.length)) {
      throw new Error('invalid benchmark input');
    }
    const confirmation = COLD_CONFIRMATIONS.get(scenario.coldConfirmation)
      ?? COLD_CONFIRMATIONS.get('not_applicable_isolate_unconfirmed');

    return {
      name: scenario.name,
      sample_count: wallSamples.length,
      cold_confirmation: confirmation,
      wall_ms: summarize(wallSamples),
      local_cpu_ms: localCpuSamples.length > 0 ? summarize(localCpuSamples) : null,
      remote_cpu_ms: remoteCpuSamples.length > 0 ? summarize(remoteCpuSamples) : null,
    };
  });

  return {
    schema_version: 1,
    metadata: {
      runtime: safeRuntime(input.metadata.runtime),
      environment: 'node-local-dedicated-test-database',
      build_sha: safeBuildSha(input.metadata.buildSHA),
      database_version: safeDatabaseVersion(input.metadata.databaseVersion),
      cpu_source: 'Node process.cpuUsage() around the local Worker entry and Response body read; not Cloudflare CPU.',
      remote_cpu_source: null,
    },
    scenarios,
    production_budget: {
      status: 'UNVERIFIED',
      reason: 'No full Cloudflare invocation cpuTimeMs measurements were supplied; local wall and Node CPU cannot establish the production budget.',
    },
  };
}

function finiteSamples(value) {
  if (!Array.isArray(value) || value.some((sample) => typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0)) {
    throw new Error('invalid benchmark input');
  }
  return value;
}

function summarize(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  const at = (quantile) => ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
  return {
    p50: rounded(at(0.5)),
    p99: rounded(at(0.99)),
    max: rounded(ordered.at(-1)),
  };
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function safeRuntime(value) {
  return typeof value === 'string' && /^v\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][A-Za-z0-9.-]+)?$/u.test(value)
    ? value
    : 'unknown';
}

function safeBuildSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value) ? value : 'unknown';
}

function safeDatabaseVersion(value) {
  return typeof value === 'string' && /^8\.4\.5(?:[-+][A-Za-z0-9.-]+)?$/u.test(value) ? value : 'unknown';
}

function validateLocalTestEnvironment(environment) {
  if (environment.MYSQL_URL !== undefined && environment.MYSQL_URL !== '') return 'MYSQL_URL is forbidden for this benchmark';
  if (environment.REQUIRE_AUTH_MYSQL_TESTS !== '1') return 'REQUIRE_AUTH_MYSQL_TESTS=1 is required';
  if (environment.AUTH_TEST_DB_ALLOW_RESET !== '1') return 'AUTH_TEST_DB_ALLOW_RESET=1 is required';
  if (typeof environment.MYSQL_TEST_URL !== 'string' || environment.MYSQL_TEST_URL.length === 0) return 'MYSQL_TEST_URL is required';
  try {
    const url = new URL(environment.MYSQL_TEST_URL);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || Number(url.port) !== 13306
      || !database.toLowerCase().endsWith('_test')) {
      return 'MYSQL_TEST_URL must target the dedicated local _test database';
    }
  } catch {
    return 'MYSQL_TEST_URL must target the dedicated local _test database';
  }
  return null;
}

function safeReport(report) {
  if (!report || report.schema_version !== 1 || report.production_budget?.status !== 'UNVERIFIED'
    || !Array.isArray(report.scenarios) || report.metadata?.environment !== 'node-local-dedicated-test-database') return false;
  return report.scenarios.every((scenario) => SCENARIO_NAMES.has(scenario.name)
    && Number.isSafeInteger(scenario.sample_count)
    && scenario.sample_count > 0
    && scenario.remote_cpu_ms === null);
}

async function runBenchmark() {
  if (process.argv.length !== 2) {
    process.stderr.write('[auth-bench] no input arguments are accepted\n');
    process.exitCode = 1;
    return;
  }
  const environmentError = validateLocalTestEnvironment(process.env);
  if (environmentError) {
    process.stderr.write(`[auth-bench] ${environmentError}\n`);
    process.exitCode = 1;
    return;
  }

  const buildResult = spawnSync('rtk', ['git', 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const buildSHA = buildResult.status === 0 ? buildResult.stdout.trim() : 'unknown';
  const tempDirectory = await mkdtemp(join(tmpdir(), 'lastroweb-auth-cpu-'));
  const reportPath = join(tempDirectory, 'report.json');
  try {
    const run = spawnSync('pnpm', [
      'exec', 'vitest', 'run', 'tests/integration/auth-worker-cpu-benchmark.test.ts',
      '--maxWorkers=1', '--no-file-parallelism',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTH_CPU_BENCHMARK: '1',
        AUTH_CPU_BUILD_SHA: buildSHA,
        AUTH_CPU_BENCHMARK_REPORT: reportPath,
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.error || run.status !== 0) {
      process.stderr.write('[auth-bench] local Worker/MySQL runner failed; detailed output was withheld\n');
      process.exitCode = 1;
      return;
    }

    let rawReport;
    try {
      rawReport = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch {
      process.stderr.write('[auth-bench] local runner did not produce a valid report\n');
      process.exitCode = 1;
      return;
    }
    let report;
    try {
      report = createBenchmarkReport(rawReport);
    } catch {
      process.stderr.write('[auth-bench] local runner produced invalid metrics\n');
      process.exitCode = 1;
      return;
    }
    if (!safeReport(report)) {
      process.stderr.write('[auth-bench] local runner produced an invalid or unsafe report\n');
      process.exitCode = 1;
      return;
    }
    const summary = `${run.stdout}${run.stderr}`;
    const counts = summary.match(/Tests\s+\d+\s+passed/iu)?.[0] ?? 'Vitest runner passed';
    process.stderr.write(`[auth-bench] ${counts}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await runBenchmark();
