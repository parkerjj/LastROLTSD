// 操作日志补数的纯逻辑：IPv4 哈希还原与补数 SQL 生成。不连接数据库、不读写文件，便于单测。
// KE 的 ip_hash 是 SHA-256(IP 字符串)，无盐（见 apps/worker/src/ke/router.ts 的 clientHashes），
// IPv4 只有 2^32 种可能，枚举即可还原；IPv6 空间太大，还原不出来的一律跳过。
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
// Node 24 原生剥离类型，直接引用 Worker 侧的 TS 源文件，避免两处维护关键词表。
import { isHostingOrg } from '../apps/worker/src/activity/hosting.ts';

const IPV4_MAX = 0xffffffff;

function intToIp(value) {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

/** 遍历 [from, to] 内的整数 IPv4，返回 Map<哈希十六进制, IP 文本>。 */
export function reverseIpv4Hashes(targetHexes, { from = 0, to = IPV4_MAX } = {}) {
  const targets = new Set(targetHexes);
  const found = new Map();
  if (targets.size === 0) return found;
  for (let value = from; value <= to; value += 1) {
    const ip = intToIp(value);
    const hex = createHash('sha256').update(ip).digest('hex');
    if (targets.has(hex)) found.set(hex, ip);
  }
  return found;
}

/** 按首段八位组（0–255）把全空间切给多个 worker 线程并行还原。 */
export async function reverseIpv4HashesParallel(targetHexes, threads = availableParallelism()) {
  const targets = [...new Set(targetHexes)];
  const found = new Map();
  if (targets.length === 0) return found;
  let nextOctet = 0;
  const workers = new Set();
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { targets } });
    workers.add(worker);
    let finished = false;
    const dispatch = () => {
      if (nextOctet > 255) {
        finished = true;
        void worker.terminate();
        resolve();
        return;
      }
      worker.postMessage(nextOctet);
      nextOctet += 1;
    };
    worker.on('message', (entries) => {
      for (const [hex, ip] of entries) found.set(hex, ip);
      dispatch();
    });
    worker.on('error', reject);
    // worker 没有 error 事件就退出（被杀、process.exit 等）时也要失败，否则 Promise 会一直挂起。
    worker.on('exit', (code) => {
      if (!finished) reject(new Error(`IPv4 还原线程异常退出（退出码 ${code}）`));
    });
    dispatch();
  });
  try {
    await Promise.all(Array.from({ length: Math.max(1, threads) }, run));
  } finally {
    // 任一线程失败时，其余线程不再有意义，立即终止，避免继续占用 CPU。
    await Promise.all([...workers].map((worker) => worker.terminate()));
  }
  return found;
}

if (!isMainThread && Array.isArray(workerData?.targets)) {
  parentPort.on('message', (octet) => {
    const result = reverseIpv4Hashes(workerData.targets, { from: octet * 2 ** 24, to: octet * 2 ** 24 + 0xffffff });
    parentPort.postMessage([...result.entries()]);
  });
}

// 以 SQL 字面量写入：单引号双写，反斜杠加倍，控制字符换成空格；超长按列宽截断（严格模式下超长会报错）。
function text(value, maxLength) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const cleaned = Array.from(String(value), (char) => (char.charCodeAt(0) < 0x20 || char === '\u007f' ? ' ' : char));
  const clipped = cleaned.slice(0, maxLength).join('');
  return `'${clipped.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function integer(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('backfill value must be a non-negative integer');
  return String(number);
}

function coordinate(value) {
  if (value === null || value === undefined) return 'NULL';
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(6) : 'NULL';
}

const COLUMNS = 'user_id, event, result, ip, ip_net, country, region, city, latitude, longitude, asn, as_org, is_hosting, aid, cid, nid, ref, source, created_at';

// 补数 SQL 经 mysql 命令行执行：固定字符集，并去掉 NO_BACKSLASH_ESCAPES，否则 text() 里加倍的反斜杠会被原样写入。
const PREAMBLE = "SET NAMES utf8mb4;\nSET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '');\n";

/**
 * rows: [{ kind: 'instance'|'token', key, user_id, aid, cid, nid, ip, created_at }]
 * lookups: { city(ip), asn(ip) }，查不到返回 null。
 * 每行一条 INSERT ... SELECT ... WHERE NOT EXISTS（以 ref + source 判重），整段 SQL 可重复执行。
 */
export function buildBackfillSql(rows, lookups) {
  const statements = rows.map((row) => {
    const instance = row.kind === 'instance';
    const ref = `backfill:${instance ? 'ke_instances' : 'ke_tokens'}:${row.key}`;
    const city = lookups.city(row.ip);
    const asn = lookups.asn(row.ip);
    const country = city?.country && /^[A-Za-z]{2}$/u.test(city.country) ? city.country.toUpperCase() : null;
    const values = [
      integer(row.user_id),
      instance ? "'KE_HEARTBEAT'" : "'KE_DEVICE_TOKEN'",
      "'SUCCESS'",
      text(row.ip, 45),
      text(row.ip, 45),
      text(country, 2),
      text(city?.region, 64),
      text(city?.city, 64),
      coordinate(city?.latitude),
      coordinate(city?.longitude),
      integer(asn?.asn),
      text(asn?.as_org, 128),
      isHostingOrg(asn?.as_org ?? null) ? '1' : '0',
      instance ? integer(row.aid) : 'NULL',
      instance ? integer(row.cid) : 'NULL',
      instance ? integer(row.nid) : 'NULL',
      text(ref, 80),
      "'backfill'",
      integer(row.created_at),
    ];
    return `INSERT INTO account_activity_log (${COLUMNS})\nSELECT ${values.join(', ')} FROM DUAL\nWHERE NOT EXISTS (SELECT 1 FROM account_activity_log WHERE ref = ${text(ref, 80)} AND source = 'backfill');`;
  });
  return `${PREAMBLE}${statements.join('\n')}\n`;
}
