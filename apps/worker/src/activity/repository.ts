import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import type { ActivityEvent, ActivityRecord, ActivityResult, ActivityRow } from './types';

// 关联统计允许的列。列名只来自这份白名单，绝不拼接用户输入。
export type ActivityHeatField = 'ip_net' | 'device_id' | 'fingerprint';
const HEAT_COLUMNS: Record<ActivityHeatField, string> = {
  ip_net: 'ip_net',
  device_id: 'device_id',
  fingerprint: 'fingerprint',
};

const RECORD_COLUMNS =
  'id, user_id, event, result, ip, ip_net, country, region, city, latitude, longitude, asn, as_org, is_hosting, device_id, fingerprint, user_agent, aid, cid, nid, ref, source, request_id, created_at';

export interface ActivityRepository {
  insert(row: ActivityRow): Promise<void>;
  latestIpNetForRef(ref: string): Promise<{ ip_net: string | null } | null>;
  /** 按时间升序返回最近 limit 条；更早还有记录时 truncated 为 true。 */
  listForUser(userId: number, limit: number): Promise<{ records: ActivityRecord[]; truncated: boolean }>;
  /** COUNT(DISTINCT user_id)。 */
  countUsers(field: ActivityHeatField, value: string): Promise<number>;
  /** 删除 created_at < before 的行，单批最多 batchSize 行，返回删除行数。 */
  cleanup(before: number, batchSize: number): Promise<number>;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readRecord(row: MysqlRow): ActivityRecord {
  return {
    id: asNumber(row.id),
    user_id: asNumber(row.user_id),
    event: String(row.event) as ActivityEvent,
    result: String(row.result) as ActivityResult,
    ip: asNullableString(row.ip),
    ip_net: asNullableString(row.ip_net),
    country: asNullableString(row.country),
    region: asNullableString(row.region),
    city: asNullableString(row.city),
    latitude: asNullableNumber(row.latitude),
    longitude: asNullableNumber(row.longitude),
    asn: asNullableNumber(row.asn),
    as_org: asNullableString(row.as_org),
    is_hosting: asNumber(row.is_hosting) === 1,
    device_id: asNullableString(row.device_id),
    fingerprint: asNullableString(row.fingerprint),
    user_agent: asNullableString(row.user_agent),
    aid: asNullableNumber(row.aid),
    cid: asNullableNumber(row.cid),
    nid: asNullableNumber(row.nid),
    ref: asNullableString(row.ref),
    source: String(row.source) === 'backfill' ? 'backfill' : 'live',
    request_id: asNullableString(row.request_id),
    created_at: asNumber(row.created_at),
  };
}

/** 供事务内复用：传入事务内的 MysqlDatabase 即可与业务写入同事务提交。 */
export async function insertActivityRow(database: MysqlDatabase, row: ActivityRow): Promise<void> {
  await database.run(
    `INSERT INTO account_activity_log (user_id, event, result, ip, ip_net, country, region, city, latitude, longitude, asn, as_org,
       is_hosting, device_id, fingerprint, user_agent, aid, cid, nid, ref, source, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.user_id, row.event, row.result, row.ip, row.ip_net, row.country, row.region, row.city, row.latitude, row.longitude, row.asn, row.as_org,
      row.is_hosting ? 1 : 0, row.device_id, row.fingerprint, row.user_agent, row.aid, row.cid, row.nid, row.ref, row.source, row.request_id, row.created_at,
    ],
  );
}

export function createActivityRepository(database: MysqlDatabase): ActivityRepository {
  return {
    insert: (row) => insertActivityRow(database, row),

    async latestIpNetForRef(ref) {
      const found = await database.first<MysqlRow>(
        'SELECT ip_net FROM account_activity_log WHERE ref = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        [ref],
      );
      return found ? { ip_net: asNullableString(found.ip_net) } : null;
    },

    async listForUser(userId, limit) {
      // 多取一条用来判断是否还有更早的记录，再反转成时间升序。
      const rows = await database.all<MysqlRow>(
        `SELECT ${RECORD_COLUMNS} FROM account_activity_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        [userId, limit + 1],
      );
      const truncated = rows.length > limit;
      return { records: rows.slice(0, limit).map(readRecord).reverse(), truncated };
    },

    async countUsers(field, value) {
      const column = HEAT_COLUMNS[field];
      const found = await database.first<MysqlRow>(
        // 与 isUnauthenticatedAttempt 保持一致：未经身份验证的尝试不算"用过"这个值。
        `SELECT COUNT(DISTINCT user_id) AS n FROM account_activity_log WHERE ${column} = ?
          AND NOT (event = 'LOGIN' AND result = 'FAILURE') AND event <> 'PASSWORD_RESET_REQUEST'`,
        [value],
      );
      return asNumber(found?.n ?? 0);
    },

    async cleanup(before, batchSize) {
      const result = await database.run('DELETE FROM account_activity_log WHERE created_at < ? ORDER BY created_at LIMIT ?', [before, batchSize]);
      return result.affectedRows;
    },
  };
}
