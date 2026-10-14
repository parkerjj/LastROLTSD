import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerAuthRoutes } from '../src/auth/router';
import type { AuthBindings } from '../src/auth/types';
import type { AppEnv } from '../src/env';
import type { MysqlDatabase } from '../src/db/mysql-client';

interface AvatarModule {
  validateAvatarBase64?: (value: unknown) => { base64: string; bytes: Uint8Array };
}

const avatarModulePath = '../src/auth/avatar.ts';

async function loadAvatarModule(): Promise<AvatarModule | null> {
  try {
    return await import(/* @vite-ignore */ avatarModulePath) as AvatarModule;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function webpChunk(bytes: Uint8Array, type: string): { header: number; data: number; size: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const chunkType = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (chunkType === type) return { header: offset, data: offset + 8, size };
    const next = offset + 8 + size + (size % 2);
    if (next > bytes.byteLength) return null;
    offset = next;
  }
  return null;
}

function appendChunk(source: Uint8Array, type: string, payload = new Uint8Array()): Uint8Array {
  const chunkLength = 8 + payload.byteLength + (payload.byteLength % 2);
  const result = new Uint8Array(source.byteLength + chunkLength);
  result.set(source);
  const offset = source.byteLength;
  result.set(new TextEncoder().encode(type), offset);
  const view = new DataView(result.buffer);
  view.setUint32(offset + 4, payload.byteLength, true);
  result.set(payload, offset + 8);
  view.setUint32(4, result.byteLength - 8, true);
  return result;
}

function chunkCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    const next = offset + 8 + size + (size % 2);
    if (next > bytes.byteLength) return count;
    count += 1;
    offset = next;
  }
  return count;
}

function appendEmptyChunks(source: Uint8Array, count: number): Uint8Array {
  let result = source;
  while (chunkCount(result) < count) result = appendChunk(result, 'JUNK');
  return result;
}

function writeVp8FrameTag(bytes: Uint8Array, dataOffset: number, tag: number): void {
  bytes[dataOffset] = tag & 0xff;
  bytes[dataOffset + 1] = (tag >>> 8) & 0xff;
  bytes[dataOffset + 2] = (tag >>> 16) & 0xff;
}

function standardBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: standardBase64(1), AUTH_CSRF_SECRET: standardBase64(2),
    AUTH_RATE_SECRET: standardBase64(3), AUTH_MAIL_PAYLOAD_SECRET: standardBase64(4),
  };
}

