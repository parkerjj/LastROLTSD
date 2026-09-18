import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerHistoryRoute } from '../src/routes/history';
import { encodeHistoryCursor } from '../src/domain/search';

describe('history route', () => { it('returns a bounded history page', async () => { const app = new Hono(); registerHistoryRoute(app, { getListingHistory: async () => ({ items: [], nextCursor: null }) } as never); const response = await app.request('/api/v1/market/listings/1/history?limit=100'); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('max-age=30'); }); });

it('returns 404 when the repository reports an unknown listing', async () => {
  const app = new Hono();
  registerHistoryRoute(app, { getListingHistory: async () => null } as never);
  const response = await app.request('/api/v1/market/listings/999/history');
  expect(response.status).toBe(404);
});

it('rejects malformed opaque history cursors', async () => {
  const app = new Hono();
  registerHistoryRoute(app, { getListingHistory: async () => ({ items: [], nextCursor: null }) } as never);
  const response = await app.request('/api/v1/market/listings/1/history?cursor=not-a-valid-cursor');
  expect(response.status).toBe(400);
});

it('passes an opaque history cursor to the repository', async () => {
  const app = new Hono();
  const cursor = encodeHistoryCursor(18);
  let received: string | undefined;
  registerHistoryRoute(app, { getListingHistory: async (_id: number, _limit: number, value?: string) => { received = value; return { items: [], nextCursor: null }; } } as never);
  const response = await app.request(`/api/v1/market/listings/1/history?cursor=${cursor}`);
  expect(response.status).toBe(200);
  expect(received).toBe(cursor);
});

it('rejects malformed history cursors before reaching the repository', async () => {
  const app = new Hono();
  let called = false;
  registerHistoryRoute(app, { getListingHistory: async () => { called = true; return { items: [], nextCursor: null }; } } as never);
  const response = await app.request('/api/v1/market/listings/1/history?cursor=not-a-number');
  expect(response.status).toBe(400);
  expect(called).toBe(false);
});

it('rejects oversized history cursors before reaching the repository', async () => {
  const app = new Hono();
  let called = false;
  registerHistoryRoute(app, { getListingHistory: async () => { called = true; return { items: [], nextCursor: null }; } } as never);
  const response = await app.request(`/api/v1/market/listings/1/history?cursor=${'a'.repeat(129)}`);
  expect(response.status).toBe(400);
  expect(called).toBe(false);
});

it('returns inferred sale details alongside price history', async () => {
  const app = new Hono();
  registerHistoryRoute(app, { getListingHistory: async () => ({ items: [{ id: 1, listingId: 1, observedAt: 10, price: 100, quantity: 0, eventType: 'quantity_changed', batchId: 'b' }], inferredSales: [{ observedAt: 10, soldQuantity: 2, fromQuantity: 2, toQuantity: 0, reason: 'sold_out' }], nextCursor: null }) } as never);
  const response = await app.request('/api/v1/market/listings/1/history');
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.inferredSales[0].reason).toBe('sold_out');
});
