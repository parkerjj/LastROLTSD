import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

function runVerifier(env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync(process.execPath, [resolve(repoRoot, 'scripts', 'verify-worker-mysql.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('Worker MySQL compatibility verifier', () => {
  it('classifies a bundle failure without echoing MYSQL_URL', () => {
    const result = runVerifier({
      MYSQL_URL: 'mysql://user:top-secret@example.test/app',
      WORKER_MYSQL_TEST_RUNNER: JSON.stringify({
        command: process.execPath,
        args: ['-e', "process.stderr.write('Could not resolve long'); process.exit(1)"],
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bundle');
    expect(result.stderr).toContain('dependency_resolution');
    expect(result.stderr).not.toContain('top-secret');
    expect(result.stdout).not.toContain('top-secret');
  });

  it('requires a local Worker readiness signal before reporting success', () => {
    const result = runVerifier({
      WORKER_MYSQL_TEST_RUNNER: JSON.stringify({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      }),
    }, ['--local']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local_startup');
  });

  it('accepts a local Worker only after it reports ready', () => {
    const result = runVerifier({
      WORKER_MYSQL_TEST_RUNNER: JSON.stringify({
        command: process.execPath,
        args: ['-e', "process.stdout.write('Ready on http://127.0.0.1:8787'); setInterval(() => {}, 1_000)"],
      }),
    }, ['--local']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('local: ok');
  });
});
