import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const id = 'a'.repeat(32);

function configure(mode = 'hyperdrive', configId = id) {
  const config = join(mkdtempSync(join(tmpdir(), 'lastro-hyperdrive-')), 'wrangler.toml');
  writeFileSync(config, readFileSync(join(root, 'wrangler.toml')));
  const result = spawnSync(process.execPath, [join(root, 'scripts/configure-hyperdrive.mjs'), '--environment', 'production', '--config', config], {
    encoding: 'utf8', env: { ...process.env, MYSQL_CONNECTION_MODE: mode, CLOUDFLARE_HYPERDRIVE_ID: configId },
  });
  // Windows 检出（core.autocrlf=true）会带 CRLF，断言按 LF 文本比较，避免平台相关失败。
  return { ...result, config: readFileSync(config, 'utf8').replace(/\r\n/gu, '\n') };
}

describe('Hyperdrive deployment configuration', () => {
  it('binds the selected ID only in production and defaults deployed environments to Hyperdrive', () => {
    const result = configure();
    expect(result.status, result.stderr).toBe(0);
    expect(result.config).toContain(`[[env.production.hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${id}"`);
    expect(result.config).toContain('[[env.staging.hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "replace-at-deploy"');
    expect(result.config.match(/MYSQL_CONNECTION_MODE = "hyperdrive"/gu)).toHaveLength(2);
  });

  it('removes the production binding when direct mode is explicitly requested', () => {
    const result = configure('direct', '');
    expect(result.status, result.stderr).toBe(0);
    expect(result.config).not.toContain('[[env.production.hyperdrive]]');
    expect(result.config).toContain('[[env.staging.hyperdrive]]');
    expect(result.config.match(/MYSQL_CONNECTION_MODE = "direct"/gu)).toHaveLength(2);
  });

  it.each(['', 'not-an-id', 'a"\ninjected=true'])('rejects missing or invalid IDs without echoing them: %j', (value) => {
    const result = configure('hyperdrive', value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CLOUDFLARE_HYPERDRIVE_ID');
    expect(result.stderr).not.toContain('injected=true');
  });

  it('rejects invalid modes instead of silently selecting a connection', () => {
    const result = configure('typo');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MYSQL_CONNECTION_MODE');
  });
});
