import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [resolve(repoRoot, 'scripts', script), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function parseEnvironmentFile(contents: string): Record<string, string> {
  return Object.fromEntries(contents.split(/\r?\n/u).filter((line) => line && !line.startsWith('#')).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

describe('deployment secret generation', () => {
  it('creates strong local and deployment credentials without printing their values', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'lastroweb-secrets-'));
    const result = runScript('generate-secrets.mjs', ['--output-dir', outputDir]);
    expect(result.status, result.stderr).toBe(0);
    const local = parseEnvironmentFile(readFileSync(join(outputDir, '.dev.vars'), 'utf8'));
    const deployment = parseEnvironmentFile(readFileSync(join(outputDir, '.deployment-secrets.local'), 'utf8'));
    expect(local.ENVIRONMENT).toBe('local');
    expect(local.MAX_BODY_BYTES).toBe('524288');
    expect(local.UPLOAD_API_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(local.CURSOR_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(local.ADMIN_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    for (const environment of ['STAGING', 'PRODUCTION']) {
      const sourceKey = deployment[`${environment}_SOURCE_API_KEY`];
      expect(sourceKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(deployment[`${environment}_CURSOR_SECRET`]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(deployment[`${environment}_ADMIN_SECRET`]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(deployment[`${environment}_SOURCE_API_KEY_SHA256`]).toBe(createHash('sha256').update(sourceKey).digest('hex'));
    }
    const everySecret = [...Object.values(local), ...Object.values(deployment)].filter((value) => value.length >= 32);
    for (const secret of everySecret) expect(result.stdout).not.toContain(secret);
  });

  it('refuses to replace existing secrets unless force is explicit', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'lastroweb-secrets-existing-'));
    const first = runScript('generate-secrets.mjs', ['--output-dir', outputDir]);
    expect(first.status, first.stderr).toBe(0);
    const original = readFileSync(join(outputDir, '.deployment-secrets.local'), 'utf8');
    const second = runScript('generate-secrets.mjs', ['--output-dir', outputDir]);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('already exists');
    expect(readFileSync(join(outputDir, '.deployment-secrets.local'), 'utf8')).toBe(original);
  });
});

describe('Wrangler deployment config rendering', () => {
  const fixture = `name = "lastroweb"\nmain = "apps/worker/src/index.ts"\n\n[env.staging]\nname = "lastroweb-staging"\n[[env.staging.d1_databases]]\ndatabase_id = "replace-at-deploy"\n\n[env.production]\nname = "lastroweb-production"\n[[env.production.d1_databases]]\ndatabase_id = "replace-at-deploy"\n`;

  it('replaces only the selected environment database ID', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'lastroweb-wrangler-'));
    const input = join(outputDir, 'wrangler.toml');
    const output = join(outputDir, 'wrangler.production.toml');
    writeFileSync(input, fixture);
    const databaseId = '123e4567-e89b-12d3-a456-426614174000';
    const result = runScript('render-wrangler-config.mjs', ['--input', input, '--output', output, '--environment', 'production'], { CLOUDFLARE_D1_DATABASE_ID: databaseId });
    expect(result.status, result.stderr).toBe(0);
    const rendered = readFileSync(output, 'utf8');
    expect(rendered).toContain(`[env.staging]\nname = "lastroweb-staging"\n[[env.staging.d1_databases]]\ndatabase_id = "replace-at-deploy"`);
    expect(rendered).toContain(`[env.production]\nname = "lastroweb-production"\n[[env.production.d1_databases]]\ndatabase_id = "${databaseId}"`);
  });

  it.each(['', 'not-a-cloudflare-d1-id'])('rejects a missing or malformed database ID: %j', (databaseId) => {
    const outputDir = mkdtempSync(join(tmpdir(), 'lastroweb-wrangler-invalid-'));
    const input = join(outputDir, 'wrangler.toml');
    const output = join(outputDir, 'wrangler.production.toml');
    writeFileSync(input, fixture);
    const result = runScript('render-wrangler-config.mjs', ['--input', input, '--output', output, '--environment', 'production'], { CLOUDFLARE_D1_DATABASE_ID: databaseId });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CLOUDFLARE_D1_DATABASE_ID');
  });
});

describe('market source seed rendering', () => {
  it('writes an idempotent D1 seed containing only the API key hash', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'lastroweb-source-seed-'));
    const output = join(outputDir, 'source.sql');
    const hash = 'a'.repeat(64);
    const result = runScript('render-source-seed.mjs', ['--output', output], {
      MARKET_SOURCE_ID: 'primary-source',
      MARKET_SOURCE_NAME: "Parker's source",
      MARKET_SOURCE_API_KEY_SHA256: hash,
      MARKET_SOURCE_API_KEY: 'must-not-appear',
    });

    expect(result.status, result.stderr).toBe(0);
    const sql = readFileSync(output, 'utf8');
    expect(sql).toContain("VALUES ('primary-source', 'Parker''s source', '" + hash + "', 'active'");
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(sql).not.toContain('must-not-appear');
  });

  it.each([
    { MARKET_SOURCE_ID: 'bad source', MARKET_SOURCE_API_KEY_SHA256: 'a'.repeat(64) },
    { MARKET_SOURCE_ID: 'primary', MARKET_SOURCE_API_KEY_SHA256: 'not-a-hash' },
  ])('rejects unsafe source seed input %#', (env) => {
    const outputDir = mkdtempSync(join(tmpdir(), 'lastroweb-source-seed-invalid-'));
    const result = runScript('render-source-seed.mjs', ['--output', join(outputDir, 'source.sql')], env);
    expect(result.status).not.toBe(0);
  });
});
