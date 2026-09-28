import type { Hono } from 'hono';
import type { AppEnv } from '../env';

/**
 * Chrome IWA Release 安装包解析路由。
 *
 * 发布流程（RoBrowserV2 仓库）会把 updates.json 作为唯一稳定入口写入 R2：
 *   {
 *     "versions": [
 *       { "version": "0.1.101", "src": "https://client.ltsd.ro/releases/0.1.101/lastro-v2-<sha>.swbn", "channels": ["default"] }
 *     ],
 *     "channels": { "default": { "name": "Stable" } }
 *   }
 *
 * 本路由读取该 manifest，取 default 渠道下版本号最高的条目：
 *   - GET /api/v1/iwa/latest → 302 重定向到最新 .swbn
 *   - GET /api/v1/iwa/info   → 返回 { version, src } JSON，供页面展示版本号
 *
 * 选择读 updates.json 而非列 R2 对象：updates.json 是 Chrome 自动更新读取的同一个文件，
 * 发布流程保证只在完整发布成功后才更新它，是唯一真相源；无需 Worker 绑定 R2 凭据。
 */

const DEFAULT_CHANNEL = 'default';
/** Worker 内存中的 updates.json 缓存：边缘回源时避免每次都拉 R2。 */
const MANIFEST_CACHE_TTL_MS = 5 * 60_000;
/**
 * 响应自身的缓存策略：
 * - max-age=300：浏览器 5 分钟内不重复请求（刷新页面也能较快看到新版本）。
 * - s-maxage=1800：Cloudflare 边缘缓存 30 分钟，期间请求直接由边缘应答、Worker 完全不执行。
 * 即使每天有大量访问，Worker 实际拉取 updates.json 的次数也极低（每 PoP 每 30 分钟一次）。
 */
const RESPONSE_CACHE_CONTROL = 'public, max-age=300, s-maxage=1800';

interface IwaVersion {
  version: string;
  src: string;
  channels?: string[];
}

interface IwaUpdateManifest {
  versions?: IwaVersion[];
  channels?: Record<string, { name?: string }>;
}

interface ManifestCacheEntry {
  latest: IwaVersion | null;
  expiresAt: number;
}

let manifestCache: ManifestCacheEntry | undefined;

/** 仅供测试：重置内存中的 updates.json 缓存。 */
export function resetIwaManifestCacheForTesting(): void {
  manifestCache = undefined;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((seg) => Number.parseInt(seg, 10));
  const pb = b.split('.').map((seg) => Number.parseInt(seg, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i];
    const sb = pb[i];
    const na = typeof sa === 'number' && Number.isFinite(sa) ? sa : 0;
    const nb = typeof sb === 'number' && Number.isFinite(sb) ? sb : 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function pickLatest(manifest: IwaUpdateManifest): IwaVersion | null {
  if (!Array.isArray(manifest.versions) || manifest.versions.length === 0) return null;
  return manifest.versions
    .filter((v) => v && typeof v.version === 'string' && typeof v.src === 'string' && (v.channels ?? []).includes(DEFAULT_CHANNEL))
    .reduce<IwaVersion | null>((best, candidate) => {
      if (best === null) return candidate;
      return compareVersions(candidate.version, best.version) > 0 ? candidate : best;
    }, null);
}

async function loadLatest(env: AppEnv): Promise<IwaVersion | null> {
  const now = Date.now();
  if (manifestCache && manifestCache.expiresAt > now) return manifestCache.latest;

  const manifestUrl = env.IWA_UPDATES_MANIFEST_URL;
  if (!manifestUrl) return null;

  const response = await fetch(manifestUrl, { cf: { cacheTtl: 30 } });
  if (!response.ok) throw new Error(`updates.json unavailable: ${response.status}`);

  const manifest = (await response.json()) as IwaUpdateManifest;
  const latest = pickLatest(manifest);
  manifestCache = { latest, expiresAt: now + MANIFEST_CACHE_TTL_MS };
  return latest;
}

export function registerIwaRoutes(app: Hono<any>, env: AppEnv): void {
  app.get('/api/v1/iwa/latest', async (c) => {
    let latest: IwaVersion | null;
    try {
      latest = await loadLatest(env);
    } catch {
      return new Response('update manifest unavailable', { status: 502, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=UTF-8' } });
    }
    if (!latest) {
      return new Response('no release available', { status: 404, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=UTF-8' } });
    }
    const redirect = c.redirect(latest.src, 302);
    redirect.headers.set('cache-control', RESPONSE_CACHE_CONTROL);
    return redirect;
  });

  app.get('/api/v1/iwa/info', async (c) => {
    let latest: IwaVersion | null;
    try {
      latest = await loadLatest(env);
    } catch {
      return new Response(JSON.stringify({ error: 'update manifest unavailable' }), { status: 502, headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=UTF-8' } });
    }
    if (!latest) {
      return new Response(JSON.stringify({ error: 'no release available' }), { status: 404, headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=UTF-8' } });
    }
    return c.json({ version: latest.version, src: latest.src }, 200, { 'cache-control': RESPONSE_CACHE_CONTROL });
  });
}
