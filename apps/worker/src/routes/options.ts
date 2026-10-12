import type { Hono } from 'hono';
import type { MarketRepository } from '../db/repository';
import { withQueryCacheHeaders } from '../middleware/cache';
import { jsonError, requestId, statusForError } from '../middleware/errors';

// The option dictionary is immutable per build. Share its serialized response
// across requests in an isolate, not only the TypeScript definitions array.
// Keying by the definitions array also keeps injected repositories isolated.
type OptionData = Awaited<ReturnType<MarketRepository['getOptionDefinitions']>>;
type EncodedOptions = { json: string; etag: string };
const responseCache = new WeakMap<object, { version: string; result: Promise<EncodedOptions> }>();

async function encodedOptions(data: OptionData): Promise<EncodedOptions> {
  const cached = responseCache.get(data.items);
  if (cached?.version === data.version) return cached.result;

  const result = (async (): Promise<EncodedOptions> => {
    const payload = {
      version: data.version,
      options: data.items.map((definition) => ({
        type: definition.type,
        handle: definition.handle,
        label_zh: definition.labelZh,
        description_template: definition.descriptionTemplate,
        value_kind: definition.valueType,
        value_policy: definition.valuePolicy ?? 'numeric',
        selectable: definition.selectable ?? true,
        unit: definition.unit,
        scale: definition.scale,
        allowed_operators: definition.allowedOperators,
        param_policy: definition.paramPolicy,
        repeat_policy: definition.repeatPolicy,
        display_template: definition.displayTemplate,
        search_tokens: definition.searchTokens ?? [],
      })),
    };
    const json = JSON.stringify(payload);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
    const etag = `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}"`;
    return { json, etag };
  })();
  responseCache.set(data.items, { version: data.version, result });
  // A transient digest failure must not poison subsequent requests.
  void result.catch(() => {
    if (responseCache.get(data.items)?.result === result) responseCache.delete(data.items);
  });
  return result;
}

export function registerOptionsRoute(app: Hono<any>, repo: MarketRepository): void {
  app.get('/api/v1/options', async (c) => {
    try {
      // Validate the requested version on every call, including 304 responses.
      const data = await repo.getOptionDefinitions(c.req.query('version'));
      const { json, etag } = await encodedOptions(data);
      if (c.req.header('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { etag, 'cache-control': 'public, max-age=86400' } });
      }
      return withQueryCacheHeaders(new Response(json, {
        headers: { 'content-type': 'application/json; charset=UTF-8' },
      }), 'options', etag);
    } catch (error) {
      const status = statusForError(error);
      if (status === 400) return jsonError('bad_request', error instanceof Error ? error.message : 'Invalid option version', status, requestId(c.req.raw));
      throw error;
    }
  });
}
