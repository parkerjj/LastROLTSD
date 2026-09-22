import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareD1DumpOutput } from './d1-export-path.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const database = option('--database');
const output = option('--output');

try {
  if (!database || !output) throw new Error('usage: --database <d1-name> --output <dump.sql>');
  const outputPath = resolve(output);
  if (existsSync(outputPath)) throw new Error('refusing to overwrite an existing D1 dump');
  if (!isIgnored(outputPath)) throw new Error('D1 dump output must be an ignored path');
  await prepareD1DumpOutput(outputPath);
  runWrangler(['whoami']);
  runWrangler(['d1', 'export', database, '--remote', `--output=${outputPath}`]);
  process.stdout.write('[d1-export] export completed\n');
} catch (error) {
  process.stderr.write(`[d1-export] ${safeError(error)}\n`);
  process.exitCode = 1;
}

function runWrangler(args) {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8', env: process.env, shell: false });
  if (result.status !== 0 || result.error) throw new Error('Cloudflare credential or D1 export command failed');
}

function isIgnored(outputPath) {
  const result = spawnSync('git', ['check-ignore', '-q', outputPath], { cwd: root, encoding: 'utf8', shell: false });
  return result.status === 0 || dirname(outputPath).includes(`${resolve(root, '.generated')}`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function safeError(error) {
  if (error instanceof Error && /^(usage:|refusing|D1 dump output|Cloudflare credential)/u.test(error.message)) return error.message;
  return 'D1 export failed';
}