describe('public WebP avatars', () => {
  it('accepts a browser fixture and the 32 KiB boundary while enforcing strict Base64 and WebP headers', async () => {
    const avatarModule = await loadAvatarModule();
    expect(typeof avatarModule?.validateAvatarBase64).toBe('function');
    if (!avatarModule?.validateAvatarBase64) return;
    const validate = avatarModule.validateAvatarBase64;
    const browserFixture = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/auth/avatar-256-browser.webp', import.meta.url)));
    const browserBase64 = encodeBase64(browserFixture);
    const valid = validate(browserBase64);
    expect(valid.base64).toBe(browserBase64);
    expect(Array.from(valid.bytes)).toEqual(Array.from(browserFixture));
    const expectFailure = (value: unknown, status: number, code: string) => {
      let failure: unknown;
      try {
        validate(value);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ status, code });
    };

    const exactSizePayloadLength = 32_768 - browserFixture.byteLength - 8;
    const exactSizeFixture = appendChunk(browserFixture, 'JUNK', new Uint8Array(exactSizePayloadLength));
    const exactSizeBase64 = encodeBase64(exactSizeFixture);
    expect(exactSizeFixture.byteLength).toBe(32_768);
    expect(exactSizeBase64.length).toBe(43_692);
    expect(validate(exactSizeBase64).bytes.byteLength).toBe(32_768);

    const overSizeBase64 = encodeBase64(new Uint8Array(32_769));
    expect(overSizeBase64.length).toBe(43_692);
    for (const malformed of ['AA=', 'AAAA$', 'AB==', 'data:image/webp;base64,' + browserBase64]) {
      expectFailure(malformed, 400, 'AUTH_BAD_REQUEST');
    }
    expectFailure(null, 400, 'AUTH_BAD_REQUEST');
    expectFailure('A'.repeat(43_696), 413, 'AUTH_BODY_TOO_LARGE');
    expectFailure(overSizeBase64, 413, 'AUTH_BODY_TOO_LARGE');
    expectFailure('AA==', 415, 'AUTH_AVATAR_UNSUPPORTED');
    expectFailure(`${browserBase64}AA==`, 415, 'AUTH_AVATAR_UNSUPPORTED');
    expectFailure(encodeBase64(Uint8Array.from([...browserFixture, 0])), 415, 'AUTH_AVATAR_UNSUPPORTED');
    const vp8 = webpChunk(browserFixture, 'VP8 ');
    const vp8x = webpChunk(browserFixture, 'VP8X');
    expect(vp8).not.toBeNull();
    expect(vp8x).not.toBeNull();
    if (!vp8 || !vp8x) return;

    const wrongInnerSize = new Uint8Array(browserFixture);
    const wrongInnerView = new DataView(wrongInnerSize.buffer);
    wrongInnerView.setUint16(vp8.data + 6, 255, true);
    expectFailure(encodeBase64(wrongInnerSize), 415, 'AUTH_AVATAR_UNSUPPORTED');

    const animated = new Uint8Array(browserFixture);
    animated[vp8x.data] = animated[vp8x.data]! | 2;
    expectFailure(encodeBase64(animated), 415, 'AUTH_AVATAR_UNSUPPORTED');
    expectFailure(encodeBase64(appendChunk(browserFixture, 'ANIM')), 415, 'AUTH_AVATAR_UNSUPPORTED');

    const conflictingCanvas = new Uint8Array(browserFixture);
    const outerWidth = (vp8x.data + 4);
    conflictingCanvas[outerWidth] = 0;
    conflictingCanvas[outerWidth + 1] = 1;
    conflictingCanvas[outerWidth + 2] = 0;
    expectFailure(encodeBase64(conflictingCanvas), 415, 'AUTH_AVATAR_UNSUPPORTED');

    const duplicatedImage = appendChunk(browserFixture, 'VP8 ', browserFixture.subarray(vp8.data, vp8.data + vp8.size));
    expectFailure(encodeBase64(duplicatedImage), 415, 'AUTH_AVATAR_UNSUPPORTED');
    const exactChunkLimit = appendEmptyChunks(browserFixture, 64);
    expect(chunkCount(exactChunkLimit)).toBe(64);
    expect(() => validate(encodeBase64(exactChunkLimit))).not.toThrow();
    expectFailure(encodeBase64(appendEmptyChunks(browserFixture, 65)), 415, 'AUTH_AVATAR_UNSUPPORTED');
    expectFailure(encodeBase64(appendChunk(browserFixture, 'ANMF')), 415, 'AUTH_AVATAR_UNSUPPORTED');
    const badChunkLength = new Uint8Array(browserFixture);
    new DataView(badChunkLength.buffer).setUint32(vp8x.header + 4, 0xffff_ffff, true);
    expectFailure(encodeBase64(badChunkLength), 415, 'AUTH_AVATAR_UNSUPPORTED');
    const badPadding = appendChunk(browserFixture, 'JUNK', Uint8Array.of(1));
    badPadding[badPadding.byteLength - 1] = 1;
    expectFailure(encodeBase64(badPadding), 415, 'AUTH_AVATAR_UNSUPPORTED');

  });

  it('rejects VP8 frames that are hidden, use an unsupported profile, or overrun the first partition', async () => {
    const avatarModule = await loadAvatarModule();
    expect(typeof avatarModule?.validateAvatarBase64).toBe('function');
    if (!avatarModule?.validateAvatarBase64) return;
    const browserFixture = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/auth/avatar-256-browser.webp', import.meta.url)));
    const vp8 = webpChunk(browserFixture, 'VP8 ');
    expect(vp8).not.toBeNull();
    if (!vp8) return;
    const validTag = browserFixture[vp8.data]!
      | (browserFixture[vp8.data + 1]! << 8)
      | (browserFixture[vp8.data + 2]! << 16);
    const invalidTags = [
      validTag & ~0x10,
      (validTag & ~0x0e) | (7 << 1),
      (validTag & 0x1f) | ((vp8.size - 9) << 5),
    ];

    for (const tag of invalidTags) {
      const bytes = new Uint8Array(browserFixture);
      writeVp8FrameTag(bytes, vp8.data, tag);
      let failure: unknown;
      try {
        avatarModule.validateAvatarBase64(encodeBase64(bytes));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'AUTH_AVATAR_UNSUPPORTED', status: 415 });
    }
  });

  it('serves the current image or one shared default without identity data', async () => {
    const defaultFixture = readFileSync(new URL('../../../tests/fixtures/auth/default-avatar-256-browser.webp', import.meta.url));
    const avatarFixture = readFileSync(new URL('../../../tests/fixtures/auth/avatar-256-browser.webp', import.meta.url));
    let avatarRow: { avatar_base64: string | null; avatar_version: number } | null = null;
    const database = {
      first: async () => avatarRow,
    } as unknown as MysqlDatabase;
    const app = new Hono();
    registerAuthRoutes(app, bindings(), database, { now: () => 1_000, fetch: globalThis.fetch });

    const missingUser = await app.request('/api/v1/users/99999/avatar?v=0');
    expect(missingUser.status).toBe(200);
    expect(missingUser.headers.get('content-type')).toBe('image/webp');
    expect(missingUser.headers.get('x-content-type-options')).toBe('nosniff');
    expect(missingUser.headers.get('cache-control')).toBe('public, max-age=300');
    const missingBytes = new Uint8Array(await missingUser.arrayBuffer());
    expect(Array.from(missingBytes)).toEqual(Array.from(defaultFixture));

    avatarRow = { avatar_base64: null, avatar_version: 1 };
    const noAvatar = await app.request('/api/v1/users/10000/avatar?v=1');
    expect(Array.from(new Uint8Array(await noAvatar.arrayBuffer()))).toEqual(Array.from(defaultFixture));

    avatarRow = { avatar_base64: avatarFixture.toString('base64'), avatar_version: 7 };
    const staleUrl = await app.request('/api/v1/users/10000/avatar?v=0');
    expect(staleUrl.status).toBe(200);
    expect(staleUrl.headers.get('content-type')).toBe('image/webp');
    expect(Array.from(new Uint8Array(await staleUrl.arrayBuffer()))).toEqual(Array.from(avatarFixture));

    const malformedVersion = await app.request('/api/v1/users/10000/avatar?v=1.5');
    expect(malformedVersion.status).toBe(400);
    expect(await malformedVersion.json()).toMatchObject({ error: { code: 'AUTH_BAD_REQUEST' } });
    expect((await app.request('/api/v1/users/10000/avatar')).status).toBe(200);
    expect((await app.request('/api/v1/users/10000/avatar?v=' + '0'.repeat(21))).status).toBe(400);
  });
});
