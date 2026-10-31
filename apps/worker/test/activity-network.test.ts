import { describe, expect, it } from 'vitest';
import { isHostingOrg } from '../src/activity/hosting';
import { ipNetOf, maskIp, parseDeviceId, parseFingerprint, readActivityNetwork } from '../src/activity/network';
import { ACTIVITY_RETENTION_MS, EMPTY_NETWORK } from '../src/activity/types';

const DEVICE = '0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const FINGERPRINT = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);

function buildRequest(headers: Record<string, string>, cf?: Record<string, unknown>): Request {
  const request = new Request('https://api.ltsd.ro/x', { headers });
  if (cf) Object.defineProperty(request, 'cf', { value: cf });
  return request;
}

describe('类型常量', () => {
  it('保留期 180 天，EMPTY_NETWORK 全 null', () => {
    expect(ACTIVITY_RETENTION_MS).toBe(180 * 24 * 60 * 60 * 1000);
    expect(EMPTY_NETWORK.ip).toBeNull();
    expect(EMPTY_NETWORK.is_hosting).toBe(false);
  });
});

describe('ipNetOf / maskIp', () => {
  it('IPv4 原样，IPv6 取 /64，映射地址还原 IPv4，非 IP 原样', () => {
    expect(ipNetOf('113.87.1.2')).toBe('113.87.1.2');
    expect(ipNetOf('2408:8207:1234:5678:abcd::1')).toBe('2408:8207:1234:5678::/64');
    expect(ipNetOf('2408:8207::1')).toBe('2408:8207:0:0::/64');
    expect(ipNetOf('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(ipNetOf('localhost')).toBe('localhost');
  });

  it('maskIp 脱敏', () => {
    expect(maskIp('113.87.1.2')).toBe('113.87.x.x');
    expect(maskIp('2408:8207:1234:5678::/64')).toBe('2408:8207:x:x::/64');
  });
});

describe('readActivityNetwork', () => {
  it('生产环境读取 IP 与 cf 字段', () => {
    const request = buildRequest(
      { 'cf-connecting-ip': '113.87.1.2', 'x-ltsd-device': DEVICE, 'x-ltsd-fp': FINGERPRINT, 'user-agent': 'UA/1' },
      { country: 'CN', region: 'Guangdong', city: 'Shenzhen', latitude: '22.5', longitude: '114.1', asn: 4134, asOrganization: 'Chinanet' },
    );
    expect(readActivityNetwork(request, 'production')).toEqual({
      ip: '113.87.1.2', ip_net: '113.87.1.2', country: 'CN', region: 'Guangdong', city: 'Shenzhen',
      latitude: 22.5, longitude: 114.1, asn: 4134, as_org: 'Chinanet', is_hosting: false,
      device_id: DEVICE, fingerprint: FINGERPRINT, user_agent: 'UA/1',
    });
  });

  it('机房 ASN 组织判定为 is_hosting', () => {
    const base = { 'cf-connecting-ip': '1.2.3.4' };
    expect(readActivityNetwork(buildRequest(base, { asOrganization: 'Vultr Holdings LLC' }), 'production').is_hosting).toBe(true);
    expect(readActivityNetwork(buildRequest(base, { asOrganization: 'Alibaba US Technology' }), 'production').is_hosting).toBe(true);
  });

  it('无 cf 且非生产环境：全 null 不抛错', () => {
    const network = readActivityNetwork(buildRequest({}), 'test');
    expect(network.ip).toBeNull();
    expect(network.ip_net).toBeNull();
    expect(network.country).toBeNull();
    expect(network.city).toBeNull();
    expect(network.latitude).toBeNull();
    expect(network.asn).toBeNull();
    expect(network.is_hosting).toBe(false);
  });

  it('cf 字段类型收窄', () => {
    const network = readActivityNetwork(
      buildRequest({ 'cf-connecting-ip': '1.2.3.4' }, { country: 'China', latitude: 'abc', longitude: Number.NaN, asn: 'x', city: 'C'.repeat(200) }),
      'production',
    );
    expect(network.country).toBeNull();
    expect(network.latitude).toBeNull();
    expect(network.longitude).toBeNull();
    expect(network.asn).toBeNull();
    expect(network.city).toHaveLength(64);
  });

  it('非法设备头当作没带', () => {
    for (const value of ['A'.repeat(10000), DEVICE.toUpperCase(), '"; DROP']) {
      expect(readActivityNetwork(buildRequest({ 'x-ltsd-device': value }), 'test').device_id).toBeNull();
      expect(parseDeviceId(value)).toBeNull();
    }
    for (const value of [FINGERPRINT.slice(1), FINGERPRINT.toUpperCase()]) {
      expect(readActivityNetwork(buildRequest({ 'x-ltsd-fp': value }), 'test').fingerprint).toBeNull();
      expect(parseFingerprint(value)).toBeNull();
    }
    expect(parseDeviceId(null)).toBeNull();
    expect(parseFingerprint(null)).toBeNull();
  });

  it('user-agent 截断为 512', () => {
    const network = readActivityNetwork(buildRequest({ 'user-agent': 'U'.repeat(1000) }), 'test');
    expect(network.user_agent).toHaveLength(512);
  });
});

describe('isHostingOrg', () => {
  it('不区分大小写子串匹配', () => {
    expect(isHostingOrg('Amazon.com, Inc.')).toBe(true);
    expect(isHostingOrg('Chinanet')).toBe(false);
    expect(isHostingOrg(null)).toBe(false);
  });
});

describe('activity network via trusted VPS proxy', () => {
  const secret = 'b'.repeat(64);
  function proxyRequest(headers: Record<string, string>, cf?: Record<string, unknown>): Request {
    const req = new Request('https://origin.ltsd.ro/api/v1/ke/instances/bind', {
      headers: { 'cf-connecting-ip': '206.237.9.56', 'x-ltsd-proxy-secret': secret, 'x-ltsd-client-ip': '113.87.1.2', ...headers },
    });
    if (cf) Object.defineProperty(req, 'cf', { value: cf });
    return req;
  }

  it('uses real user IP and never treats the Los Angeles VPS cf fields as the visitor location', () => {
    const req = proxyRequest({}, { country: 'US', city: 'Los Angeles', asn: 12345, asOrganization: 'VPS Hosting LLC' });
    expect(readActivityNetwork(req, 'production', secret)).toMatchObject({
      ip: '113.87.1.2', ip_net: '113.87.1.2', country: null,
      city: null, asn: null, as_org: null, is_hosting: false,
    });
  });

  it('accepts optional geo data only after full VPS authentication AND an explicit opt-in', () => {
    const headers = {
      'x-ltsd-client-country': 'CN', 'x-ltsd-client-region': 'Guangdong',
      'x-ltsd-client-city': 'Shenzhen', 'x-ltsd-client-latitude': '22.54',
      'x-ltsd-client-longitude': '114.05', 'x-ltsd-client-asn': '4134',
      'x-ltsd-client-as-org': 'ChinaNet',
    };
    expect(readActivityNetwork(proxyRequest(headers), 'production', secret)).toMatchObject({ country: null, city: null, asn: null });
    expect(readActivityNetwork(proxyRequest(headers), 'production', secret, true)).toMatchObject({
      ip: '113.87.1.2', country: 'CN', region: 'Guangdong',
      city: 'Shenzhen', latitude: 22.54, longitude: 114.05,
      asn: 4134, as_org: 'ChinaNet', is_hosting: false,
    });
    const spoof = proxyRequest({ ...headers, 'x-ltsd-proxy-secret': 'z'.repeat(64) }, { country: 'US', city: 'Los Angeles' });
    expect(readActivityNetwork(spoof, 'production', secret, true).country).toBe('US');
    expect(readActivityNetwork(spoof, 'production', secret).ip).toBeNull();
  });

  it('discards invalid geo values rather than inventing country or coordinates', () => {
    const req = proxyRequest({ 'x-ltsd-client-country': 'China', 'x-ltsd-client-latitude': '1000', 'x-ltsd-client-asn': '-1' });
    expect(readActivityNetwork(req, 'production', secret, true)).toMatchObject({
      ip: '113.87.1.2', country: null, latitude: null, asn: null,
    });
  });
});
