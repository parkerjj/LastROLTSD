import mysql from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { encodeCursor, searchCursorContext, SEARCH_INDEX_VERSION } from '../src/domain/search';
import { OPTION_DEFINITIONS_VERSION } from '../src/domain/option-definitions';

const bindings = { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MYSQL_URL: 'mysql://test:secret@localhost/test', CURSOR_SECRET: 'test-cursor-secret-123' };
const url = 'https://example.test/api/v1/market/search?limit=20&sort=changed_desc';

describe('search edge cache', () => {
  let entries: Map<string, { body: string; headers: Headers }>;
  let databaseReads: number;
  let closed: number;
  let failDatabase: boolean;
  let edgeCache: { match: (request: Request) => Promise<Response | undefined>; put: (request: Request, response: Response) => Promise<void> };

  beforeEach(() => {
    entries = new Map();
    databaseReads = 0;
    closed = 0;
    failDatabase = false;
    edgeCache = {
      async match(request) {
        const stored = entries.get(request.url);
        return stored ? new Response(stored.body, { headers: stored.headers }) : undefined;
      },
      async put(request, response) {
        entries.set(request.url, { body: await response.text(), headers: new Headers(response.headers) });
      },
    };
    vi.stubGlobal('caches', { default: edgeCache });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(mysql, 'createPool').mockImplementation(() => ({
      on: vi.fn(),
      async execute() {
        databaseReads++;
        if (failDatabase) throw new Error('database unavailable');
        return [[], []];
      },
      async end() { closed++; },
    }) as unknown as mysql.Pool);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('serves a repeated search without opening MySQL and uses a fresh request ID', async () => {
    const first = await worker.fetch(new Request(url, { headers: { 'cf-ray': 'first' } }), bindings);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-search-cache')).toBe('MISS');
    const second = await worker.fetch(new Request(url, { headers: { 'cf-ray': 'second' } }), bindings);
    expect(await second.json()).toEqual({ items: [], nextCursor: null });
    expect(second.headers.get('x-search-cache')).toBe('HIT');
    expect(second.headers.get('x-request-id')).toBe('second');
    expect(databaseReads).toBe(1);
    expect(closed).toBe(1);
    expect([...entries.values()][0]?.headers.has('x-request-id')).toBe(false);
  });

  it('expires results and does not extend browser freshness on a cache hit', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await worker.fetch(new Request(url), bindings);
    now += 20_000;
    const cached = await worker.fetch(new Request(url), bindings);
    expect(cached.headers.get('cache-control')).toBe('public, max-age=10, s-maxage=10');
    now += 10_000;
    await worker.fetch(new Request(url), bindings);
    expect(databaseReads).toBe(2);
  });

  it('isolates query strings, origins, releases, signing secrets and databases', async () => {
    await worker.fetch(new Request(url), bindings);
    await worker.fetch(new Request(url + '&item_id=501'), bindings);
    await worker.fetch(new Request(url.replace('example.test', 'other.test')), bindings);
    for (const change of [
      { BUILD_VERSION: 'next' }, { CURSOR_SECRET: 'rotated-secret-123456' },
      { MYSQL_URL: 'mysql://test:secret@localhost/other' }, { ENVIRONMENT: 'another' },
    ]) await worker.fetch(new Request(url), { ...bindings, ...change });
    expect(databaseReads).toBe(7);
    expect(entries.size).toBe(7);
    expect([...entries.keys()].join(' ')).not.toContain('secret');
  });

  it.each([
    { authorization: 'Bearer test' },
    { 'cache-control': 'no-store' }, { 'cache-control': 'no-cache' }, { range: 'bytes=0-10' },
  ])('bypasses shared caching for request headers %j', async (headers) => {
    await worker.fetch(new Request(url), bindings);
    await worker.fetch(new Request(url, { headers }), bindings);
    expect(databaseReads).toBe(2);
    expect(entries.size).toBe(1);
  });

  it('shares public results with browsers carrying analytics cookies', async () => {
    const first = await worker.fetch(new Request(url), bindings);
    const second = await worker.fetch(new Request(url, { headers: { cookie: '_ga=analytics-client; _ga_site=analytics-session' } }), bindings);
    expect(second.headers.get('x-search-cache')).toBe('HIT');
    expect(await second.json()).toEqual(await first.json());
    expect(databaseReads).toBe(1);
  });

  it('does not cache invalid queries or database failures and closes failed connections', async () => {
    const invalid = await worker.fetch(new Request(url + '&price_min=bad'), bindings);
    expect(invalid.status).toBe(400);
    failDatabase = true;
    expect((await worker.fetch(new Request(url), bindings)).status).toBe(500);
    failDatabase = false;
    expect((await worker.fetch(new Request(url), bindings)).status).toBe(200);
    expect(databaseReads).toBe(2);
    expect(closed).toBe(2);
    expect(entries.size).toBe(1);
  });

  it.each(['match', 'put'] as const)('keeps search available when cache %s fails', async (operation) => {
    vi.spyOn(edgeCache, operation).mockRejectedValue(new Error('cache unavailable'));
    const response = await worker.fetch(new Request(url), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(closed).toBe(1);
  });

  it('does not use search caching for other routes or HEAD requests', async () => {
    await worker.fetch(new Request(url, { method: 'HEAD' }), bindings);
    await worker.fetch(new Request('https://example.test/api/v1/status'), bindings);
    expect(entries.size).toBe(0);
  });

  it('validates cursor signatures and filter context on the fast path before any SQL', async () => {
    const context = searchCursorContext({ limit: 20, sort: 'changed_desc', catalogVersion: 'static', optionVersion: OPTION_DEFINITIONS_VERSION, searchIndexVersion: SEARCH_INDEX_VERSION });
    const cursor = encodeCursor({ sort: 'changed_desc', sortValue: 1000, id: 42, context }, bindings.CURSOR_SECRET);
    expect((await worker.fetch(new Request(`${url}&cursor=${cursor}`), bindings)).status).toBe(200);
    expect(databaseReads).toBe(1);
    for (const invalidUrl of [
      `${url}&cursor=${cursor}&item_id=501`,
      `${url}&cursor=${cursor.slice(0, -1)}!`,
      `${url}&cursor=${cursor.slice(0, -5)}AAAAA`,
    ]) {
      const invalid = await worker.fetch(new Request(invalidUrl, { headers: { 'cf-ray': 'invalid-cursor' } }), bindings);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'bad_request', request_id: 'invalid-cursor' } });
    }
    expect(databaseReads).toBe(1);
    expect(entries.size).toBe(1);
  });

  it('keeps cache writes alive with waitUntil and handles asynchronous write failures', async () => {
    let finish: () => void = () => {};
    const writeBlocked = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(edgeCache, 'put').mockImplementation(async () => { await writeBlocked; throw new Error('cache unavailable'); });
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(new Request(url), bindings, { waitUntil: (promise) => { pending.push(promise); } });
    expect(response.status).toBe(200);
    expect(closed).toBe(1);
    expect(pending).toHaveLength(1);
    finish();
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
  });
});
