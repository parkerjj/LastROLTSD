import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fixture = resolve(repositoryRoot, 'migrations/mysql/001_initial.sql');

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.MYSQL_URL;
  return spawnSync(process.execPath, [resolve(repositoryRoot, 'scripts', script), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: childEnv,
  });
}

describe('MySQL migration operation tools', () => {
  it('requires MYSQL_URL before importing SQL', () => {
    const result = runScript('import-mysql.mjs', ['--input', fixture]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MYSQL_URL');
  });

  it('requires an explicit confirmation before allowing replacement', () => {
    const result = runScript('import-mysql.mjs', ['--input', fixture, '--replace-existing']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--confirm-replace-existing');
  });

  it('does not print Cloudflare tokens while validating export arguments', () => {
    const result = runScript('export-d1.mjs', ['--output', resolve(repositoryRoot, '.generated/test-d1-export.sql')], {
      CLOUDFLARE_API_TOKEN: 'do-not-print',
    });

    expect(result.stdout).not.toContain('do-not-print');
    expect(result.stderr).not.toContain('do-not-print');
  });
});
