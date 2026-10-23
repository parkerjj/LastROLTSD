import { MysqlDatabaseError, type MysqlDatabase, type MysqlRow } from '../db/mysql-client';
import type { ProfileInput } from './profile-repository';
import type { SharedProfileCopyInput, SharedProfileDetail, SharedProfilePage, SharedProfileQuery, SharedProfileSummary } from './shared-profile-types';
import { KeFailure } from './types';

interface StoredSharedProfile {
  id: number;
  author_user_id: number;
  title: string;
  status: string;
  config_text: string;
  mon_control: string | null;
  pickupitems: string | null;
  items_control: string | null;
  timeouts: string | null;
  like_count: number;
  use_count: number;
}
interface CopyReceipt {
  request_hash: string;
  result_profile_id: number;
  result_name: string;
  result_owner_id: number | null;
  use_count: number;
}
export interface SharedProfileTx {
  lockUser(userId: number): Promise<void>;
  ownsCharacter(userId: number, input: SharedProfileCopyInput): Promise<boolean>;
  findSource(id: number): Promise<{ user_id: number; aid: number; cid: number; nid: number } | null>;
  countProfiles(userId: number, input: SharedProfileCopyInput): Promise<number>;
  nameExists(userId: number, input: SharedProfileCopyInput, name: string): Promise<boolean>;
  findReceipt(userId: number, requestId: string): Promise<CopyReceipt | null>;
  lockShared(id: number): Promise<StoredSharedProfile | null>;
  changeLike(userId: number, id: number, liked: boolean, now: number): Promise<number>;
  insertProfile(userId: number, input: SharedProfileCopyInput, shared: StoredSharedProfile, name: string, now: number): Promise<number>;
  addUse(userId: number, id: number, now: number): Promise<number>;
  insertReceipt(userId: number, id: number, input: SharedProfileCopyInput, hash: string, profileId: number, name: string, now: number): Promise<void>;
  withdrawShared(userId: number, id: number, now: number): Promise<void>;
  withdrawSource(userId: number, id: number, now: number): Promise<void>;
}
export interface SharedProfileRepository {
  list(userId: number, query: SharedProfileQuery): Promise<SharedProfilePage>;
  findById(userId: number, id: number): Promise<SharedProfileDetail | null>;
  findByCode(userId: number, code: string): Promise<SharedProfileDetail | null>;
  transaction<T>(work: (tx: SharedProfileTx) => Promise<T>): Promise<T>;
}

