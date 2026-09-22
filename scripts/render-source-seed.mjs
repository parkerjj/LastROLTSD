import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? '' : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const escapeSql = (value) => value.replaceAll("'", "''");

try {
  const sourceId = process.env.MARKET_SOURCE_ID ?? 'primary';
  const sourceName = process.env.MARKET_SOURCE_NAME ?? 'Primary market source';
  const apiKeyHash = process.env.MARKET_SOURCE_API_KEY_SHA256 ?? '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(sourceId)) {
    throw new Error('MARKET_SOURCE_ID must be 1-64 letters, numbers, underscores, or hyphens');
  }
  if (sourceName.length < 1 || sourceName.length > 100) throw new Error('MARKET_SOURCE_NAME must be 1-100 characters');
  if (!/^[0-9a-f]{64}$/u.test(apiKeyHash)) throw new Error('MARKET_SOURCE_API_KEY_SHA256 must be 64 lowercase hex characters');
  const now = Date.now();
  const sql = [
    'INSERT INTO market_sources (id, name, api_key_hash, status, created_at, updated_at)',
    `VALUES ('${escapeSql(sourceId)}', '${escapeSql(sourceName)}', '${apiKeyHash}', 'active', ${now}, ${now})`,
    'ON DUPLICATE KEY UPDATE',
    '  name = VALUES(name),',
    '  api_key_hash = VALUES(api_key_hash),',
    "  status = 'active',",
    '  updated_at = VALUES(updated_at);',
    '',
  ].join('\n');
  const output = resolve(requiredOption('--output'));
  writeFileSync(output, sql, { encoding: 'utf8', mode: 0o600 });
  console.log(`Rendered market source seed at ${output}. The API key was not read or written.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
