import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MysqlDatabase, MysqlRow } from './mysql-client';

export type GuestbookCategory = 'buy' | 'sell' | 'suggestion';

export interface GuestbookSubmission {
  category: GuestbookCategory;
  itemId: number | null;
  isZeny: boolean;
  contact: string | null;
  content: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface GuestbookEntry extends GuestbookSubmission {
  id: number;
  isExpired: boolean;
}

export interface GuestbookFilters {
  category?: GuestbookCategory;
  itemId?: number;
  q?: string;
  limit: number;
  cursor?: string;
  context: string;
}

export interface GuestbookRepository {
  create(input: GuestbookSubmission, rateKey: string, bucketStart: number, rateLimit: number): Promise<'created' | 'rate_limited'>;
  search(filters: GuestbookFilters, now: number): Promise<{ items: GuestbookEntry[]; nextCursor: string | null }>;
  deleteRateLimitBucketsBefore(cutoff: number, limit: number): Promise<number>;
}

interface Cursor { createdAt: number; id: number; context: string; }
const CURSOR_KIND = 'guestbook';

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

export function createGuestbookRepository(db: MysqlDatabase, cursorSecret: string): GuestbookRepository {
  return {
    async create(input, rateKey, bucketStart, rateLimit) {
      try {
        return await db.transaction(async (tx) => {
          await tx.run(`INSERT INTO guestbook_rate_limits(rate_key, bucket_start, request_count)
            VALUES (?, ?, 1)
            ON DUPLICATE KEY UPDATE request_count = request_count + 1`, [rateKey, bucketStart]);
          const rate = await tx.first<MysqlRow>('SELECT request_count FROM guestbook_rate_limits WHERE rate_key=? AND bucket_start=? FOR UPDATE', [rateKey, bucketStart]);
          if (Number(rate?.request_count ?? rateLimit + 1) > rateLimit) throw new RateLimitedError();
          await tx.run(`INSERT INTO guestbook_entries(category, item_id, is_zeny, contact, content, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [input.category, input.itemId, input.isZeny ? 1 : 0, input.contact, input.content, input.createdAt, input.expiresAt]);
          return 'created';
        });
      } catch (error) {
        if (error instanceof RateLimitedError) return 'rate_limited';
        throw error;
      }
    },

    async search(filters, now) {
      const where: string[] = [];
      const values: unknown[] = [];
      const bind = (value: unknown): string => { values.push(value); return '?'; };
      if (filters.category) where.push(`category = ${bind(filters.category)}`);
      if (filters.itemId !== undefined) where.push(`item_id = ${bind(filters.itemId)}`);
      if (filters.q) {
        const term = `%${escapeLike(filters.q)}%`;
        where.push(`(content LIKE ${bind(term)} ESCAPE '\\\\' OR COALESCE(contact, '') LIKE ${bind(term)} ESCAPE '\\\\')`);
      }
      if (filters.cursor) {
        const cursor = decode(filters.cursor, filters.context, cursorSecret);
        const createdAt = bind(cursor.createdAt);
        const sameCreatedAt = bind(cursor.createdAt);
        const id = bind(cursor.id);
        where.push(`(created_at < ${createdAt} OR (created_at = ${sameCreatedAt} AND id < ${id}))`);
      }
      const limit = Math.min(50, Math.max(1, filters.limit));
      values.push(limit + 1);
      const rows = await db.all<MysqlRow>(`SELECT id, category, item_id, is_zeny, contact, content, created_at, expires_at
        FROM guestbook_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT ?`, values);
      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const items = visible.map((row) => {
        const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
        return {
          id: Number(row.id), category: String(row.category) as GuestbookCategory,
          itemId: row.item_id == null ? null : Number(row.item_id), isZeny: Number(row.is_zeny) === 1,
          contact: row.contact == null ? null : String(row.contact), content: String(row.content),
          createdAt: Number(row.created_at), expiresAt, isExpired: expiresAt !== null && expiresAt <= now,
        } satisfies GuestbookEntry;
      });
      const last = visible.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? encode({ createdAt: last.createdAt, id: last.id, context: filters.context }, cursorSecret) : null,
      };
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

export function guestbookRateKey(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export function guestbookFilterContext(filters: Omit<GuestbookFilters, 'cursor' | 'context'>): string {
  return Buffer.from(JSON.stringify({ category: filters.category ?? null, itemId: filters.itemId ?? null, q: filters.q ?? null, limit: filters.limit })).toString('base64url');
}
