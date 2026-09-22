import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = new URL('../migrations/mysql/', import.meta.url);
const dryRun = process.argv.includes('--dry-run');

try {
  const migrations = await loadMigrations();
  const connection = await mysql.createConnection(parseMysqlUrl(requireMysqlUrl()));
  try {
    await connection.execute('SELECT 1 AS healthy');
    if (dryRun) {
      process.stdout.write(`[mysql-migrate] dry run: ${migrations.length} migration files verified\n`);
    } else {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name VARCHAR(255) NOT NULL,
          checksum CHAR(64) NOT NULL,
          applied_at BIGINT UNSIGNED NOT NULL,
          PRIMARY KEY (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
      `);
      for (const migration of migrations) await applyMigration(connection, migration);
      process.stdout.write(`[mysql-migrate] applied: ${migrations.length} migration files checked\n`);
    }
  } finally {
    await connection.end();
  }
} catch (error) {
  process.stderr.write(`[mysql-migrate] ${safeError(error)}\n`);
  process.exitCode = 1;
}

async function loadMigrations() {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{3,4}_.+\.sql$/u.test(name))
    .sort();
  if (names.length === 0) throw new Error('no MySQL migration files found');
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, migrationsDirectory), 'utf8');
    if (sql.trim() === '') throw new Error(`migration ${name} is empty`);
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

async function applyMigration(connection, migration) {
  const [rows] = await connection.execute('SELECT checksum FROM schema_migrations WHERE name=?', [migration.name]);
  const applied = Array.isArray(rows) ? rows[0] : undefined;
  if (applied) {
    if (applied.checksum !== migration.checksum) throw new Error(`migration checksum mismatch: ${migration.name}`);
    return;
  }

  for (const statement of splitStatements(migration.sql)) await connection.execute(statement);
  await connection.execute('INSERT INTO schema_migrations(name,checksum,applied_at) VALUES (?,?,?)', [migration.name, migration.checksum, Date.now()]);
}

function splitStatements(sql) {
  const statements = [];
  let statement = '';
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const previous = sql[index - 1];
    if ((character === "'" || character === '"' || character === '`') && previous !== '\\') {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === ';' && quote === null) {
      if (statement.trim() !== '') statements.push(statement.trim());
      statement = '';
    } else {
      statement += character;
    }
  }
  if (statement.trim() !== '') statements.push(statement.trim());
  return statements;
}

function requireMysqlUrl() {
  const value = process.env.MYSQL_URL;
  if (!value) throw new Error('MYSQL_URL is required');
  return value;
}

function parseMysqlUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MYSQL_URL must be a valid mysql URL');
  }
  if (url.protocol !== 'mysql:' || !url.hostname || !url.username || url.pathname.length <= 1) {
    throw new Error('MYSQL_URL must include mysql scheme, host, user, and database');
  }
  const ssl = url.searchParams.get('ssl');
  if (ssl !== null && !['true', 'false', '1', '0'].includes(ssl)) throw new Error('MYSQL_URL ssl must be true, false, 1, or 0');
  return {
    host: url.hostname,
    port: url.port === '' ? 3306 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(ssl === 'true' || ssl === '1' ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

function safeError(error) {
  if (error instanceof Error && /^(MYSQL_URL|no MySQL migration files found|migration )/u.test(error.message)) return error.message;
  return 'migration failed';
}
