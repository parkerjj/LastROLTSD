import type { Hono } from 'hono';
import type { AppEnv } from '../env';

/**
 * KoreEngine 脱机版下载路由。
 *
 * 发行清单由 KoreEngine main 的发布流程原子写入 R2：
 *   https://client.ltsd.ro/ke/standalone/releases.json
 *
 * - GET /ke/download?platform=windows|android
 *     读取清单并 302 到对应安装包；缺条目 / 上游失败时回到下载页并带提示参数。
 * - GET /ke/download（不带 platform）
 *     交给 ASSETS 渲染前端下载页。
 * - GET /api/v1/ke/downloads
 *     返回清洗后的清单，供下载页展示版本号、大小与 SHA-256。
 */

const DEFAULT_MANIFEST_URL = 'https://client.ltsd.ro/ke/standalone/releases.json';
const DOWNLOAD_PLATFORMS = ['windows', 'android'] as const;
const SUPPORTED_PLATFORMS = ['windows', 'android', 'macos', 'ios'] as const;
type DownloadPlatform = (typeof SUPPORTED_PLATFORMS)[number];

const MANIFEST_CACHE_TTL_MS = 5 * 60_000;
const RESPONSE_CACHE_CONTROL = 'public, max-age=300, s-maxage=1800';
const PAGE_FALLBACK_CACHE_CONTROL = 'no-store';

interface KeDownloadEntry {
  version: string;
  url: string;
  fileName: string;
  versionCode?: number;
  sha256?: string;
  size?: number;
  minOs?: string;
  abi?: string;
  notes?: string;
  publishedAt?: string;
}

interface KeDownloadManifest {
  schemaVersion: 1;
  channel?: string;
  generatedAt?: string;
  platforms: Partial<Record<DownloadPlatform, KeDownloadEntry>>;
}

interface ManifestCacheEntry {
  manifest: KeDownloadManifest;
  expiresAt: number;
}

let manifestCache: ManifestCacheEntry | undefined;

/** 仅供测试：清空内存中的发行清单缓存。 */
export function resetKeDownloadCacheForTesting(): void {
  manifestCache = undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isSupportedPlatform(value: string): value is DownloadPlatform {
  return (DOWNLOAD_PLATFORMS as readonly string[]).includes(value);
}

function isKnownPlatform(value: string): value is DownloadPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

/** 相对路径按 releases.json 所在目录解析；只接受 HTTPS（本机回环除外）。 */
function resolveDownloadUrl(rawUrl: string, manifestUrl: string): string | null {
  if (rawUrl.includes('..')) return null;
  try {
    const base = new URL(manifestUrl);
    const resolved = new URL(rawUrl, base);
    const localHttp =
      base.protocol === 'http:' &&
      (base.hostname === '127.0.0.1' || base.hostname === 'localhost' || base.hostname === '[::1]');
    if (resolved.protocol !== 'https:' && !(localHttp && resolved.protocol === 'http:')) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function fileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segment = pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : '';
  } catch {
    return '';
  }
}

function sanitizeEntry(value: unknown, manifestUrl: string): KeDownloadEntry | null {
  if (!isRecord(value)) return null;
  const version = nonEmptyString(value.version);
  const rawUrl = nonEmptyString(value.url);
  if (!version || !rawUrl) return null;
  const url = resolveDownloadUrl(rawUrl, manifestUrl);
  if (!url) return null;

  const sha256 = nonEmptyString(value.sha256);
  const entry: KeDownloadEntry = {
    version,
    url,
    fileName: fileNameFromUrl(url) || 'download',
    ...(sha256 && /^[a-f0-9]{64}$/iu.test(sha256) ? { sha256: sha256.toLowerCase() } : {}),
  };
  const versionCode = positiveInteger(value.versionCode);
  const size = positiveInteger(value.size);
  const minOs = nonEmptyString(value.minOs);
  const abi = nonEmptyString(value.abi);
  const notes = nonEmptyString(value.notes);
  const publishedAt = nonEmptyString(value.publishedAt);
  if (versionCode !== undefined) entry.versionCode = versionCode;
  if (size !== undefined) entry.size = size;
  if (minOs !== undefined) entry.minOs = minOs;
  if (abi !== undefined) entry.abi = abi;
  if (notes !== undefined) entry.notes = notes;
  if (publishedAt !== undefined) entry.publishedAt = publishedAt;
  return entry;
}

function sanitizeManifest(value: unknown, manifestUrl: string): KeDownloadManifest | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.platforms)) return null;
  const platforms: Partial<Record<DownloadPlatform, KeDownloadEntry>> = {};
  for (const platform of SUPPORTED_PLATFORMS) {
    const entry = sanitizeEntry(value.platforms[platform], manifestUrl);
    if (entry) platforms[platform] = entry;
  }
  const channel = nonEmptyString(value.channel);
  const generatedAt = nonEmptyString(value.generatedAt);
  return {
    schemaVersion: 1,
    platforms,
    ...(channel ? { channel } : {}),
    ...(generatedAt ? { generatedAt } : {}),
  };
}

