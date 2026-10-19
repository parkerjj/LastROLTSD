import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MysqlDatabase, MysqlRow } from './mysql-client';
import { GUESTBOOK_MAX_REPLIES_PER_ENTRY } from '../domain/guestbook';

export type GuestbookCategory = 'buy' | 'sell' | 'suggestion';

export interface GuestbookSubmission {
  category: GuestbookCategory;
  itemId: number | null;
  isZeny: boolean;
  content: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface GuestbookAuthor {
  userId: string;
  displayName: string;
  hasAvatar: boolean;
  avatarVersion: number;
  avatarUrl: string;
  permission_level: number;
}

export interface GuestbookReply {
  id: number;
  entryId: number;
  content: string;
  createdAt: number;
  editedAt: number | null;
  author: GuestbookAuthor;
}

export interface GuestbookEntry extends GuestbookSubmission {
  id: number;
  isExpired: boolean;
  editedAt: number | null;
  /** 历史游客留言留下的联系方式；账号系统上线后的新留言恒为 null */
  contact: string | null;
  /** null 表示账号系统上线前的历史游客留言 */
  author: GuestbookAuthor | null;
  replies: GuestbookReply[];
  /** 该留言下的回复总数（不受列表 cap 影响）。 */
  replyCount: number;
  /** true 表示列表视图因 cap 截断了回复；需按需加载完整历史。 */
  hasMoreReplies: boolean;
  /** 当请求携带登录态时，表示当前用户是否已回复过该留言；未携带登录态时为 null。 */
  hasReplied: boolean | null;
}

export interface GuestbookFilters {
  category?: GuestbookCategory;
  itemId?: number;
  q?: string;
  limit: number;
  cursor?: string;
  context: string;
}

export type ReplyCreateResult =
  | { status: 'created'; id: number }
  | { status: 'rate_limited' }
  | { status: 'duplicate' }
  | { status: 'entry_not_found' };

export type EntryCreateResult = { status: 'created'; id: number } | { status: 'rate_limited' };

export interface GuestbookRepository {
  create(input: GuestbookSubmission, userId: string, rateKey: string, bucketStart: number, rateLimit: number): Promise<EntryCreateResult>;
  search(filters: GuestbookFilters, now: number, currentUserId?: string): Promise<{ items: GuestbookEntry[]; nextCursor: string | null }>;
  readById(id: number, now: number, currentUserId?: string): Promise<GuestbookEntry | null>;
  updateEntryContent(id: number, userId: string, content: string, editedAt: number): Promise<boolean>;
  createReply(entryId: number, userId: string, content: string, createdAt: number, rateKey: string, bucketStart: number, rateLimit: number): Promise<ReplyCreateResult>;
  updateReplyContent(id: number, userId: string, content: string, editedAt: number): Promise<boolean>;
  deleteRateLimitBucketsBefore(cutoff: number, limit: number): Promise<number>;
}

interface Cursor { createdAt: number; id: number; context: string; }
const CURSOR_KIND = 'guestbook';
const MYSQL_ER_DUP_ENTRY = 1062;
const MYSQL_ER_NO_REFERENCED_ROW = 1452;

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function encode(value: Cursor, secret: string): string {
  const body = Buffer.from(JSON.stringify({ version: 1, kind: CURSOR_KIND, ...value })).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function decode(value: string, context: string, secret: string): Cursor {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error('Invalid cursor');
  const separator = value.lastIndexOf('.');
  const body = value.slice(0, separator);
  const actual = value.slice(separator + 1);
  const expected = sign(body, secret);
  if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new Error('Invalid cursor');
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.version !== 1 || parsed.kind !== CURSOR_KIND || parsed.context !== context
      || !Number.isSafeInteger(parsed.createdAt) || Number(parsed.createdAt) < 0
      || !Number.isSafeInteger(parsed.id) || Number(parsed.id) <= 0) throw new Error();
    return { createdAt: Number(parsed.createdAt), id: Number(parsed.id), context };
  } catch {
    throw new Error('Invalid cursor');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function mysqlErrno(error: unknown): number | null {
  if (error && typeof error === 'object' && 'errno' in error) {
    const errno = (error as { errno?: unknown }).errno;
    if (typeof errno === 'number') return errno;
  }
  return null;
}

function mapAuthor(row: MysqlRow, prefix: string): GuestbookAuthor | null {
  const userId = row[`${prefix}user_id`];
  if (userId === null || userId === undefined) return null;
  const id = String(userId);
  const avatarVersion = Number(row[`${prefix}avatar_version`] ?? 0);
  return {
    userId: id,
    displayName: String(row[`${prefix}display_name`] ?? ''),
    hasAvatar: Number(row[`${prefix}has_avatar`] ?? 0) === 1,
    avatarVersion,
    avatarUrl: `/api/v1/users/${id}/avatar?v=${avatarVersion}`,
    permission_level: Number(row[`${prefix}permission_level`] ?? 0),
  };
}

function mapEntryRow(row: MysqlRow, now: number): GuestbookEntry {
  const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
  return {
    id: Number(row.id),
    category: String(row.category) as GuestbookCategory,
    itemId: row.item_id == null ? null : Number(row.item_id),
    isZeny: Number(row.is_zeny) === 1,
    content: String(row.content),
    createdAt: Number(row.created_at),
    expiresAt,
    isExpired: expiresAt !== null && expiresAt <= now,
    editedAt: row.edited_at == null ? null : Number(row.edited_at),
    contact: row.contact == null ? null : String(row.contact),
    author: mapAuthor(row, 'author_'),
    replies: [],
    replyCount: 0,
    hasMoreReplies: false,
    hasReplied: null,
  };
}

const AUTHOR_COLUMNS = `CAST(u.id AS CHAR) AS author_user_id, u.display_name AS author_display_name,
  u.avatar_version AS author_avatar_version, u.permission_level AS author_permission_level,
  EXISTS (SELECT 1 FROM auth_avatars AS a WHERE a.user_id = u.id) AS author_has_avatar`;

const ENTRY_COLUMNS = `e.id, e.category, e.item_id, e.is_zeny, e.contact, e.content, e.created_at, e.expires_at, e.edited_at, ${AUTHOR_COLUMNS}`;

/** 最多拉取的回复条数：列表视图用 cap，单条读取（readById）给更大的上限。 */
async function attachReplies(
  db: MysqlDatabase,
  entries: GuestbookEntry[],
  cap: number,
  currentUserId?: string,
): Promise<void> {
  if (entries.length === 0) return;
  const entryIds = entries.map((entry) => entry.id);
  const placeholders = entryIds.map(() => '?').join(', ');

  // 1. 总数：用于前端展示回复计数 + 判断是否截断
  const countRows = await db.all<MysqlRow>(
    `SELECT entry_id, COUNT(*) AS cnt FROM guestbook_replies WHERE entry_id IN (${placeholders}) GROUP BY entry_id`,
    entryIds,
  );
  const countByEntry = new Map<number, number>(countRows.map((r) => [Number(r.entry_id), Number(r.cnt)]));

  // 2. 逐条 cap 最新 N 条回复：MySQL 8 ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY ... DESC) rn <= cap
  //    外层再按 ASC 排序恢复时间正序展示
  const cappedRows = await db.all<MysqlRow>(
    `SELECT r.id, r.entry_id, r.content, r.created_at, r.edited_at,
        CAST(u.id AS CHAR) AS author_user_id, u.display_name AS author_display_name,
        u.avatar_version AS author_avatar_version, u.permission_level AS author_permission_level,
        EXISTS (SELECT 1 FROM auth_avatars AS a WHERE a.user_id = u.id) AS author_has_avatar
      FROM (
        SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.entry_id ORDER BY r.created_at DESC, r.id DESC) AS rn
        FROM guestbook_replies AS r
        WHERE r.entry_id IN (${placeholders})
      ) AS r
      INNER JOIN auth_users AS u ON u.id = r.user_id
      WHERE r.rn <= ?
      ORDER BY r.entry_id ASC, r.created_at ASC, r.id ASC`,
    [...entryIds, cap],
  );

  // 3. 当请求携带登录态时，额外标记当前用户是否已回复过每条留言
  let hasRepliedByEntry: Map<number, boolean> | undefined;
  if (currentUserId !== undefined) {
    const repliedRows = await db.all<MysqlRow>(
      `SELECT entry_id FROM guestbook_replies WHERE entry_id IN (${placeholders}) AND user_id = ?`,
      [...entryIds, currentUserId],
    );
    hasRepliedByEntry = new Map(repliedRows.map((r) => [Number(r.entry_id), true]));
  }

  const byEntry = new Map<number, GuestbookEntry>(entries.map((entry) => [entry.id, entry]));
  for (const row of cappedRows) {
    const entry = byEntry.get(Number(row.entry_id));
    const author = mapAuthor(row, 'author_');
    if (!entry || !author) continue;
    entry.replies.push({
      id: Number(row.id),
      entryId: Number(row.entry_id),
      content: String(row.content),
      createdAt: Number(row.created_at),
      editedAt: row.edited_at == null ? null : Number(row.edited_at),
      author,
    });
  }
  for (const entry of entries) {
    const total = countByEntry.get(entry.id) ?? 0;
    entry.replyCount = total;
    entry.hasMoreReplies = total > entry.replies.length;
    entry.hasReplied = hasRepliedByEntry ? (hasRepliedByEntry.get(entry.id) ?? false) : null;
  }
}

export function createGuestbookRepository(db: MysqlDatabase, cursorSecret: string): GuestbookRepository {
  async function consumeRateLimit(tx: MysqlDatabase, rateKey: string, bucketStart: number, rateLimit: number): Promise<void> {
    await tx.run(`INSERT INTO guestbook_rate_limits(rate_key, bucket_start, request_count)
      VALUES (?, ?, 1)
      ON DUPLICATE KEY UPDATE request_count = request_count + 1`, [rateKey, bucketStart]);
    const rate = await tx.first<MysqlRow>('SELECT request_count FROM guestbook_rate_limits WHERE rate_key=? AND bucket_start=? FOR UPDATE', [rateKey, bucketStart]);
    if (Number(rate?.request_count ?? rateLimit + 1) > rateLimit) throw new RateLimitedError();
  }

  return {
    async create(input, userId, rateKey, bucketStart, rateLimit): Promise<EntryCreateResult> {
      try {
        return await db.transaction<EntryCreateResult>(async (tx): Promise<EntryCreateResult> => {
          await consumeRateLimit(tx, rateKey, bucketStart, rateLimit);
          const result = await tx.run(`INSERT INTO guestbook_entries(user_id, category, item_id, is_zeny, contact, content, created_at, expires_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`, [userId, input.category, input.itemId, input.isZeny ? 1 : 0, input.content, input.createdAt, input.expiresAt]);
          return { status: 'created', id: result.insertId };
        });
      } catch (error) {
        if (error instanceof RateLimitedError) return { status: 'rate_limited' };
        throw error;
      }
    },

    async search(filters, now, currentUserId) {
      const where: string[] = [];
      const values: unknown[] = [];
      const bind = (value: unknown): string => { values.push(value); return '?'; };
      if (filters.category) where.push(`e.category = ${bind(filters.category)}`);
      if (filters.itemId !== undefined) where.push(`e.item_id = ${bind(filters.itemId)}`);
      if (filters.q) {
        const term = `%${escapeLike(filters.q)}%`;
        where.push(`(e.content LIKE ${bind(term)} ESCAPE '\\\\' OR COALESCE(e.contact, '') LIKE ${bind(term)} ESCAPE '\\\\')`);
      }
      if (filters.cursor) {
        const cursor = decode(filters.cursor, filters.context, cursorSecret);
        const createdAt = bind(cursor.createdAt);
        const sameCreatedAt = bind(cursor.createdAt);
        const id = bind(cursor.id);
        where.push(`(e.created_at < ${createdAt} OR (e.created_at = ${sameCreatedAt} AND e.id < ${id}))`);
      }
      const limit = Math.min(50, Math.max(1, filters.limit));
      values.push(limit + 1);
      const rows = await db.all<MysqlRow>(`SELECT ${ENTRY_COLUMNS}
        FROM guestbook_entries AS e
        LEFT JOIN auth_users AS u ON u.id = e.user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ?`, values);
      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const items = visible.map((row) => mapEntryRow(row, now));
      await attachReplies(db, items, GUESTBOOK_MAX_REPLIES_PER_ENTRY, currentUserId);
      const last = visible.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? encode({ createdAt: Number(last.created_at), id: Number(last.id), context: filters.context }, cursorSecret) : null,
      };
    },

    async readById(id, now, currentUserId) {
      const row = await db.first<MysqlRow>(`SELECT ${ENTRY_COLUMNS}
        FROM guestbook_entries AS e
        LEFT JOIN auth_users AS u ON u.id = e.user_id
        WHERE e.id = ? LIMIT 1`, [id]);
      if (!row) return null;
      const entry = mapEntryRow(row, now);
      // 单条读取（创建/编辑/回复后的回读 + 详情接口）给更大的上限，展示完整历史；
      // 仍保留硬上限防止异常数据拖垮 Worker 内存
      await attachReplies(db, [entry], 200, currentUserId);
      return entry;
    },

    async updateEntryContent(id, userId, content, editedAt) {
      const result = await db.run(`UPDATE guestbook_entries SET content = ?, edited_at = ?
        WHERE id = ? AND user_id = ?`, [content, editedAt, id, userId]);
      return result.affectedRows === 1;
    },

    async createReply(entryId, userId, content, createdAt, rateKey, bucketStart, rateLimit): Promise<ReplyCreateResult> {
      try {
        return await db.transaction<ReplyCreateResult>(async (tx): Promise<ReplyCreateResult> => {
          await consumeRateLimit(tx, rateKey, bucketStart, rateLimit);
          const result = await tx.run(`INSERT INTO guestbook_replies(entry_id, user_id, content, created_at)
            VALUES (?, ?, ?, ?)`, [entryId, userId, content, createdAt]);
          return { status: 'created', id: result.insertId };
        });
      } catch (error) {
        if (error instanceof RateLimitedError) return { status: 'rate_limited' };
        const errno = mysqlErrno(error);
        if (errno === MYSQL_ER_DUP_ENTRY) return { status: 'duplicate' };
        if (errno === MYSQL_ER_NO_REFERENCED_ROW) return { status: 'entry_not_found' };
        throw error;
      }
    },

    async updateReplyContent(id, userId, content, editedAt) {
      const result = await db.run(`UPDATE guestbook_replies SET content = ?, edited_at = ?
        WHERE id = ? AND user_id = ?`, [content, editedAt, id, userId]);
      return result.affectedRows === 1;
    },

    async deleteRateLimitBucketsBefore(cutoff, limit) {
      const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
      const result = await db.run(`DELETE FROM guestbook_rate_limits WHERE (rate_key, bucket_start) IN (
        SELECT rate_key, bucket_start FROM (
          SELECT rate_key, bucket_start FROM guestbook_rate_limits WHERE bucket_start < ? ORDER BY bucket_start LIMIT ?
        ) AS expired_rate_buckets
      )`, [cutoff, boundedLimit]);
      return result.affectedRows;
    },
  };
}

export class RateLimitedError extends Error {
  constructor() { super('Guestbook rate limit exceeded'); this.name = 'RateLimitedError'; }
}

/** 限流维度：登录用户按 user_id 区分动作（entry=发布留言，reply=回复），不再使用 IP */
export function guestbookRateKey(scope: 'entry' | 'reply', userId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${scope}:${userId}`).digest('hex');
}

export function guestbookFilterContext(filters: Omit<GuestbookFilters, 'cursor' | 'context'>): string {
  return Buffer.from(JSON.stringify({ category: filters.category ?? null, itemId: filters.itemId ?? null, q: filters.q ?? null, limit: filters.limit })).toString('base64url');
}
