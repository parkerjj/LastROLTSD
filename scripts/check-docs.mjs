import { readFile } from 'node:fs/promises';

const document = await readFile(new URL('../docs/api.md', import.meta.url), 'utf8');
const catalog = await readFile(new URL('../docs/catalog-import.md', import.meta.url), 'utf8');
const operations = await readFile(new URL('../docs/operations.md', import.meta.url), 'utf8');
const deployment = await readFile(new URL('../docs/deployment.md', import.meta.url), 'utf8');
const agent = await readFile(new URL('../agent.md', import.meta.url), 'utf8');
const required = [
  '/api/v1/market/upload', '/api/v1/market/search', '/api/v1/options',
  'Authorization: Bearer', 'Idempotency-Key', '512 KiB', '16 parts',
  'protocol_version": 2', 'snapshot_mode', 'shop_status', 'vendor_account_id', 'uuid', 'options', 'type', 'value', 'param',
  'first complete full snapshot establishes a baseline', 'duplicate: true',
  'GET /api/v1/items', 'item_id', '未知物品 #<item_id>', 'search_short_tokens', 'item-ID `IN` list',
  'dismissed', 'items: []', 'raw option tuples',
];
const missing = required.filter((value) => !document.includes(value));
const catalogRequired = [
  '--input-file', '--input-dir', '--encoding', '--dry-run', 'id#name#',
  'catalog_state', 'inputChecksum', 'dataChecksum', 'outputChecksum', 'does not delete or rewrite listings', 'roll back',
];
const missingCatalog = catalogRequired.filter((value) => !catalog.includes(value));
const operationalRequired = ['Catalog Operations', 'catalog:import', 'PowerShell'];
const missingOperational = operationalRequired.filter((value) => !operations.includes(value));
const deploymentRequired = ['Catalog Release', 'catalog:import', 'wrangler d1 execute', 'PowerShell'];
const missingDeployment = deploymentRequired.filter((value) => !deployment.includes(value));
const agentRequired = [
  '## Remote D1 quota safety',
  '100,000',
  'EXPLAIN QUERY PLAN',
  'catalog_versions.item_count',
  'Never rerun a production import only to verify it',
];
const missingAgent = agentRequired.filter((value) => !agent.includes(value));
const documents = [document, catalog, operations, deployment];
const nonPowerShellCommands = documents.filter((value) => /```(?:bash|sh|shell)/iu.test(value));
const unsafeRemoteCounts = documents.flatMap((value, index) => value.split(/\r?\n/u)
  .filter((line) => /wrangler\s+d1\s+execute\b.*--remote\b.*--command\b.*COUNT\s*\(\s*\*\s*\)/iu.test(line))
  .map((line) => ({ document: ['api.md', 'catalog-import.md', 'operations.md', 'deployment.md'][index], line })));
if (missing.length || missingCatalog.length || missingOperational.length || missingDeployment.length || missingAgent.length) {
  if (missing.length) console.error(`Missing API contract text: ${missing.join(', ')}`);
  if (missingCatalog.length) console.error(`Missing catalog importer text: ${missingCatalog.join(', ')}`);
  if (missingOperational.length) console.error(`Missing operations text: ${missingOperational.join(', ')}`);
  if (missingDeployment.length) console.error(`Missing deployment text: ${missingDeployment.join(', ')}`);
  if (missingAgent.length) console.error(`Missing agent quota rules: ${missingAgent.join(', ')}`);
  process.exit(1);
}
if (nonPowerShellCommands.length) { console.error('Documentation command blocks must use PowerShell'); process.exit(1); }
if (unsafeRemoteCounts.length) {
  for (const unsafe of unsafeRemoteCounts) console.error(`Unsafe remote COUNT(*) in ${unsafe.document}: ${unsafe.line}`);
  process.exit(1);
}
if (/D:\\openkore|api[_-]?key\s*[:=]\s*['"][^<]/iu.test(documents.join('\n'))) { console.error('Documentation contains a forbidden OpenKore path or credential-like value'); process.exit(1); }
if (document.includes('protocol_version": 1') || document.includes('shops_seen') || document.includes('"name": "Example Sword"')) { console.error('API documentation contains the retired upload protocol'); process.exit(1); }
console.log(`Documentation check passed (${required.length + catalogRequired.length + operationalRequired.length + deploymentRequired.length} assertions)`);