function manifestUrl(env: AppEnv): string {
  return env.KE_STANDALONE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
}

async function loadManifest(env: AppEnv): Promise<KeDownloadManifest> {
  const now = Date.now();
  if (manifestCache && manifestCache.expiresAt > now) return manifestCache.manifest;

  const url = manifestUrl(env);
  const response = await fetch(url, {
    cf: { cacheTtl: 30 },
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`releases.json unavailable: ${response.status}`);
  const manifest = sanitizeManifest(await response.json(), url);
  if (!manifest) throw new Error('releases.json invalid');
  manifestCache = { manifest, expiresAt: now + MANIFEST_CACHE_TTL_MS };
  return manifest;
}

function pageRedirect(
  c: any,
  status: 'invalid' | 'unavailable' | 'error',
  platform?: string,
) {
  const params = new URLSearchParams({ status });
  if (platform && isKnownPlatform(platform)) params.set('platform', platform);
  const response = c.redirect(`/ke/download?${params.toString()}`, 302);
  response.headers.set('cache-control', PAGE_FALLBACK_CACHE_CONTROL);
  return response;
}

async function serveDownloadPage(c: any, env: AppEnv) {
  if (env.ASSETS) return env.ASSETS.fetch(c.req.raw);
  return c.notFound();
}

export function registerKeDownloadRoutes(app: Hono<any>, env: AppEnv): void {
  app.get('/api/v1/ke/downloads', async (c) => {
    let manifest: KeDownloadManifest;
    try {
      manifest = await loadManifest(env);
    } catch {
      return new Response(JSON.stringify({ error: 'release manifest unavailable' }), {
        status: 502,
        headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=UTF-8' },
      });
    }
    return c.json(manifest, 200, { 'cache-control': RESPONSE_CACHE_CONTROL });
  });

  const download = async (c: any) => {
    const status = c.req.query('status');
    if (status === 'invalid' || status === 'unavailable' || status === 'error') {
      return serveDownloadPage(c, env);
    }

    const platform = c.req.query('platform');
    if (!platform) return serveDownloadPage(c, env);
    if (!isSupportedPlatform(platform)) return pageRedirect(c, 'invalid', platform);

    let manifest: KeDownloadManifest;
    try {
      manifest = await loadManifest(env);
    } catch {
      return pageRedirect(c, 'error', platform);
    }
    const entry = manifest.platforms[platform];
    if (!entry) return pageRedirect(c, 'unavailable', platform);

    const redirect = c.redirect(entry.url, 302);
    redirect.headers.set('cache-control', RESPONSE_CACHE_CONTROL);
    return redirect;
  };

  app.get('/ke/download', download);
  app.get('/ke/download/', download);
}
