import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

try {
  const environment = option('--environment');
  if (!['staging', 'production'].includes(environment)) throw new Error('--environment must be staging or production');
  const mode = process.env.MYSQL_CONNECTION_MODE || 'hyperdrive';
  if (!['auto', 'direct', 'hyperdrive'].includes(mode)) throw new Error('MYSQL_CONNECTION_MODE must be auto, direct, or hyperdrive');
  const id = process.env.CLOUDFLARE_HYPERDRIVE_ID ?? '';
  if (mode !== 'direct' && !/^[0-9a-f]{32}$/iu.test(id)) {
    throw new Error('CLOUDFLARE_HYPERDRIVE_ID must be a 32-character hexadecimal ID');
  }

  const config = resolve(option('--config', 'wrangler.toml'));
  let source = readFileSync(config, 'utf8');
  const environmentSection = new RegExp(`(\\[env\\.${environment}\\]\\r?\\n)([\\s\\S]*?)(?=\\n\\[|$)`, 'u');
  const section = environmentSection.exec(source);
  if (!section) throw new Error('Target environment must be declared');
  const bindingSection = new RegExp(`\\[\\[env\\.${environment}\\.hyperdrive\\]\\]\\r?\\nbinding = "HYPERDRIVE"\\r?\\nid = "[^"\\r\\n]+"\\r?\\n`, 'gu');
  if ([...source.matchAll(bindingSection)].length !== 1) throw new Error('Target environment must have exactly one HYPERDRIVE binding');
  source = source.replace(bindingSection, mode === 'direct' ? ''
    : `[[env.${environment}.hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${id}"\n`);
  writeFileSync(config, source, 'utf8');
  console.log(`Configured ${environment} MySQL connection mode: ${mode}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Hyperdrive configuration failed');
  process.exitCode = 1;
}
