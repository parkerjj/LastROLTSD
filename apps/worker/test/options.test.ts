import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerOptionsRoute } from '../src/routes/options';
import type { OptionDefinition } from '../src/domain/option-conditions';

const definition: OptionDefinition = { type: 12, handle: 'VAR_SPACCELERATION', labelZh: 'SP恢复速度增加数值%', descriptionTemplate: 'SP恢复速度增加{value}%', valueType: 'integer', unit: '', scale: 1, allowedOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'], paramPolicy: { mode: 'ignored', filterable: false }, repeatPolicy: 'same', displayTemplate: 'SP恢复速度增加{value}%' };

describe('options route', () => {
  it('returns stable type-level option definitions with version and cache metadata', async () => {
    const app = new Hono();
    registerOptionsRoute(app, { getOptionDefinitions: async () => ({ version: 'options-lastro-70.84', items: [definition] }) } as never);
    const response = await app.request('/api/v1/options');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 'options-lastro-70.84',
      options: [{
        type: 12,
        handle: 'VAR_SPACCELERATION',
        label_zh: 'SP恢复速度增加数值%',
        description_template: 'SP恢复速度增加{value}%',
        value_kind: 'integer',
        unit: '',
        scale: 1,
        allowed_operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
        param_policy: { mode: 'ignored', filterable: false },
        repeat_policy: 'same',
        display_template: 'SP恢复速度增加{value}%',
        search_tokens: [],
      }],
    });
    expect(response.headers.get('cache-control')).toContain('86400');
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('returns 304 for the matching ETag', async () => {
    const app = new Hono();
    registerOptionsRoute(app, { getOptionDefinitions: async () => ({ version: 'v1', items: [definition] }) } as never);
    const first = await app.request('/api/v1/options');
    const second = await app.request('/api/v1/options', { headers: { 'if-none-match': first.headers.get('etag')! } });
    expect(second.status).toBe(304);
    expect(second.headers.get('cache-control')).toContain('86400');
  });

  it('uses the standard error envelope for unknown definition version', async () => {
    const app = new Hono();
    registerOptionsRoute(app, { getOptionDefinitions: async () => { throw Object.assign(new Error('Unknown option version'), { status: 400 }); } } as never);
    const response = await app.request('/api/v1/options?version=missing');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_request', message: 'Unknown option version' } });
  });
});
