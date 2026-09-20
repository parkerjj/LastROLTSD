import type { Hono } from 'hono';
import type { MarketRepository } from '../db/repository';
import { withQueryCacheHeaders } from '../middleware/cache';
import { jsonError, requestId, statusForError } from '../middleware/errors';

export function registerOptionsRoute(app: Hono<any>, repo: MarketRepository): void {
  app.get('/api/v1/options', async (c) => {
    try {
      const data = await repo.getOptionDefinitions(c.req.query('version'));
      const payload = {
        version: data.version,
        options: data.items.map((definition) => ({
          type: definition.type,
          handle: definition.handle,
          label_zh: definition.labelZh,
          description_template: definition.descriptionTemplate,
          value_kind: definition.valueType,
          unit: definition.unit,
          scale: definition.scale,
          allowed_operators: definition.allowedOperators,
          param_policy: definition.paramPolicy,
          repeat_policy: definition.repeatPolicy,
          display_template: definition.displayTemplate,
          search_tokens: definition.searchTokens ?? [],
        })),
      };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
      const etag = `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}"`;
      if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'public, max-age=86400' } });
      return withQueryCacheHeaders(c.json(payload), 'options', etag);
    } catch (error) {
      const status = statusForError(error);
      if (status === 400) return jsonError('bad_request', error instanceof Error ? error.message : 'Invalid option version', status, requestId(c.req.raw));
      throw error;
    }
  });
}
