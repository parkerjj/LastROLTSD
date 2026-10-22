// 部署后的幂等回填：给「已验证邮箱、却没有拿到验证赠送权益」的账号补发。
// 迁移 017 里的回填只覆盖迁移执行那一刻的存量用户；CI 里从「执行迁移」到「新 Worker 上线」之间，
// 旧 Worker 仍可能让用户完成邮箱验证，这些账号只能在新代码上线后补发。
// 语句直接取自迁移文件，保证与迁移完全一致；唯一键 (user_id, source, source_ref) 保证可以安全地重复执行。
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const MIGRATION = new URL('../migrations/mysql/017_ke_entitlements.sql', import.meta.url);
const MARKER = 'INSERT INTO ke_entitlements';

try {
  const text = await readFile(MIGRATION, 'utf8');
  const start = text.indexOf(MARKER);
  if (start === -1) throw new Error('backfill statement not found in the migration');
  const statement = text.slice(start).trim().replace(/;$/u, '');

  const connection = await mysql.createConnection(parseMysqlUrl(requireMysqlUrl()));
  try {
    const before = await signupRows(connection);
    await connection.query(statement);
    const after = await signupRows(connection);
    process.stdout.write(`[backfill] signup entitlements: ${after - before} added, ${after} total\n`);
  } finally {
    await connection.end();
  }
} catch (error) {
  process.stderr.write(`[backfill] ${safeError(error)}\n`);
  process.exitCode = 1;
}

async function signupRows(connection) {
  const [rows] = await connection.query("SELECT COUNT(*) AS n FROM ke_entitlements WHERE source = 'signup'");
  return Array.isArray(rows) ? Number(rows[0]?.n ?? 0) : 0;
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
  if (error instanceof Error && /^(MYSQL_URL|backfill statement)/u.test(error.message)) return error.message;
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
  return code ? `backfill failed (${code})` : 'backfill failed';
}
