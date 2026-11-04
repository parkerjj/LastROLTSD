import { describe, expect, it } from 'vitest';
import { trustedAuthClientIp } from '../src/auth/rate-limit';
import { trustedProxyClient } from '../src/network/trusted-proxy';

const SECRET = 'a'.repeat(64);
const VPS = '206.237.9.56';

function request(host: string, ip: string, overrides: Record<string, string> = {}): Request {
  return new Request(`https://${host}/api/v1/ke/device/code`, {
    headers: {
      'cf-connecting-ip': VPS,
      'x-ltsd-client-ip': ip,
      'x-ltsd-proxy-secret': SECRET,
      ...overrides,
    },
  });
}

describe('trusted VPS -> Worker identity', () => {
  it('accepts the verified VPS, exact shared secret, and IPv4 or IPv6 visitors', () => {
    for (const ip of ['223.5.5.5', '2408:8000:1::1']) {
      const req = request('origin.ltsd.ro', ip);
      expect(trustedAuthClientIp(req, 'production', SECRET)).toBe(ip);
      expect(trustedProxyClient(req, 'production', SECRET)?.ip).toBe(ip);
    }
  });

  it('uses the real Cloudflare IP for direct origin callers (agents, CI, hosted children) instead of a shared unknown bucket', () => {
    // 直连 origin 不经反代：转发头一律不采信，按 Cloudflare 看到的真实来源限速。
    for (const overrides of [
      { 'cf-connecting-ip': '198.51.100.9' },
      { 'cf-connecting-ip': '198.51.100.9', 'x-ltsd-proxy-secret': 'b'.repeat(64) },
      { 'cf-connecting-ip': '198.51.100.9', 'x-ltsd-proxy-secret': '' },
    ]) {
      const req = request('origin.ltsd.ro', '9.9.9.9', overrides);
      expect(trustedProxyClient(req, 'production', SECRET)).toBeNull();
      expect(trustedAuthClientIp(req, 'production', SECRET)).toBe('198.51.100.9');
    }
    expect(trustedAuthClientIp(request('origin.ltsd.ro', '9.9.9.9', { 'cf-connecting-ip': '198.51.100.9' }), 'production')).toBe('198.51.100.9');
  });

  it('fails closed to unknown when a request from the proxy VPS itself fails its identity checks', () => {
    // 来自反代 VPS 却校验不过（密钥不符、转发地址畸形/多值）：绝不能把 VPS 地址当访客。
    for (const [overrides, ip] of [
      [{ 'x-ltsd-proxy-secret': 'b'.repeat(64) }, '223.5.5.5'],
      [{ 'x-ltsd-proxy-secret': '' }, '223.5.5.5'],
      [{}, '223.5.5.5, 1.2.3.4'],
      [{}, 'not-ip'],
      [{}, '999.1.1.1'],
      [{}, 'fe80::1%eth0'],
      [{}, ''],
    ] as Array<[Record<string, string>, string]>) {
      const req = request('origin.ltsd.ro', ip, overrides);
      expect(trustedProxyClient(req, 'production', SECRET)).toBeNull();
      expect(trustedAuthClientIp(req, 'production', SECRET)).toBe('unknown');
    }
    expect(trustedAuthClientIp(request('origin.ltsd.ro', '223.5.5.5'), 'production')).toBe('unknown');
  });

  it('preserves direct Cloudflare identity and ignores any visitor-supplied proxy headers', () => {
    const req = request('ltsd.ro', '1.2.3.4', { 'cf-connecting-ip': '113.87.1.2' });
    expect(trustedAuthClientIp(req, 'production', SECRET)).toBe('113.87.1.2');
    expect(trustedProxyClient(req, 'production', SECRET)).toBeNull();
  });

  it('does not activate the production trust model in local and test environments', () => {
    expect(trustedProxyClient(request('origin.ltsd.ro', '1.2.3.4'), 'test', SECRET)).toBeNull();
  });
});
