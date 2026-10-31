import { isIP } from 'node:net';

// Only this dedicated Worker Custom Domain is used by the VPS as an upstream.
// Never accept proxy identity headers on the public ltsd.ro route.
export const LTSD_PROXY_HOST = 'origin.ltsd.ro';
export const LTSD_PROXY_IPV4 = '206.237.9.56';

export interface TrustedProxyClient {
  ip: string;
}

export function isProxyOriginRequest(request: Request): boolean {
  try {
    return new URL(request.url).hostname.toLowerCase() === LTSD_PROXY_HOST;
  } catch {
    return false;
  }
}

// Compare fixed-length random tokens without stopping on the first mismatched byte.
function tokenMatches(expected: string, received: string | null): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expected) || received === null || received.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Only Cloudflare's verified connecting IP and a server-side secret can
 * authenticate the Nginx-supplied client address. A public client can forge
 * X-Forwarded-For and X-LTSD-* headers; neither alone is trustworthy.
 */
export function trustedProxyClient(
  request: Request,
  environment: string,
  proxySecret?: string,
): TrustedProxyClient | null {
  if (environment !== 'production' || !isProxyOriginRequest(request)) return null;
  if (request.headers.get('cf-connecting-ip')?.trim() !== LTSD_PROXY_IPV4) return null;
  if (!tokenMatches(proxySecret ?? '', request.headers.get('x-ltsd-proxy-secret'))) return null;
  const ip = request.headers.get('x-ltsd-client-ip')?.trim();
  if (!ip || ip.length > 64 || ip.includes('%') || isIP(ip) === 0) return null;
  return { ip };
}

/** Direct ltsd.ro remains usable throughout the migration. */
export function isAllowedProxyRequest(request: Request, environment: string, proxySecret?: string): boolean {
  return environment !== 'production'
    || !isProxyOriginRequest(request)
    || trustedProxyClient(request, environment, proxySecret) !== null;
}
