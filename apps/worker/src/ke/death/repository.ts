import type { MysqlDatabase, MysqlRow } from '../../db/mysql-client';

export const MAX_REPORTS_PER_CHARACTER = 100;
export const RETENTION_MS = 90 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export interface DeathRow {
  id: number;
  userId: number;
  instanceId: string;
  nid: number;
  aid: number;
  cid: number;
  reportKey: string;
  diedAt: number;
  map: string;
  killerMobId: number | null;
  killerSkillId: number | null;
  killerName: string;
  skillName: string;
  cause: string;
  causeLabel: string;
  fixesTotal: number;
  fixesApplied: number;
  reportJson: string;
  fixesStateJson: string | null;
}

export type NewDeathRow = Omit<DeathRow, 'id' | 'fixesApplied' | 'fixesStateJson'>;

export interface DeathStatsRow {
  map: string;
  mobId: number | null;
  mobName: string;
  skillName: string;
  deaths: number;
  characters: number;
  topCause: string;
}

export interface HostedOwner {
  instanceId: string;
  userId: number;
  nid: number;
  aid: number;
  cid: number;
  assignedAgent: string | null;
  desired: string;
}

export interface DeathRepository {
  findHosted(instanceId: string): Promise<HostedOwner | null>;
  /** 幂等插入：同一 (实例, report_key) 已有则忽略，返回是否新增。 */
  insert(row: NewDeathRow, now: number): Promise<boolean>;
  list(instanceId: string, limit: number): Promise<DeathRow[]>;
  get(instanceId: string, reportKey: string): Promise<DeathRow | null>;
  setFixesState(id: number, json: string, applied: number): Promise<void>;
  /** 点“一键应用”后让托管进程重新拉配置；没有在运行时返回 false。 */
  requestConfigSync(instanceId: string, now: number): Promise<boolean>;
  prune(now: number): Promise<void>;
  stats(sinceMs: number): Promise<{ total: number; characters: number; topCause: string | null; rows: DeathStatsRow[] }>;
}

const COLUMNS = 'id, user_id, hosted_instance_id, nid, aid, cid, report_key, died_at, map, killer_mob_id, killer_skill_id, killer_name, skill_name, cause, cause_label, fixes_total, fixes_applied, report_json, fixes_state_json';

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));

function readRow(row: MysqlRow): DeathRow {
  return {
    id: num(row.id), userId: num(row.user_id), instanceId: String(row.hosted_instance_id), nid: num(row.nid), aid: num(row.aid), cid: num(row.cid),
    reportKey: String(row.report_key), diedAt: num(row.died_at), map: String(row.map),
    killerMobId: numOrNull(row.killer_mob_id), killerSkillId: numOrNull(row.killer_skill_id),
    killerName: String(row.killer_name ?? ''), skillName: String(row.skill_name ?? ''), cause: String(row.cause), causeLabel: String(row.cause_label ?? ''),
    fixesTotal: num(row.fixes_total), fixesApplied: num(row.fixes_applied),
    reportJson: String(row.report_json), fixesStateJson: row.fixes_state_json === null || row.fixes_state_json === undefined ? null : String(row.fixes_state_json),
  };
}

export function createDeathRepository(db: MysqlDatabase): DeathRepository {
  return {
    async findHosted(instanceId) {
      const row = await db.first<MysqlRow>('SELECT instance_id, user_id, nid, aid, cid, assigned_agent, desired FROM ke_hosted_instances WHERE instance_id = ?', [instanceId]);
      return row === null ? null : {
        instanceId: String(row.instance_id), userId: num(row.user_id), nid: num(row.nid), aid: num(row.aid), cid: num(row.cid),
        assignedAgent: row.assigned_agent === null ? null : String(row.assigned_agent), desired: String(row.desired),
      };
    },

    async insert(row, now) {
      const result = await db.run(
        `INSERT IGNORE INTO ke_death_reports (user_id, hosted_instance_id, nid, aid, cid, report_key, died_at, map, killer_mob_id, killer_skill_id, killer_name, skill_name, cause, cause_label, fixes_total, report_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.userId, row.instanceId, row.nid, row.aid, row.cid, row.reportKey, row.diedAt, row.map, row.killerMobId, row.killerSkillId, row.killerName, row.skillName, row.cause, row.causeLabel, row.fixesTotal, row.reportJson, now],
      );
      return result.affectedRows === 1;
    },

    async list(instanceId, limit) {
      const rows = await db.all<MysqlRow>(`SELECT ${COLUMNS} FROM ke_death_reports WHERE hosted_instance_id = ? ORDER BY died_at DESC LIMIT ${Math.trunc(limit)}`, [instanceId]);
      return rows.map(readRow);
    },

    async get(instanceId, reportKey) {
      const row = await db.first<MysqlRow>(`SELECT ${COLUMNS} FROM ke_death_reports WHERE hosted_instance_id = ? AND report_key = ?`, [instanceId, reportKey]);
      return row === null ? null : readRow(row);
    },

    async setFixesState(id, json, applied) {
      await db.run('UPDATE ke_death_reports SET fixes_state_json = ?, fixes_applied = ? WHERE id = ?', [json, applied, id]);
    },

    async requestConfigSync(instanceId, now) {
      const result = await db.run(
        "UPDATE ke_hosted_instances SET config_sync_seq = config_sync_seq + 1, updated_at = ? WHERE instance_id = ? AND desired = 'running' AND assigned_agent IS NOT NULL",
        [now, instanceId],
      );
      return result.affectedRows === 1;
    },

    async prune(now) {
      await db.run('DELETE FROM ke_death_reports WHERE died_at < ?', [now - RETENTION_MS]);
      // 每个角色只留最近 MAX 条。
      await db.run(
        `DELETE r FROM ke_death_reports AS r
         INNER JOIN (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, nid, cid ORDER BY died_at DESC, id DESC) AS rn FROM ke_death_reports
         ) AS ranked ON ranked.id = r.id
         WHERE ranked.rn > ?`,
        [MAX_REPORTS_PER_CHARACTER],
      );
    },

    async stats(sinceMs) {
      const totals = await db.first<MysqlRow>('SELECT COUNT(*) AS total, COUNT(DISTINCT user_id, nid, cid) AS characters FROM ke_death_reports WHERE died_at >= ?', [sinceMs]);
      const cause = await db.first<MysqlRow>('SELECT cause_label, COUNT(*) AS n FROM ke_death_reports WHERE died_at >= ? GROUP BY cause_label ORDER BY n DESC LIMIT 1', [sinceMs]);
      const rows = await db.all<MysqlRow>(
        `SELECT map, killer_mob_id, killer_name, skill_name, COUNT(*) AS deaths, COUNT(DISTINCT user_id, nid, cid) AS characters,
                SUBSTRING_INDEX(GROUP_CONCAT(cause_label ORDER BY died_at DESC SEPARATOR ','), ',', 1) AS top_cause
         FROM ke_death_reports WHERE died_at >= ?
         GROUP BY map, killer_mob_id, killer_name, skill_name ORDER BY deaths DESC LIMIT 50`,
        [sinceMs],
      );
      return {
        total: num(totals?.total ?? 0), characters: num(totals?.characters ?? 0),
        topCause: cause === null ? null : String(cause.cause_label),
        rows: rows.map((row) => ({ map: String(row.map), mobId: numOrNull(row.killer_mob_id), mobName: String(row.killer_name), skillName: String(row.skill_name), deaths: num(row.deaths), characters: num(row.characters), topCause: String(row.top_cause ?? '') })),
      };
    },
  };
}

export { DAY_MS };
