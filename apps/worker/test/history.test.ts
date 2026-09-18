import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerHistoryRoute } from '../src/routes/history';

describe('history route', () => { it('returns a bounded history page', async () => { const app = new Hono(); registerHistoryRoute(app, { getListingHistory: async () => ({ items: [], nextCursor: null }) } as never); const response = await app.request('/api/v1/market/listings/1/history?limit=100'); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('max-age=30'); }); });
