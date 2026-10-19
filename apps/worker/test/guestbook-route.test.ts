import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerGuestbookRoutes, type GuestbookAuthServices } from '../src/routes/guestbook';
import type { GuestbookEntry, GuestbookRepository } from '../src/db/guestbook-repository';
import { AuthFailure } from '../src/auth/types';

const authed: GuestbookAuthServices = {
  authenticate: async () => ({ userId: "10002", status: "ACTIVE" as const, credentialVersion: 1, authVersion: 1, sessionDigest: new Uint8Array(32) }),
  assertSession: async () => {},
};

function createTestApp(repo: GuestbookRepository, options: { itemIds?: Set<number>; auth?: GuestbookAuthServices | null } = {}) {
  const app = new Hono();
  registerGuestbookRoutes(app, repo, {
    getItemIds: async () => options.itemIds ?? new Set([100]),
    rateSecret: '0123456789abcdef0123456789abcdef',
    cursorSecret: 'abcdef0123456789abcdef0123456789',
    auth: options.auth === undefined ? authed : options.auth,
  });
  return app;
}

function post(app: Hono<any>, path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function patch(app: Hono<any>, path: string, body: unknown) {
  return app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const entryFixture = (overrides: Partial<GuestbookEntry> = {}): GuestbookEntry => ({
  id: 1, category: 'sell', itemId: 100, isZeny: false, contact: null, content: 'hello',
  createdAt: 1, expiresAt: null, isExpired: false, editedAt: null, author: null, replies: [],
  replyCount: 0, hasMoreReplies: false, hasReplied: null,
  ...overrides,
});

describe('guestbook routes', () => {
  it('returns expired entries rather than filtering them', async () => {
    const repo = { search: async () => ({ items: [entryFixture({ content: 'expired', expiresAt: 2, isExpired: true })], nextCursor: null }) } as unknown as GuestbookRepository;
    const response = await createTestApp(repo).request('/api/v1/guestbook');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ content: 'expired', isExpired: true }] });
  });

  it('rejects unknown catalog IDs and rate limits before reporting success', async () => {
    let createCalls = 0;
    const repo = {
      search: async () => ({ items: [], nextCursor: null }),
      create: async () => { createCalls += 1; return { status: 'rate_limited' } as const; },
    } as unknown as GuestbookRepository;
    const app = createTestApp(repo);
    const unknown = await post(app, '/api/v1/guestbook', { category: 'buy', itemId: 999, isZeny: false, content: 'buy', duration: '1d' });
    expect(unknown.status).toBe(400);
    const limited = await post(app, '/api/v1/guestbook', { category: 'suggestion', content: 'suggestion' });
    expect(limited.status).toBe(429);
    expect(createCalls).toBe(1);
  });

  it('rejects oversized request bodies before parsing them', async () => {
    const repo = { search: async () => ({ items: [], nextCursor: null }) } as unknown as GuestbookRepository;
    const response = await post(createTestApp(repo), '/api/v1/guestbook', { category: 'suggestion', content: 'x'.repeat(20_000) });
    expect(response.status).toBe(413);
  });

  it('returns 503 on write routes when the auth service is unavailable', async () => {
    const repo = { search: async () => ({ items: [], nextCursor: null }) } as unknown as GuestbookRepository;
    const app = createTestApp(repo, { auth: null });
    const created = await post(app, '/api/v1/guestbook', { category: 'suggestion', content: '建议' });
    expect(created.status).toBe(503);
    expect(await created.json()).toMatchObject({ error: { code: 'auth_unavailable' } });
    const edited = await patch(app, '/api/v1/guestbook/1', { content: '改' });
    expect(edited.status).toBe(503);
    const replied = await post(app, '/api/v1/guestbook/1/replies', { content: '回复' });
    expect(replied.status).toBe(503);
    const replyEdited = await patch(app, '/api/v1/guestbook/replies/1', { content: '改' });
    expect(replyEdited.status).toBe(503);
  });

  it('maps AuthFailure from the session layer to its status code', async () => {
    const auth: GuestbookAuthServices = {
      authenticate: async () => { throw new AuthFailure('AUTH_SESSION_INVALID', 401, '请先登录'); },
      assertSession: async () => {},
    };
    const repo = { search: async () => ({ items: [], nextCursor: null }) } as unknown as GuestbookRepository;
    const response = await post(createTestApp(repo, { auth }), '/api/v1/guestbook', { category: 'suggestion', content: '建议' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_SESSION_INVALID', message: '请先登录' } });
  });

  it('creates entries for signed-in users and returns the stored row', async () => {
    let createdWith: { userId?: string } = {};
    const stored = entryFixture({ id: 9, content: '建议', category: 'suggestion', itemId: null });
    const repo = {
      create: async (_input: unknown, userId: string) => { createdWith = { userId }; return { status: 'created', id: 9 } as const; },
      readById: async () => stored,
    } as unknown as GuestbookRepository;
    const response = await post(createTestApp(repo), '/api/v1/guestbook', { category: 'suggestion', content: '建议' });
    expect(response.status).toBe(201);
    expect(createdWith.userId).toBe('10002');
    expect(await response.json()).toMatchObject({ item: { id: 9, content: '建议' } });
  });

  it('still allows suggestions when the item catalog is unavailable, but trades fail closed', async () => {
    let catalogCalls = 0;
    const repo = {
      create: async () => ({ status: 'created', id: 3 } as const),
      readById: async () => entryFixture({ id: 3 }),
    } as unknown as GuestbookRepository;
    const app = new Hono();
    registerGuestbookRoutes(app, repo, {
      getItemIds: async () => { catalogCalls += 1; throw new Error('catalog asset unavailable'); },
      rateSecret: '0123456789abcdef0123456789abcdef',
      cursorSecret: 'abcdef0123456789abcdef0123456789',
      auth: authed,
    });
    const suggestion = await post(app, '/api/v1/guestbook', { category: 'suggestion', content: '建议' });
    expect(suggestion.status).toBe(201);
    expect(catalogCalls).toBe(0);
    const trade = await post(app, '/api/v1/guestbook', { category: 'buy', itemId: 100, isZeny: false, content: '收购', duration: '1d' });
    expect(trade.status).toBe(500);
    await expect(trade.json()).resolves.toMatchObject({ error: { code: 'internal_error', message: 'Internal Server Error' } });
    expect(catalogCalls).toBe(1);
  });

  it('edits only the author\'s own entries and distinguishes 403 from 404', async () => {
    const existing = entryFixture({ id: 5 });
    const repo = {
      updateEntryContent: async (_id: number, _userId: string, _content: string, editedAt: number) => {
        existing.editedAt = editedAt;
        return true;
      },
      readById: async () => existing,
    } as unknown as GuestbookRepository;
    const ok = await patch(createTestApp(repo), '/api/v1/guestbook/5', { content: '改后的内容' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ item: { id: 5 } });

    const otherRepo = { updateEntryContent: async () => false, readById: async () => existing } as unknown as GuestbookRepository;
    const forbidden = await patch(createTestApp(otherRepo), '/api/v1/guestbook/5', { content: '改' });
    expect(forbidden.status).toBe(403);
    const missingRepo = { updateEntryContent: async () => false, readById: async () => null } as unknown as GuestbookRepository;
    const missing = await patch(createTestApp(missingRepo), '/api/v1/guestbook/5', { content: '改' });
    expect(missing.status).toBe(404);
    const invalid = await patch(createTestApp(otherRepo), '/api/v1/guestbook/abc', { content: '改' });
    expect(invalid.status).toBe(400);
  });

  it('creates replies with per-user uniqueness enforced by the repository', async () => {
    const reply = { id: 11, entryId: 5, content: '回复', createdAt: 10, editedAt: null, author: { userId: '10002', displayName: '小明', hasAvatar: false, avatarVersion: 0, avatarUrl: '/api/v1/users/10002/avatar?v=0', permission_level: 1 } };
    const repo = {
      createReply: async () => ({ status: 'created', id: 11 } as const),
      readById: async () => entryFixture({ id: 5, replies: [reply] }),
    } as unknown as GuestbookRepository;
    const created = await post(createTestApp(repo), '/api/v1/guestbook/5/replies', { content: '回复' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ item: { id: 11, content: '回复' } });

    const dupRepo = { createReply: async () => ({ status: 'duplicate' } as const) } as unknown as GuestbookRepository;
    const duplicate = await post(createTestApp(dupRepo), '/api/v1/guestbook/5/replies', { content: '再来一条' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'reply_exists' } });

    const missingRepo = { createReply: async () => ({ status: 'entry_not_found' } as const) } as unknown as GuestbookRepository;
    const missing = await post(createTestApp(missingRepo), '/api/v1/guestbook/999/replies', { content: '回复' });
    expect(missing.status).toBe(404);

    const limitedRepo = { createReply: async () => ({ status: 'rate_limited' } as const) } as unknown as GuestbookRepository;
    const limited = await post(createTestApp(limitedRepo), '/api/v1/guestbook/5/replies', { content: '回复' });
    expect(limited.status).toBe(429);
  });

  it('edits replies only for their author', async () => {
    const repo = { updateReplyContent: async () => true } as unknown as GuestbookRepository;
    const ok = await patch(createTestApp(repo), '/api/v1/guestbook/replies/11', { content: '改后的回复' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ item: { id: 11, content: '改后的回复' } });
    const missingRepo = { updateReplyContent: async () => false } as unknown as GuestbookRepository;
    const missing = await patch(createTestApp(missingRepo), '/api/v1/guestbook/replies/11', { content: '改' });
    expect(missing.status).toBe(404);
  });
});
