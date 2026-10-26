// 操作日志补数脚本：IPv4 哈希还原、SQL 生成，以及在真实 MySQL 上重复执行的幂等性。
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

interface BackfillRow {
  kind: 'instance' | 'token';
  key: string | number;
  user_id: number;
  aid?: number | null;
  cid?: number | null;
  nid?: number | null;
  ip: string;
  created_at: number;
}
interface Lookups {
  city: (ip: string) => { country: string | null; region: string | null; city: string | null; latitude: number | null; longitude: number | null } | null;
  asn: (ip: string) => { asn: number | null; as_org: string | null } | null;
}

const { reverseIpv4Hashes, buildBackfillSql } = await import(new URL('../../scripts/activity-backfill-lib.mjs', import.meta.url).href) as {
  reverseIpv4Hashes: (targets: string[], range?: { from?: number; to?: number }) => Map<string, string>;
  buildBackfillSql: (rows: BackfillRow[], lookups: Lookups) => string;
};

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const ip2int = (ip: string): number => ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);

const noLookups: Lookups = { city: () => null, asn: () => null };

describe('reverseIpv4Hashes', () => {
  it('只还原范围内的 IPv4，IPv6 哈希还原不出来', () => {
    const result = reverseIpv4Hashes([sha256Hex('10.0.0.5'), sha256Hex('2408:8207::1')], {
      from: ip2int('10.0.0.0'),
      to: ip2int('10.0.0.255'),
    });
    expect([...result.entries()]).toEqual([[sha256Hex('10.0.0.5'), '10.0.0.5']]);
  });
});

describe('buildBackfillSql', () => {
  const instance: BackfillRow = { kind: 'instance', key: 'abc-123', user_id: 7, aid: 1, cid: 2, nid: 3, ip: '1.2.3.4', created_at: 1700000000000 };
  const token: BackfillRow = { kind: 'token', key: 42, user_id: 8, ip: '5.6.7.8', created_at: 1700000001000 };

  it('生成幂等 INSERT ... SELECT，事件、ref 与来源符合约定', () => {
    const sql = buildBackfillSql([instance, token], noLookups);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("'backfill:ke_instances:abc-123'");
    expect(sql).toContain("'backfill:ke_tokens:42'");
    expect(sql).toContain("'KE_HEARTBEAT'");
    expect(sql).toContain("'KE_DEVICE_TOKEN'");
    expect(sql).toContain("'backfill'");
    expect(sql.match(/INSERT INTO account_activity_log/gu)).toHaveLength(2);
  });

  it('以固定字符集与去掉 NO_BACKSLASH_ESCAPES 的 sql_mode 开头', () => {
    const sql = buildBackfillSql([instance], noLookups);
    expect(sql.startsWith("SET NAMES utf8mb4;\nSET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '');\n")).toBe(true);
    expect(buildBackfillSql([], noLookups)).toContain('SET NAMES utf8mb4;');
  });

  it('转义单引号，并按 as_org 判定 is_hosting', () => {
    const sql = buildBackfillSql([instance], {
      city: () => null,
      asn: () => ({ asn: 64500, as_org: "O'Reilly Cloud" }),
    });
    expect(sql).toContain("'O''Reilly Cloud'");
    expect(sql).not.toContain("'O'Reilly");
    const hosting = buildBackfillSql([instance], { city: () => null, asn: () => ({ asn: 16509, as_org: 'Amazon.com, Inc.' }) });
    expect(hosting).toMatch(/'Amazon\.com, Inc\.', 1,/u);
  });

  it('lookups 返回 null 时地理与 ASN 字段为 NULL', () => {
    const sql = buildBackfillSql([instance], noLookups);
    expect(sql).toMatch(/'1\.2\.3\.4', '1\.2\.3\.4', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, 2, 3,/u);
  });

  it('写入地理字段并对反斜杠转义', () => {
    const sql = buildBackfillSql([token], {
      city: () => ({ country: 'CN', region: 'Zhe\\jiang', city: '杭州', latitude: 30.2936, longitude: 120.1614 }),
      asn: () => null,
    });
    expect(sql).toContain("'CN', 'Zhe\\\\jiang', '杭州', 30.293600, 120.161400");
  });
});

const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';

describe.skipIf(!runMysqlTests)('补数 SQL × MySQL', () => {
  it('重复执行不会重复写入，且保留原始时间', async () => {
    await withAuthTestDatabase(async ({ database }) => {
      const user = await database.run(
        'INSERT INTO auth_users (email, email_normalized, display_name, status, permission_level, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['u@example.test', 'u@example.test', 'u', 'ACTIVE', 1, 1, 1, 1],
      );
      const rows: BackfillRow[] = [
        { kind: 'instance', key: '11111111-1111-1111-1111-111111111111', user_id: user.insertId, aid: 1, cid: 2, nid: 3, ip: '1.2.3.4', created_at: 1700000000000 },
        { kind: 'token', key: 9, user_id: user.insertId, ip: '5.6.7.8', created_at: 1700000001000 },
      ];
      const sql = buildBackfillSql(rows, {
        city: () => ({ country: 'CN', region: null, city: "Xi'an", latitude: 34.2583, longitude: 108.9286 }),
        asn: () => ({ asn: 16509, as_org: 'Amazon.com, Inc.' }),
      });
      const statements = sql.split(/;\n/u).map((part) => part.trim()).filter((part) => part && !part.startsWith('--'));
      const execute = async (): Promise<void> => {
        for (const statement of statements) await database.run(statement);
      };
      await execute();
      await execute();
      const logged = await database.all<{ ref: string; event: string; ip_net: string; is_hosting: number; city: string | null; created_at: number | string }>(
        'SELECT ref, event, ip_net, is_hosting, city, created_at FROM account_activity_log WHERE source = ? ORDER BY ref',
        ['backfill'],
      );
      expect(logged).toHaveLength(2);
      expect(logged.map((row) => row.event)).toEqual(['KE_HEARTBEAT', 'KE_DEVICE_TOKEN']);
      expect(logged[0]).toMatchObject({ ip_net: '1.2.3.4', is_hosting: 1, city: "Xi'an" });
      expect(Number(logged[0]?.created_at)).toBe(1700000000000);
    });
  });
});
