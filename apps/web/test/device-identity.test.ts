import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_ID_STORAGE_KEY,
  computeFingerprint,
  readDeviceHeaders,
  readDeviceId,
  resetDeviceIdentityForTests,
} from '../src/device-identity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;

let dom: JSDOM;

beforeEach(() => {
  resetDeviceIdentityForTests();
  dom = new JSDOM('<main></main>', { url: 'https://example.test/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('screen', { width: 1920, height: 1080, colorDepth: 24 });
  vi.stubGlobal('devicePixelRatio', 2);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetDeviceIdentityForTests();
});

describe('readDeviceId', () => {
  it('首次生成并写入存储，再次调用返回同一值', () => {
    const storage = dom.window.localStorage;
    const first = readDeviceId(storage);
    expect(first).toMatch(UUID);
    expect(storage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(first);
    expect(readDeviceId(storage)).toBe(first);
  });

  it('存储中的值不是合法 UUID 时重新生成', () => {
    const storage = dom.window.localStorage;
    storage.setItem(DEVICE_ID_STORAGE_KEY, 'not-a-uuid');
    const id = readDeviceId(storage);
    expect(id).toMatch(UUID);
    expect(storage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(id);
  });

  it('存储抛错时仍返回同一个合法 UUID', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    const first = readDeviceId(broken);
    expect(first).toMatch(UUID);
    expect(readDeviceId(broken)).toBe(first);
  });
});

describe('computeFingerprint', () => {
  it('返回 64 位小写 hex，同一环境两次结果相同', async () => {
    const first = await computeFingerprint();
    expect(first).toMatch(HEX64);
    expect(await computeFingerprint()).toBe(first);
  });

  it('canvas getContext 返回 null 时仍返回 64 位 hex', async () => {
    vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(await computeFingerprint()).toMatch(HEX64);
  });

  it('crypto.subtle 不可用时返回 null', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'x', subtle: undefined });
    expect(await computeFingerprint()).toBeNull();
  });
});

describe('readDeviceHeaders', () => {
  it('返回设备 ID 与指纹两个头，并缓存结果', async () => {
    const headers = await readDeviceHeaders();
    expect(headers['x-ltsd-device']).toMatch(UUID);
    expect(headers['x-ltsd-fp']).toMatch(HEX64);
    expect(await readDeviceHeaders()).toBe(headers);
  });

  it('crypto.subtle 不可用时只返回 x-ltsd-device', async () => {
    const randomUUID = crypto.randomUUID.bind(crypto);
    vi.stubGlobal('crypto', { randomUUID, subtle: undefined });
    const headers = await readDeviceHeaders();
    expect(Object.keys(headers)).toEqual(['x-ltsd-device']);
  });

  it('没有 window 的环境下不抛错', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    const headers = await readDeviceHeaders();
    expect(headers['x-ltsd-device']).toMatch(UUID);
  });
});
