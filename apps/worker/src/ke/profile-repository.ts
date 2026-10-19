import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../db/mysql-client';
import { KeFailure } from './types';

export interface ProfileRow {
  id: number;
  user_id: number;
  aid: number;
  cid: number;
  nid: number;
  name: string;
  is_active: boolean;
  config_text: string;
  mon_control: string | null;
  pickupitems: string | null;
  items_control: string | null;
  timeouts: string | null;
}

export interface ProfileInput {
  name: string;
  config_text: string;
  mon_control: string | null;
  pickupitems: string | null;
  items_control: string | null;
  timeouts: string | null;
}

const ER_DUP_ENTRY = 1062;

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MysqlDatabaseError && error.errno === ER_DUP_ENTRY;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readProfile(row: MysqlRow): ProfileRow {
  return {
    id: asNumber(row.id),
    user_id: asNumber(row.user_id),
    aid: asNumber(row.aid),
    cid: asNumber(row.cid),
    nid: asNumber(row.nid),
    name: String(row.name),
    is_active: asNumber(row.is_active) === 1,
    config_text: typeof row.config_text === 'string' ? row.config_text : '',
    mon_control: asNullableString(row.mon_control),
    pickupitems: asNullableString(row.pickupitems),
    items_control: asNullableString(row.items_control),
    timeouts: asNullableString(row.timeouts),
  };
}

const PROFILE_COLUMNS = 'id, user_id, aid, cid, nid, name, is_active, config_text, mon_control, pickupitems, items_control, timeouts';

export interface ProfileTx {
  /** 串行化同一账号的 profile 写操作（尤其 activate 的「一角色一 active」不变式）。 */
  lockUser(userId: number): Promise<void>;
  /** 角色是否已由该账号绑定（ke_characters.user_id）。 */
  ownsCharacter(userId: number, aid: number, cid: number, nid: number): Promise<boolean>;
  findById(id: number): Promise<ProfileRow | null>;
  findActive(userId: number, aid: number, cid: number, nid: number): Promise<ProfileRow | null>;
  listForCharacter(userId: number, aid: number, cid: number, nid: number): Promise<ProfileRow[]>;
  insert(userId: number, aid: number, cid: number, nid: number, input: ProfileInput, now: number): Promise<number>;
  update(id: number, input: ProfileInput, now: number): Promise<void>;
  clearActive(userId: number, aid: number, cid: number, nid: number, now: number): Promise<void>;
  setActive(id: number, now: number): Promise<void>;
  remove(id: number): Promise<void>;
}

export interface ProfileRepository {
  findById(id: number): Promise<ProfileRow | null>;
  findActive(userId: number, aid: number, cid: number, nid: number): Promise<ProfileRow | null>;
  listForCharacter(userId: number, aid: number, cid: number, nid: number): Promise<ProfileRow[]>;
  transaction<T>(work: (tx: ProfileTx) => Promise<T>): Promise<T>;
}

function txFor(db: MysqlDatabase): ProfileTx {
  return {
    async lockUser(userId) {
      await db.all('SELECT id FROM auth_users WHERE id = ? FOR UPDATE', [userId]);
    },

    async ownsCharacter(userId, aid, cid, nid) {
      const rows = await db.all<MysqlRow>(
        'SELECT 1 AS owned FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ? AND user_id = ? LIMIT 1',
        [aid, cid, nid, userId],
      );
      return rows.length > 0;
    },

    async findById(id) {
      const rows = await db.all<MysqlRow>(`SELECT ${PROFILE_COLUMNS} FROM ke_profiles WHERE id = ?`, [id]);
      return rows.length > 0 ? readProfile(rows[0]!) : null;
    },

    async findActive(userId, aid, cid, nid) {
      const rows = await db.all<MysqlRow>(
        `SELECT ${PROFILE_COLUMNS} FROM ke_profiles WHERE user_id = ? AND aid = ? AND cid = ? AND nid = ? AND is_active = 1`,
        [userId, aid, cid, nid],
      );
      return rows.length > 0 ? readProfile(rows[0]!) : null;
    },

    async listForCharacter(userId, aid, cid, nid) {
      const rows = await db.all<MysqlRow>(
        `SELECT ${PROFILE_COLUMNS} FROM ke_profiles WHERE user_id = ? AND aid = ? AND cid = ? AND nid = ? ORDER BY id`,
        [userId, aid, cid, nid],
      );
      return rows.map(readProfile);
    },

    async insert(userId, aid, cid, nid, input, now) {
      try {
        const result = await db.run(
          'INSERT INTO ke_profiles (user_id, aid, cid, nid, name, is_active, config_text, mon_control, pickupitems, items_control, timeouts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
          [userId, aid, cid, nid, input.name, input.config_text, input.mon_control, input.pickupitems, input.items_control, input.timeouts, now, now],
        );
        return result.insertId;
      } catch (error) {
        if (isDuplicateKey(error)) throw new KeFailure('KE_PROFILE_NAME_TAKEN', 409, 'Profile 名称已存在');
        throw error;
      }
    },

    async update(id, input, now) {
      try {
        await db.run(
          'UPDATE ke_profiles SET name = ?, config_text = ?, mon_control = ?, pickupitems = ?, items_control = ?, timeouts = ?, updated_at = ? WHERE id = ?',
          [input.name, input.config_text, input.mon_control, input.pickupitems, input.items_control, input.timeouts, now, id],
        );
      } catch (error) {
        if (isDuplicateKey(error)) throw new KeFailure('KE_PROFILE_NAME_TAKEN', 409, 'Profile 名称已存在');
        throw error;
      }
    },

    async clearActive(userId, aid, cid, nid, now) {
      await db.run('UPDATE ke_profiles SET is_active = 0, updated_at = ? WHERE user_id = ? AND aid = ? AND cid = ? AND nid = ? AND is_active = 1', [now, userId, aid, cid, nid]);
    },

    async setActive(id, now) {
      await db.run('UPDATE ke_profiles SET is_active = 1, updated_at = ? WHERE id = ?', [now, id]);
    },

    async remove(id) {
      await db.run('DELETE FROM ke_profiles WHERE id = ?', [id]);
    },
  };
}

export function createProfileRepository(database: MysqlDatabase): ProfileRepository {
  return {
    findById: (id) => txFor(database).findById(id),
    findActive: (userId, aid, cid, nid) => txFor(database).findActive(userId, aid, cid, nid),
    listForCharacter: (userId, aid, cid, nid) => txFor(database).listForCharacter(userId, aid, cid, nid),
    transaction: (work) => database.transaction((db) => work(txFor(db))),
  };
}
