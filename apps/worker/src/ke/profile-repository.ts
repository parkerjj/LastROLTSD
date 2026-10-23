import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../db/mysql-client';
import type { ProfileSharingInput, ProfileSharingMetadata } from './shared-profile-types';
import { publishSharedProfile, withdrawSharedProfile } from './shared-profile-repository';
import { KeFailure } from './types';

export interface ProfileRow {
  sharing?: ProfileSharingMetadata | null;
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
  sharing?: ProfileSharingInput;
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
    sharing: row.sharing_id == null ? null : { id: asNumber(row.sharing_id), share_code: String(row.share_code),
      status: row.sharing_status === 'PUBLISHED' ? 'PUBLISHED' : 'WITHDRAWN', updated_at: asNumber(row.sharing_updated_at),
    },
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
  publishSharing?(userId: number, id: number, input: ProfileInput, now: number): Promise<void>;
  withdrawSharing?(userId: number, id: number, now: number): Promise<void>;
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
    publishSharing: (userId, id, input, now) => publishSharedProfile(db, userId, id, input, now),
    withdrawSharing: (userId, id, now) => withdrawSharedProfile(db, userId, id, now),
    async lockUser(userId) {
      await db.all('SELECT id FROM auth_users WHERE id = ? FOR UPDATE', [userId]);
    },

    async ownsCharacter(userId, aid, cid, nid) {
      const rows = await db.all<MysqlRow>(
        'SELECT 1 AS owned FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ? AND user_id = ? LIMIT 1 FOR UPDATE',
        [aid, cid, nid, userId],
      );
      return rows.length > 0;
    },

    async findById(id) {
      const rows = await db.all<MysqlRow>(`SELECT ${PROFILE_COLUMNS} FROM ke_profiles WHERE id = ? FOR UPDATE`, [id]);
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
  const withSharing = async (profile: ProfileRow): Promise<ProfileRow> => {
    const row = await database.first('SELECT id, share_code, status, updated_at, description FROM ke_shared_profiles WHERE source_profile_id = ? AND author_user_id = ?', [profile.id, profile.user_id]);
    return { ...profile, sharing: row ? { id: Number(row.id), share_code: String(row.share_code), status: row.status === 'PUBLISHED' ? 'PUBLISHED' : 'WITHDRAWN', updated_at: Number(row.updated_at), description: String(row.description) } : null };
  };
  return {
    async findById(id) {
      const profile = await txFor(database).findById(id);
      return profile ? withSharing(profile) : null;
    },
    findActive: (userId, aid, cid, nid) => txFor(database).findActive(userId, aid, cid, nid),
    async listForCharacter(userId, aid, cid, nid) {
      const rows = await database.all(`SELECT p.*, s.id AS sharing_id, s.share_code, s.status AS sharing_status, s.updated_at AS sharing_updated_at
        FROM ke_profiles p LEFT JOIN ke_shared_profiles s ON s.source_profile_id = p.id AND s.author_user_id = p.user_id
        WHERE p.user_id = ? AND p.aid = ? AND p.cid = ? AND p.nid = ? ORDER BY p.id`, [userId, aid, cid, nid]);
      return rows.map(readProfile);
    },
    transaction: (work) => database.transaction((db) => work(txFor(db))),
  };
}
