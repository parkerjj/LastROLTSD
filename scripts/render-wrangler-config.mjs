import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? '' : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

try {
  const environment = requiredOption('--environment');
  if (!['staging', 'production'].includes(environment)) throw new Error('--environment must be staging or production');
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(databaseId)) {
    throw new Error('CLOUDFLARE_D1_DATABASE_ID must be a valid UUID');
  }

  const input = resolve(requiredOption('--input'));
  const output = resolve(requiredOption('--output'));
  const source = readFileSync(input, 'utf8');
  const sectionStart = source.indexOf(`[env.${environment}]`);
  if (sectionStart === -1) throw new Error(`wrangler config has no [env.${environment}] section`);
  const nextSection = source.indexOf('\n[env.', sectionStart + 1);
  const sectionEnd = nextSection === -1 ? source.length : nextSection;
  const section = source.slice(sectionStart, sectionEnd);
  const placeholder = 'database_id = "replace-at-deploy"';
  if (section.split(placeholder).length !== 2) {
    throw new Error(`[env.${environment}] must contain exactly one ${placeholder}`);
  }

  const renderedSection = section.replace(placeholder, `database_id = "${databaseId}"`);
  writeFileSync(output, source.slice(0, sectionStart) + renderedSection + source.slice(sectionEnd), 'utf8');
  console.log(`Rendered ${environment} Wrangler config at ${output}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
