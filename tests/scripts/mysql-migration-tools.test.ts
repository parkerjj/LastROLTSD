import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fixture = resolve(repositoryRoot, 'migrations/mysql/001_initial.sql');

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env };
  delete childEnv.MYSQL_URL;
  Object.assign(childEnv, env);
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

  it('reports a MySQL connection category without exposing the URL password', () => {
    const password = 'test-password-must-not-appear';
    const result = runScript('mysql-migrate.mjs', [], {
      MYSQL_URL: `mysql://test-user:${password}@127.0.0.1:1/test-database`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('database connection failed (ECONNREFUSED)');
    expect(result.stderr).not.toContain(password);
  });

  it('reports a safe importer failure stage without exposing the URL password', () => {
    const password = 'import-password-must-not-appear';
    const directory = mkdtempSync(join(tmpdir(), 'lastroweb-import-'));
    const input = join(directory, 'input.sql');
    writeFileSync(input, 'INSERT INTO sample VALUES (1);\n', 'utf8');
    try {
      const result = runScript('import-mysql.mjs', ['--input', input], {
        MYSQL_URL: `mysql://test-user:${password}@127.0.0.1:1/test-database`,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/import failed during (reading_input|opening_connection|checking_target)/u);
      expect(result.stderr).not.toContain(password);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
