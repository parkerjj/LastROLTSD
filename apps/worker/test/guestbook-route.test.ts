import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerGuestbookRoutes } from '../src/routes/guestbook';
import type { GuestbookRepository } from '../src/db/guestbook-repository';

function createTestApp(repo: GuestbookRepository, itemIds = new Set([100])) {
  const app = new Hono();
  registerGuestbookRoutes(app, repo, { getItemIds: async () => itemIds, rateSecret: '0123456789abcdef0123456789abcdef', cursorSecret: 'abcdef0123456789abcdef0123456789' });
  return app;
}

describe('guestbook routes', () => {
  it('returns expired entries rather than filtering them', async () => {
    const repo = { search: async () => ({ items: [{ id: 1, category: 'sell', itemId: 100, isZeny: false, contact: 'QQ', content: 'expired', createdAt: 1, expiresAt: 2, isExpired: true }], nextCursor: null }) } as unknown as GuestbookRepository;
    const response = await createTestApp(repo).request('/api/v1/guestbook');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ content: 'expired', isExpired: true }] });
  });

  it('rejects unknown catalog IDs and rate limits before reporting success', async () => {
    let createCalls = 0;
    const repo = {
      search: async () => ({ items: [], nextCursor: null }),
      create: async () => { createCalls += 1; return 'rate_limited' as const; },
    } as unknown as GuestbookRepository;
    const app = createTestApp(repo);
    const unknown = await app.request('/api/v1/guestbook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'buy', itemId: 999, content: 'buy', contact: 'qq', duration: '1d' }) });
    expect(unknown.status).toBe(400);
    const limited = await app.request('/api/v1/guestbook', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ category: 'suggestion', content: 'suggestion' }) });
    expect(limited.status).toBe(429);
    expect(createCalls).toBe(1);
  });

  it('rejects oversized request bodies before parsing them', async () => {
    const repo = { search: async () => ({ items: [], nextCursor: null }) } as unknown as GuestbookRepository;
    const body = JSON.stringify({ category: 'suggestion', content: 'x'.repeat(20_000) });
    const response = await createTestApp(repo).request('/api/v1/guestbook', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(response.status).toBe(413);
  });

  it('allows anonymous suggestions when the item catalog is unavailable', async () => {
    let createCalls = 0;
    let catalogCalls = 0;
    const repo = {
      search: async () => ({ items: [], nextCursor: null }),
      create: async () => { createCalls += 1; return 'created' as const; },
    } as unknown as GuestbookRepository;
    const app = new Hono();
    registerGuestbookRoutes(app, repo, {
      getItemIds: async () => { catalogCalls += 1; throw new Error('catalog asset unavailable'); },
      rateSecret: '0123456789abcdef0123456789abcdef',
      cursorSecret: 'abcdef0123456789abcdef0123456789',
    });
    const suggestion = await app.request('/api/v1/guestbook', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'suggestion', content: '建议' }),
    });
    expect(suggestion.status).toBe(201);
    expect(catalogCalls).toBe(0);
    const trade = await app.request('/api/v1/guestbook', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'buy', itemId: 100, isZeny: false, contact: 'QQ', content: '收购', duration: '1d' }),
    });
    expect(trade.status).toBe(500);
    await expect(trade.json()).resolves.toMatchObject({ error: { code: 'internal_error', message: 'Internal Server Error' } });
    expect(createCalls).toBe(1);
    expect(catalogCalls).toBe(1);
  });
});
