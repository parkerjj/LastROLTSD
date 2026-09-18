import { readFile } from 'node:fs/promises';

const document = await readFile(new URL('../docs/api.md', import.meta.url), 'utf8');
const required = [
  '/api/v1/market/upload', '/api/v1/market/search', '/api/v1/options',
  'Authorization: Bearer', 'Idempotency-Key', '512 KiB', '16 parts',
  'snapshot_mode', 'options', 'type', 'value', 'param',
  'first complete full snapshot establishes a baseline', 'duplicate: true',
];
const missing = required.filter((value) => !document.includes(value));
if (missing.length) { console.error(`Missing API contract text: ${missing.join(', ')}`); process.exit(1); }
if (/D:\\openkore|api[_-]?key\s*[:=]\s*['"][^<]/iu.test(document)) { console.error('API document contains a forbidden OpenKore path or credential-like value'); process.exit(1); }
console.log(`API contract check passed (${required.length} assertions)`);
