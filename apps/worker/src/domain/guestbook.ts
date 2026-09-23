import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GuestbookCategory, GuestbookFilters } from '../db/guestbook-repository';

export const GUESTBOOK_MAX_BODY_BYTES = 16 * 1024;
export const GUESTBOOK_MAX_CONTENT_LENGTH = 2_000;
export const GUESTBOOK_MAX_CONTACT_LENGTH = 120;
export const GUESTBOOK_MAX_QUERY_LENGTH = 80;
export const GUESTBOOK_DEFAULT_LIMIT = 20;
export const GUESTBOOK_MAX_LIMIT = 50;
export const GUESTBOOK_RATE_WINDOW_MS = 60_000;
export const GUESTBOOK_RATE_LIMIT = 5;
export const GUESTBOOK_CURSOR_SECRET_MIN_LENGTH = 16;
export const GUESTBOOK_RATE_SECRET_MIN_LENGTH = 32;

const CATEGORIES = new Set<GuestbookCategory>(['buy', 'sell', 'suggestion']);
const DURATIONS = new Set(['1d', '3d', '7d', 'permanent']);

export class GuestbookValidationError extends Error {
  constructor(message: string, public readonly field?: string) { super(message); this.name = 'GuestbookValidationError'; }
}

export interface GuestbookSubmissionInput {
  category: GuestbookCategory;
  itemId: number | null;
  isZeny: boolean;
  contact: string | null;
  content: string;
  expiresAt: number | null;
}

function normalizeText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new GuestbookValidationError(`${field} must be text`, field);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || [...normalized].length > maximum) throw new GuestbookValidationError(`${field} is required and must be at most ${maximum} characters`, field);
  return normalized;
}

export function parseGuestbookSubmission(value: unknown, validItemIds?: ReadonlySet<number>, now = Date.now()): GuestbookSubmissionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GuestbookValidationError('Request body must be an object');
  const raw = value as Record<string, unknown>;
  if (typeof raw.category !== 'string' || !CATEGORIES.has(raw.category as GuestbookCategory)) throw new GuestbookValidationError('category is invalid', 'category');
  const category = raw.category as GuestbookCategory;
  const content = normalizeText(raw.content, 'content', GUESTBOOK_MAX_CONTENT_LENGTH);

  if (category === 'suggestion') {
    if (['itemId', 'item_id', 'isZeny', 'is_zeny', 'contact', 'duration'].some((key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== false && raw[key] !== '')) {
      throw new GuestbookValidationError('suggestion cannot include trade fields', 'category');
    }
    return { category, itemId: null, isZeny: false, contact: null, content, expiresAt: null };
  }

  const contact = normalizeText(raw.contact, 'contact', GUESTBOOK_MAX_CONTACT_LENGTH);
  if (typeof raw.duration !== 'string' || !DURATIONS.has(raw.duration)) throw new GuestbookValidationError('duration must be 1d, 3d, 7d or permanent', 'duration');
  if (typeof raw.isZeny !== 'boolean') throw new GuestbookValidationError('isZeny must be boolean', 'isZeny');
  let itemId: number | null = null;
  if (raw.isZeny) {
    if (raw.itemId !== undefined && raw.itemId !== null && raw.itemId !== '') throw new GuestbookValidationError('Zeny cannot have an itemId', 'itemId');
  } else {
    if (typeof raw.itemId !== 'number' || !Number.isSafeInteger(raw.itemId) || raw.itemId <= 0) throw new GuestbookValidationError('itemId must be a positive catalog item ID', 'itemId');
    if (validItemIds && !validItemIds.has(raw.itemId)) throw new GuestbookValidationError('itemId is not in the item catalog', 'itemId');
    itemId = raw.itemId;
  }
  const days = raw.duration === '1d' ? 1 : raw.duration === '3d' ? 3 : raw.duration === '7d' ? 7 : null;
  return { category, itemId, isZeny: raw.isZeny, contact, content, expiresAt: days === null ? null : now + days * 24 * 60 * 60 * 1000 };
}

export function parseGuestbookFilters(params: URLSearchParams): Omit<GuestbookFilters, 'context'> {
  const rawCategory = params.get('category');
  if (rawCategory && !CATEGORIES.has(rawCategory as GuestbookCategory)) throw new GuestbookValidationError('category is invalid', 'category');
  const rawItemId = params.get('item_id');
  let itemId: number | undefined;
  if (rawItemId !== null) {
    if (!/^\d+$/u.test(rawItemId) || !Number.isSafeInteger(Number(rawItemId)) || Number(rawItemId) <= 0) throw new GuestbookValidationError('item_id is invalid', 'item_id');
    itemId = Number(rawItemId);
  }
  const rawQuery = params.get('q') ?? '';
  const q = rawQuery.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if ([...q].length > GUESTBOOK_MAX_QUERY_LENGTH) throw new GuestbookValidationError('q is too long', 'q');
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^\d+$/u.test(rawLimit)) throw new GuestbookValidationError('limit is invalid', 'limit');
  const parsedLimit = rawLimit === null ? GUESTBOOK_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) throw new GuestbookValidationError('limit must be at least 1', 'limit');
  const cursor = params.get('cursor') ?? undefined;
  if (cursor && (cursor.length > 512 || !/^[A-Za-z0-9_.-]+$/u.test(cursor))) throw new GuestbookValidationError('cursor is invalid', 'cursor');
  return {
    ...(rawCategory ? { category: rawCategory as GuestbookCategory } : {}),
    ...(itemId === undefined ? {} : { itemId }),
    ...(q ? { q } : {}),
    limit: Math.min(parsedLimit, GUESTBOOK_MAX_LIMIT),
    ...(cursor ? { cursor } : {}),
  };
}

interface GuestbookCursor { createdAt: number; id: number; context: string; }

function hmac(value: string, secret: string): string {
  if (secret.length < GUESTBOOK_CURSOR_SECRET_MIN_LENGTH) throw new GuestbookValidationError('cursor secret is not configured');
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function encodeGuestbookCursor(value: GuestbookCursor, secret: string): string {
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.id) || value.id <= 0) throw new GuestbookValidationError('cursor values are invalid');
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'guestbook', ...value })))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  return `${body}.${hmac(body, secret)}`;
}

export function decodeGuestbookCursor(token: string, expectedContext: string, secret: string): GuestbookCursor {
  if (token.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) throw new GuestbookValidationError('cursor is invalid', 'cursor');
  const separator = token.lastIndexOf('.');
  const body = token.slice(0, separator);
  const actual = token.slice(separator + 1);
  const expected = hmac(body, secret);
  if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new GuestbookValidationError('cursor is invalid', 'cursor');
  try {
    const encoded = body.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - body.length % 4) % 4);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (value.version !== 1 || value.kind !== 'guestbook' || value.context !== expectedContext
      || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
      || !Number.isSafeInteger(value.id) || Number(value.id) <= 0) throw new Error();
    return { createdAt: Number(value.createdAt), id: Number(value.id), context: expectedContext };
  } catch {
    throw new GuestbookValidationError('cursor is invalid', 'cursor');
  }
}

export function guestbookCursorContext(filters: Omit<GuestbookFilters, 'cursor' | 'context'>): string {
  const canonical = JSON.stringify({ category: filters.category ?? null, itemId: filters.itemId ?? null, q: filters.q ?? null, limit: filters.limit });
  return btoa(String.fromCharCode(...new TextEncoder().encode(canonical))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}
