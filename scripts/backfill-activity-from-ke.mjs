// 一次性补数：把 KE 历史 ip_hash（SHA-256(IP)，无盐）还原成明文 IPv4，查归属地 / ASN，生成幂等 SQL 文件。
// 本脚本只做有界只读查询并写出 SQL 文件，绝不执行任何写入；SQL 由人工审阅后再执行，可重复执行（以 ref + source 判重）。
// 用法：MYSQL_URL=... pnpm activity:backfill -- --city-db <dbip-city-lite.mmdb> --asn-db <dbip-asn-lite.mmdb> --out .generated/activity-backfill.sql
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import mmdb from 'mmdb-lib';
import mysql from 'mysql2/promise';
import { buildBackfillSql, reverseIpv4HashesParallel } from './activity-backfill-lib.mjs';

const ROW_LIMIT = 50000;
const INSTANCE_QUERY = `SELECT instance_id, user_id, aid, cid, nid, ip_hash, COALESCE(last_heartbeat_at, updated_at) AS at FROM ke_instances WHERE ip_hash IS NOT NULL LIMIT ${ROW_LIMIT}`;
const TOKEN_QUERY = `SELECT id, user_id, ip_hash, created_at FROM ke_tokens WHERE ip_hash IS NOT NULL LIMIT ${ROW_LIMIT}`;

try {
  const { values } = parseArgs({
    options: {
      'city-db': { type: 'string' },
      'asn-db': { type: 'string' },
      out: { type: 'string', default: '.generated/activity-backfill.sql' },
    },
    allowPositionals: true,
  });
  if (!values['city-db'] || !values['asn-db']) throw new Error('backfill requires --city-db and --asn-db');

  const cityReader = new mmdb.Reader(await readFile(values['city-db']));
  const asnReader = new mmdb.Reader(await readFile(values['asn-db']));
  const lookups = {
    city: (ip) => {
      const record = cityReader.get(ip);
      if (!record) return null;
      return {
        country: record.country?.iso_code ?? null,
        region: record.subdivisions?.[0]?.names?.en ?? null,
        city: record.city?.names?.en ?? null,
        latitude: record.location?.latitude ?? null,
        longitude: record.location?.longitude ?? null,
      };
    },
    asn: (ip) => {
      const record = asnReader.get(ip);
      if (!record) return null;
      return { asn: record.autonomous_system_number ?? null, as_org: record.autonomous_system_organization ?? null };
    },
  };

  const { instances, tokens } = await readRows();
  const hashes = new Set([...instances, ...tokens].map((row) => row.ip_hash.toString('hex')));
  const reversed = await reverseIpv4HashesParallel(hashes);

  const rows = [];
  let skipped = 0;
  for (const row of instances) {
    const ip = reversed.get(row.ip_hash.toString('hex'));
    if (!ip) skipped += 1;
    else rows.push({ kind: 'instance', key: row.instance_id, user_id: row.user_id, aid: row.aid, cid: row.cid, nid: row.nid, ip, created_at: row.at });
  }
  for (const row of tokens) {
    const ip = reversed.get(row.ip_hash.toString('hex'));
    if (!ip) skipped += 1;
    else rows.push({ kind: 'token', key: row.id, user_id: row.user_id, ip, created_at: row.created_at });
  }

  const header = '-- 操作日志补数（由 scripts/backfill-activity-from-ke.mjs 生成）。每条语句以 ref + source 判重，可重复执行。\n';
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, header + buildBackfillSql(rows, lookups));

  const read = instances.length + tokens.length;
  process.stdout.write(`[backfill] rows read: ${read}, reversed: ${read - skipped}, skipped (IPv6 or unknown): ${skipped}, statements written: ${rows.length} -> ${values.out}\n`);
} catch (error) {
  process.stderr.write(`[backfill] ${safeError(error)}\n`);
  process.exitCode = 1;
}

async function readRows() {
  const connection = await mysql.createConnection(parseMysqlUrl(requireMysqlUrl()));
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    const [instances] = await connection.query(INSTANCE_QUERY);
    const [tokens] = await connection.query(TOKEN_QUERY);
    if (instances.length >= ROW_LIMIT || tokens.length >= ROW_LIMIT) throw new Error(`backfill row limit of ${ROW_LIMIT} reached; refusing partial output`);
    return { instances, tokens };
  } finally {
    await connection.end();
  }
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
  if (error instanceof Error && /^(MYSQL_URL|backfill )/u.test(error.message)) return error.message;
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
  return code ? `backfill failed (${code})` : 'backfill failed';
}
