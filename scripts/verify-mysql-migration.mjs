import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

const tables = ['market_sources', 'shops', 'listings', 'listing_options', 'listing_events', 'upload_batches'];
const expectedPath = option('--expected-counts');

try {
  const expected = expectedPath ? JSON.parse(await readFile(resolve(expectedPath), 'utf8')) : undefined;
  const connection = await mysql.createConnection(parseMysqlUrl(requireMysqlUrl()));
  try {
    const [databaseRows] = await connection.execute('SELECT DATABASE() AS database_name');
    if (!Array.isArray(databaseRows) || databaseRows[0]?.database_name === null) throw new Error('target database is not selected');
    const summary = {};
    for (const table of tables) summary[table] = await countTable(connection, table);
    await assertUnique(connection, 'listing_events', 'transition_key');
    await assertCompositeUnique(connection, 'upload_batches', 'source_id', 'batch_id');
    const foreignKeys = await foreignKeyCount(connection);
    const nullable = await nullableCounts(connection);
    const samples = await chineseSamples(connection);
    if (expected) assertExpected(summary, expected);
    process.stdout.write(`${JSON.stringify({ tables: summary, foreign_keys: foreignKeys, nullable, chinese_samples: samples }, null, 2)}\n`);
  } finally {
    await connection.end();
  }
} catch (error) {
  process.stderr.write(`[mysql-verify] ${safeError(error)}\n`);
  process.exitCode = 1;
}

async function countTable(connection, table) {
  const [countRows] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
  const [maxRows] = table === 'market_sources'
    ? [[]]
    : await connection.query(`SELECT MAX(id) AS max_id FROM \`${table}\``);
  return { count: Number(countRows[0]?.count ?? 0), ...(table === 'market_sources' ? {} : { max_id: Number(maxRows[0]?.max_id ?? 0) }) };
}

async function assertUnique(connection, table, column) {
  const [rows] = await connection.query(`SELECT COUNT(*) AS total, COUNT(DISTINCT \`${column}\`) AS distinct_count FROM \`${table}\``);
  if (Number(rows[0]?.total) !== Number(rows[0]?.distinct_count)) throw new Error(`${table}.${column} is not unique`);
}

async function assertCompositeUnique(connection, table, first, second) {
  const [rows] = await connection.query(`SELECT COUNT(*) AS total, COUNT(DISTINCT CONCAT(\`${first}\`, ':', \`${second}\`)) AS distinct_count FROM \`${table}\``);
  if (Number(rows[0]?.total) !== Number(rows[0]?.distinct_count)) throw new Error(`${table} idempotency key is not unique`);
}

async function foreignKeyCount(connection) {
  const [rows] = await connection.execute(`SELECT COUNT(*) AS count FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND constraint_type='FOREIGN KEY'`);
  return Number(rows[0]?.count ?? 0);
}

async function nullableCounts(connection) {
  const [rows] = await connection.query(`SELECT
    (SELECT COUNT(*) FROM upload_batches WHERE response_json IS NULL) AS null_batch_response_json,
    (SELECT COUNT(*) FROM upload_batches WHERE completed_at IS NULL) AS null_batch_completed_at,
    (SELECT COUNT(*) FROM listings WHERE item_key IS NULL) AS null_listing_item_key`);
  return rows[0] ?? {};
}

async function chineseSamples(connection) {
  const [rows] = await connection.execute("SELECT id,title FROM shops WHERE title REGEXP '[一-龥]' ORDER BY id LIMIT 3");
  return Array.isArray(rows) ? rows.map((row) => ({ id: Number(row.id), title: row.title })) : [];
}

function assertExpected(summary, expected) {
  for (const table of tables) {
    if (expected[table] !== undefined && Number(expected[table]) !== summary[table].count) throw new Error(`row count mismatch for ${table}`);
  }
}

function requireMysqlUrl() { if (!process.env.MYSQL_URL) throw new Error('MYSQL_URL is required'); return process.env.MYSQL_URL; }
function parseMysqlUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'mysql:' || !url.hostname || !url.username || url.pathname.length < 2) throw new Error();
    return { host: url.hostname, port: url.port === '' ? 3306 : Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), ...(url.searchParams.get('ssl') === 'true' || url.searchParams.get('ssl') === '1' ? { ssl: { rejectUnauthorized: true } } : {}) };
  } catch { throw new Error('MYSQL_URL must be a valid mysql URL'); }
}
function option(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
function safeError(error) { return error instanceof Error && /^(MYSQL_URL|target database|row count mismatch|listing_events|upload_batches)/u.test(error.message) ? error.message : 'verification failed'; }
