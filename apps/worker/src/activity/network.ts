import { trustedAuthClientIp } from '../auth/rate-limit';
import { trustedProxyClient } from '../network/trusted-proxy';
import { isHostingOrg } from './hosting';
import type { ActivityNetwork } from './types';

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const MAPPED_IPV4_PATTERN = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/iu;
const HEX_GROUP_PATTERN = /^[0-9a-f]{1,4}$/iu;

// 把 IPv6 展开成 8 组；格式不合法返回 null。
function expandIpv6(ip: string): string[] | null {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  return groups.length === 8 && groups.every((group) => HEX_GROUP_PATTERN.test(group)) ? groups : null;
}

// 关联分析用的网络标识：IPv4 原样，IPv6 取 /64 前缀，IPv4 映射地址还原为 IPv4，无法识别的原样返回。
export function ipNetOf(ip: string): string {
  const mapped = MAPPED_IPV4_PATTERN.exec(ip);
  if (mapped) return mapped[1] as string;
  if (!ip.includes(':')) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

// 脱敏：IPv4 保留前两段，IPv6 /64 保留前两组。永久保存的快照只允许使用脱敏值。
export function maskIp(ipOrNet: string): string {
  const net = ipNetOf(ipOrNet);
  if (IPV4_PATTERN.test(net)) {
    const [a, b] = net.split('.');
    return `${a}.${b}.x.x`;
  }
  if (net.endsWith('::/64')) {
    const [a, b] = net.slice(0, -'::/64'.length).split(':');
    return `${a}:${b}:x:x::/64`;
  }
  return net;
}

export function parseDeviceId(value: string | null): string | null {
  return value !== null && DEVICE_ID_PATTERN.test(value) ? value : null;
}

export function parseFingerprint(value: string | null): string | null {
  return value !== null && FINGERPRINT_PATTERN.test(value) ? value : null;
}

function textField(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, maxLength);
}

function numberField(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function integerField(value: unknown): number | null {
  const parsed = numberField(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function optionalProxyNumber(request: Request, name: string, min: number, max: number): number | null {
  const raw = request.headers.get(name)?.trim();
  if (!raw || raw.length > 32) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max && (name !== 'x-ltsd-client-asn' || Number.isInteger(value)) ? value : null;
}

function optionalProxyText(request: Request, name: string, maxLength: number): string | null {
  const raw = request.headers.get(name)?.trim();
  // eslint-disable-next-line no-control-regex
  return raw && raw.length <= maxLength && !/[\r\n\x00-\x1f\x7f]/u.test(raw) ? raw : null;
}

export function readActivityNetwork(request: Request, environment: string, proxySecret?: string, proxyGeoEnabled = false): ActivityNetwork {
  const proxy = trustedProxyClient(request, environment, proxySecret);
  // GeoIP headers can otherwise be injected by browsers through Nginx.
  // Never trust them until the server is explicitly configured to overwrite every field.
  const useProxyGeo = proxy !== null && proxyGeoEnabled;
  // Cloudflare's cf metadata describes the VPS, NOT the proxied user.
  const cf: Record<string, unknown> = proxy ? {} : ((request as Request & { cf?: Record<string, unknown> }).cf ?? {});
  const clientIp = trustedAuthClientIp(request, environment, proxySecret);
  const ip = clientIp === 'unknown' ? null : clientIp;
  const forwardedCountry = useProxyGeo ? optionalProxyText(request, 'x-ltsd-client-country', 2) : null;
  const countryValue = proxy ? forwardedCountry : cf.country;
  const country = typeof countryValue === 'string' && /^[A-Za-z]{2}$/u.test(countryValue) ? countryValue.toUpperCase() : null;
  const asOrg = proxy ? (useProxyGeo ? optionalProxyText(request, 'x-ltsd-client-as-org', 128) : null) : textField(cf.asOrganization, 128);
  return {
    ip,
    ip_net: ip === null ? null : ipNetOf(ip),
    country,
    region: proxy ? (useProxyGeo ? optionalProxyText(request, 'x-ltsd-client-region', 64) : null) : textField(cf.region, 64),
    city: proxy ? (useProxyGeo ? optionalProxyText(request, 'x-ltsd-client-city', 64) : null) : textField(cf.city, 64),
    latitude: proxy ? (useProxyGeo ? optionalProxyNumber(request, 'x-ltsd-client-latitude', -90, 90) : null) : numberField(cf.latitude),
    longitude: proxy ? (useProxyGeo ? optionalProxyNumber(request, 'x-ltsd-client-longitude', -180, 180) : null) : numberField(cf.longitude),
    asn: proxy ? (useProxyGeo ? optionalProxyNumber(request, 'x-ltsd-client-asn', 1, 4294967295) : null) : integerField(cf.asn),
    as_org: asOrg,
    is_hosting: isHostingOrg(asOrg),
    device_id: parseDeviceId(request.headers.get('x-ltsd-device')),
    fingerprint: parseFingerprint(request.headers.get('x-ltsd-fp')),
    user_agent: textField(request.headers.get('user-agent'), 512),
  };
}