function stored(row: MysqlRow): StoredSharedProfile {
  return { id: Number(row.id), author_user_id: Number(row.author_user_id), title: String(row.title), status: String(row.status),
    config_text: String(row.config_text), mon_control: row.mon_control === null ? null : String(row.mon_control),
    pickupitems: row.pickupitems === null ? null : String(row.pickupitems), items_control: row.items_control === null ? null : String(row.items_control),
    timeouts: row.timeouts === null ? null : String(row.timeouts), like_count: Number(row.like_count), use_count: Number(row.use_count) };
}
function summary(row: MysqlRow, userId: number): SharedProfileSummary {
  return { id: Number(row.id), title: String(row.title), description: String(row.description), job_id: row.job_id === null ? null : Number(row.job_id),
    author: { id: String(row.author_user_id), display_name: String(row.display_name) }, share_code: String(row.share_code),
    like_count: Number(row.like_count), use_count: Number(row.use_count), liked_by_me: Number(row.liked_by_me) === 1, used_by_me: Number(row.used_by_me) === 1,
    is_mine: Number(row.author_user_id) === userId, created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}
function detail(row: MysqlRow, userId: number): SharedProfileDetail {
  const files = stored(row);
  return { ...summary(row, userId), config_text: files.config_text, mon_control: files.mon_control, pickupitems: files.pickupitems, items_control: files.items_control, timeouts: files.timeouts };
}
const SUMMARY_COLUMNS = `s.id, s.author_user_id, s.title, s.description, s.job_id, s.share_code, s.like_count, s.use_count, s.created_at, s.updated_at, u.display_name,
  EXISTS(SELECT 1 FROM ke_shared_profile_likes l WHERE l.shared_profile_id = s.id AND l.user_id = ?) AS liked_by_me,
  EXISTS(SELECT 1 FROM ke_shared_profile_uses v WHERE v.shared_profile_id = s.id AND v.user_id = ?) AS used_by_me`;
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, s.config_text, s.mon_control, s.pickupitems, s.items_control, s.timeouts`;

export async function withdrawSharedProfile(database: MysqlDatabase, userId: number, sourceId: number, now: number): Promise<void> {
  await database.all('SELECT id FROM ke_shared_profiles WHERE source_profile_id = ? AND author_user_id = ? FOR UPDATE', [sourceId, userId]);
  await database.run("UPDATE ke_shared_profiles SET status = 'WITHDRAWN', updated_at = ? WHERE source_profile_id = ? AND author_user_id = ? AND status <> 'WITHDRAWN'", [now, sourceId, userId]);
}

// Rejection sampling avoids modulo bias for both alphabet and digit positions.
function randomSymbol(size: number): number {
  const limit = 256 - (256 % size);
  const bytes = new Uint8Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0]! >= limit);
  return bytes[0]! % size;
}
function shareCode(): string {
  return Array.from({ length: 3 }, () => String.fromCharCode(65 + randomSymbol(26))).join('') + '-'
    + Array.from({ length: 4 }, () => String(randomSymbol(10))).join('');
}
export async function publishSharedProfile(database: MysqlDatabase, userId: number, sourceId: number, input: ProfileInput, now: number): Promise<void> {
  const source = await database.first('SELECT aid, cid, nid FROM ke_profiles WHERE id = ? AND user_id = ? FOR UPDATE', [sourceId, userId]);
  if (!source) throw new KeFailure('KE_PROFILE_NOT_FOUND', 404, 'Profile 不存在');
  const character = await database.first('SELECT user_id, job_id FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ? FOR UPDATE', [source.aid, source.cid, source.nid]);
  if (character?.user_id != null && Number(character.user_id) !== userId) throw new KeFailure('KE_CHARACTER_NOT_FOUND', 404, '角色不存在或不属于当前账号');
  const jobId = character?.user_id == null ? null : character.job_id;
  const existing = await database.first('SELECT id, description, author_user_id FROM ke_shared_profiles WHERE source_profile_id = ? FOR UPDATE', [sourceId]);
  if (existing && Number(existing.author_user_id) !== userId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '共享配置不属于当前账号');
  const description = input.sharing?.description?.replace(/\r\n?/gu, '\n') ?? (existing ? String(existing.description) : '');
  const values = [input.name, description, jobId, input.config_text, input.mon_control, input.pickupitems, input.items_control, input.timeouts];
  if (existing) {
    await database.run("UPDATE ke_shared_profiles SET title = ?, description = ?, job_id = ?, config_text = ?, mon_control = ?, pickupitems = ?, items_control = ?, timeouts = ?, status = 'PUBLISHED', updated_at = ? WHERE id = ?", [...values, now, Number(existing.id)]);
    return;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = shareCode();
    try {
      await database.run("INSERT INTO ke_shared_profiles (author_user_id, source_profile_id, share_code, title, description, job_id, config_text, mon_control, pickupitems, items_control, timeouts, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?)", [userId, sourceId, code, ...values, now, now]);
      return;
    } catch (error) {
      if (!(error instanceof MysqlDatabaseError) || error.errno !== 1062) throw error;
      // Driver errors intentionally hide key names; verify exactly the code conflict.
      const codeConflict = await database.first('SELECT id FROM ke_shared_profiles WHERE share_code = ? FOR UPDATE', [code]);
      const sourceConflict = await database.first('SELECT id FROM ke_shared_profiles WHERE source_profile_id = ? FOR UPDATE', [sourceId]);
      if (!codeConflict || sourceConflict) throw error;
    }
  }
  throw new KeFailure('KE_SHARE_CODE_EXHAUSTED', 503, '暂时无法生成分享码，请重试');
}

function transactionFor(database: MysqlDatabase): SharedProfileTx {
  return {
    async lockUser(userId) { await database.all('SELECT id FROM auth_users WHERE id = ? FOR UPDATE', [userId]); },
    async ownsCharacter(userId, input) {
      return Boolean(await database.first('SELECT user_id FROM ke_characters WHERE aid = ? AND cid = ? AND nid = ? AND user_id = ? FOR UPDATE', [input.aid, input.cid, input.nid, userId]));
    },
    async findSource(id) {
      const row = await database.first('SELECT user_id, aid, cid, nid FROM ke_profiles WHERE id = ? FOR UPDATE', [id]);
      return row ? { user_id: Number(row.user_id), aid: Number(row.aid), cid: Number(row.cid), nid: Number(row.nid) } : null;
    },
    async countProfiles(userId, input) {
      const row = await database.first('SELECT COUNT(*) AS n FROM ke_profiles WHERE user_id = ? AND aid = ? AND cid = ? AND nid = ?', [userId, input.aid, input.cid, input.nid]);
      return Number(row?.n ?? 0);
    },
    async nameExists(userId, input, name) {
      return Boolean(await database.first('SELECT id FROM ke_profiles WHERE user_id = ? AND aid = ? AND cid = ? AND nid = ? AND name = ?', [userId, input.aid, input.cid, input.nid, name]));
    },
    async findReceipt(userId, requestId) {
      const row = await database.first(`SELECT HEX(c.request_hash) AS request_hash, c.result_profile_id, c.result_name, p.user_id AS result_owner_id, s.use_count
        FROM ke_shared_profile_copies c JOIN ke_shared_profiles s ON s.id = c.shared_profile_id LEFT JOIN ke_profiles p ON p.id = c.result_profile_id
        WHERE c.user_id = ? AND c.request_id = ?`, [userId, requestId]);
      return row ? { request_hash: String(row.request_hash).toLowerCase(), result_profile_id: Number(row.result_profile_id), result_name: String(row.result_name),
        result_owner_id: row.result_owner_id === null ? null : Number(row.result_owner_id), use_count: Number(row.use_count) } : null;
    },
    async lockShared(id) {
      const row = await database.first('SELECT id, author_user_id, title, status, config_text, mon_control, pickupitems, items_control, timeouts, like_count, use_count FROM ke_shared_profiles WHERE id = ? FOR UPDATE', [id]);
      return row ? stored(row) : null;
    },
    async changeLike(userId, id, liked, now) {
      let changed: number;
      if (liked) {
        const existing = await database.first('SELECT 1 AS present FROM ke_shared_profile_likes WHERE shared_profile_id = ? AND user_id = ?', [id, userId]);
        changed = existing ? 0 : (await database.run('INSERT INTO ke_shared_profile_likes (shared_profile_id, user_id, created_at) VALUES (?, ?, ?)', [id, userId, now])).affectedRows;
      } else changed = (await database.run('DELETE FROM ke_shared_profile_likes WHERE shared_profile_id = ? AND user_id = ?', [id, userId])).affectedRows;
      if (changed) await database.run(`UPDATE ke_shared_profiles SET like_count = like_count ${liked ? '+' : '-'} 1 WHERE id = ?`, [id]);
      const row = await database.first('SELECT like_count FROM ke_shared_profiles WHERE id = ?', [id]);
      return Number(row!.like_count);
    },
    async insertProfile(userId, input, shared, name, now) {
      const result = await database.run('INSERT INTO ke_profiles (user_id, aid, cid, nid, name, is_active, config_text, mon_control, pickupitems, items_control, timeouts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
        [userId, input.aid, input.cid, input.nid, name, shared.config_text, shared.mon_control, shared.pickupitems, shared.items_control, shared.timeouts, now, now]);
      return result.insertId;
    },
    async addUse(userId, id, now) {
      const existing = await database.first('SELECT 1 AS present FROM ke_shared_profile_uses WHERE shared_profile_id = ? AND user_id = ?', [id, userId]);
      if (existing) return 0;
      const result = await database.run('INSERT INTO ke_shared_profile_uses (shared_profile_id, user_id, created_at) VALUES (?, ?, ?)', [id, userId, now]);
      if (result.affectedRows) await database.run('UPDATE ke_shared_profiles SET use_count = use_count + 1 WHERE id = ?', [id]);
      return result.affectedRows;
    },
    async insertReceipt(userId, id, input, hash, profileId, name, now) {
      await database.run('INSERT INTO ke_shared_profile_copies (user_id, request_id, shared_profile_id, request_hash, result_profile_id, result_name, created_at) VALUES (?, ?, ?, UNHEX(?), ?, ?, ?)', [userId, input.request_id, id, hash, profileId, name, now]);
    },
    async withdrawShared(userId, id, now) {
      await database.run("UPDATE ke_shared_profiles SET status = 'WITHDRAWN', updated_at = ? WHERE id = ? AND author_user_id = ? AND status <> 'WITHDRAWN'", [now, id, userId]);
    },
    withdrawSource: (userId, id, now) => withdrawSharedProfile(database, userId, id, now),
  };
}
export function createSharedProfileRepository(database: MysqlDatabase): SharedProfileRepository {
  const read = async (userId: number, condition: string, value: number | string): Promise<SharedProfileDetail | null> => {
    const row = await database.first(`SELECT ${DETAIL_COLUMNS} FROM ke_shared_profiles s JOIN auth_users u ON u.id = s.author_user_id WHERE s.status = 'PUBLISHED' AND ${condition}`, [userId, userId, value]);
    return row ? detail(row, userId) : null;
  };
  return {
    async list(userId, query) {
      const filter = query.job_ids !== undefined
        ? ` AND s.job_id IN (${query.job_ids.map(() => '?').join(', ')})`
        : query.job_id === undefined ? '' : ' AND s.job_id = ?';
      const filterValues = query.job_ids ?? (query.job_id === undefined ? [] : [query.job_id]);
      const order = { newest: 's.created_at DESC, s.id DESC', uses: 's.use_count DESC, s.created_at DESC, s.id DESC', likes: 's.like_count DESC, s.created_at DESC, s.id DESC' }[query.sort];
      const rows = await database.all(`SELECT ${SUMMARY_COLUMNS} FROM ke_shared_profiles s JOIN auth_users u ON u.id = s.author_user_id WHERE s.status = 'PUBLISHED'${filter} ORDER BY ${order} LIMIT 20 OFFSET ?`, [userId, userId, ...filterValues, (query.page - 1) * 20]);
      const count = await database.first(`SELECT COUNT(*) AS n FROM ke_shared_profiles s WHERE s.status = 'PUBLISHED'${filter}`, filterValues);
      return { items: rows.map((row) => summary(row, userId)), total: Number(count!.n), page: query.page, page_size: 20 };
    },
    findById: (userId, id) => read(userId, 's.id = ?', id),
    findByCode: (userId, code) => read(userId, 's.share_code = ?', code),
    transaction: (work) => database.transaction((db) => work(transactionFor(db))),
  };
}
