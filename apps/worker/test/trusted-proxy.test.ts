import { describe, expect, it } from 'vitest';
import { trustedAuthClientIp } from '../src/auth/rate-limit';
import { isAllowedProxyRequest, trustedProxyClient } from '../src/network/trusted-proxy';

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
      expect(isAllowedProxyRequest(req, 'production', SECRET)).toBe(true);
      expect(trustedAuthClientIp(req, 'production', SECRET)).toBe(ip);
      expect(trustedProxyClient(req, 'production', SECRET)?.ip).toBe(ip);
    }
  });

  it('fails closed if the secret or connecting VPS identity does not match', () => {
    for (const overrides of [
      { 'x-ltsd-proxy-secret': 'b'.repeat(64) },
      { 'x-ltsd-proxy-secret': '' },
      { 'cf-connecting-ip': '198.51.100.9' },
    ]) {
      const req = request('origin.ltsd.ro', '223.5.5.5', overrides);
      expect(isAllowedProxyRequest(req, 'production', SECRET)).toBe(false);
      expect(trustedAuthClientIp(req, 'production', SECRET)).toBe('unknown');
    }
    expect(isAllowedProxyRequest(request('origin.ltsd.ro', '223.5.5.5'), 'production')).toBe(false);
  });

  it('rejects spoofed, malformed and multi-value client addresses', () => {
    for (const ip of ['223.5.5.5, 1.2.3.4', 'not-ip', '999.1.1.1', 'fe80::1%eth0', '']) {
      const req = request('origin.ltsd.ro', ip);
      expect(isAllowedProxyRequest(req, 'production', SECRET)).toBe(false);
      expect(trustedAuthClientIp(req, 'production', SECRET)).toBe('unknown');
    }
  });

  it('preserves direct Cloudflare identity and ignores any visitor-supplied proxy headers', () => {
    const req = request('ltsd.ro', '1.2.3.4', { 'cf-connecting-ip': '113.87.1.2' });
    expect(isAllowedProxyRequest(req, 'production', SECRET)).toBe(true);
    expect(trustedAuthClientIp(req, 'production', SECRET)).toBe('113.87.1.2');
    expect(trustedProxyClient(req, 'production', SECRET)).toBeNull();
  });

  it('lets self-authenticated KE callers (agents, CI build registration) reach the origin directly, but nothing else on it', () => {
    const direct = (path: string, headers: Record<string, string> = {}) =>
      new Request(`https://origin.ltsd.ro${path}`, { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.9', ...headers } });
    for (const path of [
      '/api/v1/ke/agent/lease',
      '/api/v1/ke/agent/ws',
      '/api/v1/ke/agent/instances/abc/launch',
      '/api/v1/ke/agent/modules/keys',
      '/api/v1/ke/builds/register',
    ]) {
      expect(isAllowedProxyRequest(direct(path), 'production', SECRET)).toBe(true);
    }
    for (const path of [
      '/api/v1/ke/device/code',
      '/api/v1/ke/hosted',
      '/api/v1/ke/agentx/lease',
      '/api/v1/ke/agent',
      '/api/v1/ke/builds',
      '/api/v1/ke/builds/register/x',
      '/api/v1/ke/builds/registerx',
      '/api/v1/ke/builds/list',
      '/api/v1/ke/agent/../device/code',
      '/api/v1/ke/agent/%2e%2e/device/code',
      '/api/v1/market/search',
      '/',
    ]) {
      expect(isAllowedProxyRequest(direct(path), 'production', SECRET)).toBe(false);
    }
    // 不带反代身份时，agent 路径也不会被当成可信代理客户端。
    expect(trustedProxyClient(direct('/api/v1/ke/agent/lease'), 'production', SECRET)).toBeNull();
  });

  it('does not activate the production trust model in local and test environments', () => {
    expect(trustedProxyClient(request('origin.ltsd.ro', '1.2.3.4'), 'test', SECRET)).toBeNull();
    expect(isAllowedProxyRequest(request('origin.ltsd.ro', '1.2.3.4'), 'test', SECRET)).toBe(true);
  });
});
