// 登记一台 ke-agent（托管服务器）。没有 HTTP 创建接口：只有能连上数据库的运维才能登记，缩小攻击面。
//   MYSQL_URL=mysql://... node scripts/ke-agent-register.mjs --name vps-1 --pubkey <32 字节 ed25519 公钥 base64url> --max-instances 40
//   加 --dry-run 只打印将要写入的内容。公钥由 `ke-agent enroll` 在 VPS 上生成（私钥不离开 VPS）。
// 输出 agent_id；把它填进 agent 的配置。吊销：UPDATE ke_agents SET status='down', accepting=0 WHERE agent_id=?，并换掉公钥。
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';

/** 控制字符（0x00–0x1f）：用字符码判断，避免 no-control-regex。 */
function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--name') args.name = argv[++index];
    else if (arg === '--pubkey') args.pubkey = argv[++index];
    else if (arg === '--max-instances') args.maxInstances = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (typeof args.name !== 'string' || args.name.length < 1 || args.name.length > 64 || hasControlCharacter(args.name)) throw new Error('--name is required (1-64 chars)');
  if (typeof args.pubkey !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(args.pubkey)) throw new Error('--pubkey must be a 32-byte ed25519 public key in base64url');
  if (!Number.isSafeInteger(args.maxInstances) || args.maxInstances < 1 || args.maxInstances > 500) throw new Error('--max-instances must be 1-500');
  return args;
}

export function buildAgentRow(args, now = Date.now()) {
  const pubkey = Buffer.from(args.pubkey, 'base64url');
  if (pubkey.byteLength !== 32) throw new Error('--pubkey must decode to exactly 32 bytes');
  return {
    agentId: `agt_${randomBytes(12).toString('hex')}`,
    name: args.name,
    pubkey,
    maxInstances: args.maxInstances,
    now,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const row = buildAgentRow(args);
  if (args.dryRun) {
    process.stdout.write(`[ke-agent-register] dry run: would insert ${row.agentId} name=${row.name} max_instances=${row.maxInstances}\n`);
    return;
  }
  const url = process.env.MYSQL_URL;
  if (!url) throw new Error('MYSQL_URL is required');
  const parsed = new URL(url);
  const connection = await mysql.createConnection({
    host: parsed.hostname,
    port: parsed.port === '' ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    ssl: parsed.searchParams.get('ssl') === 'true' || parsed.searchParams.get('ssl') === '1' ? {} : undefined,
  });
  try {
    await connection.execute(
      "INSERT INTO ke_agents (agent_id, name, pubkey, max_instances, status, accepting, created_at, updated_at) VALUES (?, ?, ?, ?, 'online', 1, ?, ?)",
      [row.agentId, row.name, row.pubkey, row.maxInstances, row.now, row.now],
    );
  } finally {
    await connection.end();
  }
  process.stdout.write(`[ke-agent-register] registered ${row.agentId} (${row.name})\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[ke-agent-register] ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
