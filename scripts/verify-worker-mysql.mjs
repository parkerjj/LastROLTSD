import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const stage = process.argv.includes('--local') ? 'local' : 'bundle';
const runner = testRunner() ?? defaultRunner(stage);
if (stage === 'local') {
  const localResult = await runLocal(runner);
  if (localResult.ready) {
    process.stdout.write('[worker-mysql] local: ok\n');
    process.exit(0);
  }
  process.stderr.write(`[worker-mysql] local: ${classifyFailure(localResult.output, 'local_startup')}\n`);
  process.exit(1);
}

const result = spawnSync(runner.command, runner.args, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: process.env,
  shell: false,
});

if (result.status === 0 && !result.error) {
  process.stdout.write('[worker-mysql] bundle: ok\n');
  process.exit(0);
}

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
process.stderr.write(`[worker-mysql] bundle: ${classifyFailure(output, 'command_failed')}\n`);
process.exit(typeof result.status === 'number' && result.status !== 0 ? result.status : 1);

function defaultRunner(selectedStage) {
  const wrangler = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url);
  if (selectedStage === 'local') {
    return { command: process.execPath, args: [fileURLToPath(wrangler), 'dev', '--local'] };
  }
  return { command: process.execPath, args: [fileURLToPath(wrangler), 'deploy', '--dry-run'] };
}

function testRunner() {
  const raw = process.env.WORKER_MYSQL_TEST_RUNNER;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.command !== 'string' || !Array.isArray(parsed.args) || !parsed.args.every((value) => typeof value === 'string')) {
      throw new Error('Invalid test runner');
    }
    return { command: parsed.command, args: parsed.args };
  } catch {
    process.stderr.write('[worker-mysql] verifier: invalid test runner\n');
    process.exit(1);
  }
}

function runLocal(localRunner) {
  return new Promise((resolve) => {
    const child = spawn(localRunner.command, localRunner.args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
    });
    let output = '';
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      resolve({ ready, output });
    };
    const append = (chunk) => {
      output += chunk.toString();
      if (/ready on|listening on|\bready\b/iu.test(output)) finish(true);
    };
    const timeout = setTimeout(() => finish(false), 30_000);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => {
      output += error.message;
      finish(false);
    });
    child.once('close', () => finish(false));
  });
}

function classifyFailure(output, fallback) {
  if (/could not resolve|cannot find module|module not found|failed to resolve/iu.test(output)) return 'dependency_resolution';
  if (/node:(?:net|tls)|tcp|socket/iu.test(output)) return 'runtime_socket';
  return fallback;
}
