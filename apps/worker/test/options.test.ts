import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerOptionsRoute } from '../src/routes/options';

describe('options route', () => { it('returns dictionary cache headers and etag', async () => { const app = new Hono(); registerOptionsRoute(app, { getOptionDictionary: async () => [{ version: 'v1', optionType: 1, optionValue: 2, optionParam: 0, name: 'Attack', description: '', searchTokens: 'attack' }] } as never); const response = await app.request('/api/v1/options'); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('86400'); expect(response.headers.get('etag')).toBeTruthy(); }); });

it('creates an ETag for non-ASCII option dictionary text', async () => {
  const app = new Hono();
  registerOptionsRoute(app, { getOptionDictionary: async () => [{ version: 'v1', optionType: 1, optionValue: 2, optionParam: 0, name: '攻擊', description: '力量', searchTokens: 'attack' }] } as never);
  const response = await app.request('/api/v1/options');
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/);
});
