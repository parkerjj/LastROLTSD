import type { AuthRepository } from './repository';
import { AuthFailure, type UserId } from './types';

const MAX_AVATAR_BYTES = 32 * 1024;
const MAX_AVATAR_BASE64_LENGTH = 43_692;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DEFAULT_AVATAR_BASE64 = [
  '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',
].join('');

function unsupportedAvatar(): AuthFailure {
  return new AuthFailure('AUTH_AVATAR_UNSUPPORTED', 415, '头像必须为不超过 32 KiB 的 256×256 静态 WebP');
}

function invalidAvatarBase64(): AuthFailure {
  return new AuthFailure('AUTH_BAD_REQUEST', 400, '头像 Base64 格式无效');
}

function oversizedAvatar(): AuthFailure {
  return new AuthFailure('AUTH_BODY_TOO_LARGE', 413, '头像超过 32 KiB 限制');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readFourCC(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw unsupportedAvatar();
  let value = '';
  for (let index = offset; index < offset + 4; index += 1) {
    const byte = bytes[index]!;
    if (byte < 0x20 || byte > 0x7e) throw unsupportedAvatar();
    value += String.fromCharCode(byte);
  }
  return value;
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function requireDimension(width: number, height: number): void {
  if (width !== 256 || height !== 256) throw unsupportedAvatar();
}

function validateWebp(bytes: Uint8Array): void {
  if (bytes.byteLength < 20) throw unsupportedAvatar();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readFourCC(bytes, 0) !== 'RIFF'
    || view.getUint32(4, true) !== bytes.byteLength - 8
    || readFourCC(bytes, 8) !== 'WEBP') throw unsupportedAvatar();

  const fileEnd = bytes.byteLength;
  let offset = 12;
  let chunkCount = 0;
  let imageType: 'VP8 ' | 'VP8L' | null = null;
  let imageWidth = 0;
  let imageHeight = 0;
  let imageHasAlpha = false;
  let alphaChunk = false;
  let extendedFlags: number | null = null;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let hasIccp = false;
  let hasExif = false;
  let hasXmp = false;
  const uniqueChunks = new Set<string>();

  while (offset < fileEnd) {
    chunkCount += 1;
    if (chunkCount > 64 || offset + 8 > fileEnd) throw unsupportedAvatar();
    const chunkType = readFourCC(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const paddedEnd = dataEnd + (chunkSize % 2);
    if (dataEnd > fileEnd || paddedEnd > fileEnd) throw unsupportedAvatar();
    if (chunkSize % 2 === 1 && bytes[dataEnd] !== 0) throw unsupportedAvatar();

    if (chunkType === 'ANIM' || chunkType === 'ANMF') throw unsupportedAvatar();
    if (['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP', 'EXIF', 'XMP '].includes(chunkType)) {
      if (uniqueChunks.has(chunkType)) throw unsupportedAvatar();
      uniqueChunks.add(chunkType);
    }

    if (chunkType === 'VP8X') {
      if (chunkCount !== 1 || chunkSize !== 10 || extendedFlags !== null) throw unsupportedAvatar();
      const flags = bytes[dataStart]!;
      if ((flags & 0xc1) !== 0 || (flags & 0x02) !== 0
        || bytes[dataStart + 1] !== 0 || bytes[dataStart + 2] !== 0 || bytes[dataStart + 3] !== 0) {
        throw unsupportedAvatar();
      }
      extendedFlags = flags;
      canvasWidth = 1 + readUint24(bytes, dataStart + 4);
      canvasHeight = 1 + readUint24(bytes, dataStart + 7);
    } else if (chunkType === 'ICCP') {
      if (imageType !== null) throw unsupportedAvatar();
      hasIccp = true;
    } else if (chunkType === 'EXIF') {
      hasExif = true;
    } else if (chunkType === 'XMP ') {
      hasXmp = true;
    } else if (chunkType === 'ALPH') {
      if (extendedFlags === null || imageType !== null || alphaChunk || chunkSize < 1) throw unsupportedAvatar();
      alphaChunk = true;
    } else if (chunkType === 'VP8 ') {
      if (imageType !== null || chunkSize < 10 || alphaChunk && extendedFlags === null) throw unsupportedAvatar();
      const frameTag = bytes[dataStart]!
        | (bytes[dataStart + 1]! << 8)
        | (bytes[dataStart + 2]! << 16);
      const frameType = frameTag & 1;
      const profile = (frameTag >>> 1) & 0x07;
      const showFrame = (frameTag >>> 4) & 1;
      const firstPartitionSize = frameTag >>> 5;
      if (frameType !== 0 || profile > 3 || showFrame !== 1 || firstPartitionSize > chunkSize - 10
        || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) {
        throw unsupportedAvatar();
      }
      imageWidth = view.getUint16(dataStart + 6, true) & 0x3fff;
      imageHeight = view.getUint16(dataStart + 8, true) & 0x3fff;
      imageType = 'VP8 ';
      imageHasAlpha = alphaChunk;
    } else if (chunkType === 'VP8L') {
      if (imageType !== null || alphaChunk || chunkSize < 5 || bytes[dataStart] !== 0x2f) throw unsupportedAvatar();
      const width = 1 + bytes[dataStart + 1]! + ((bytes[dataStart + 2]! & 0x3f) << 8);
      const height = 1 + (bytes[dataStart + 2]! >>> 6) + (bytes[dataStart + 3]! << 2)
        + ((bytes[dataStart + 4]! & 0x0f) << 10);
      const version = bytes[dataStart + 4]! >>> 5;
      if (version !== 0) throw unsupportedAvatar();
      imageWidth = width;
      imageHeight = height;
      imageType = 'VP8L';
      imageHasAlpha = ((bytes[dataStart + 4]! >>> 4) & 1) !== 0;
    }

    offset = paddedEnd;
  }

  if (offset !== fileEnd || imageType === null) throw unsupportedAvatar();
  requireDimension(imageWidth, imageHeight);
  if (extendedFlags === null) {
    if (hasIccp || hasExif || hasXmp || alphaChunk) throw unsupportedAvatar();
    return;
  }
  requireDimension(canvasWidth, canvasHeight);
  if (canvasWidth !== imageWidth || canvasHeight !== imageHeight
    || Boolean(extendedFlags & 0x20) !== hasIccp
    || Boolean(extendedFlags & 0x10) !== imageHasAlpha
    || Boolean(extendedFlags & 0x08) !== hasExif
    || Boolean(extendedFlags & 0x04) !== hasXmp) throw unsupportedAvatar();
}

export function validateAvatarBase64(value: unknown): { base64: string; bytes: Uint8Array } {
  if (typeof value !== 'string') throw invalidAvatarBase64();
  if (value.length > MAX_AVATAR_BASE64_LENGTH) throw oversizedAvatar();
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) throw invalidAvatarBase64();

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw invalidAvatarBase64();
  }
  if (binary.length > MAX_AVATAR_BYTES) throw oversizedAvatar();
  if (binary.length === 0) throw invalidAvatarBase64();

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64(bytes) !== value) throw invalidAvatarBase64();
  validateWebp(bytes);
  return { base64: value, bytes };
}

const DEFAULT_AVATAR_BYTES = validateAvatarBase64(DEFAULT_AVATAR_BASE64).bytes;

export async function avatarResponse(userId: UserId, version: string | null, repository: AuthRepository): Promise<Response> {
  if (version !== null && (version.length > 20 || !/^\d+$/u.test(version))) {
    throw new AuthFailure('AUTH_BAD_REQUEST', 400, '头像版本格式无效');
  }
  const stored = await repository.readAvatar(userId);
  let bytes = DEFAULT_AVATAR_BYTES;
  if (stored?.base64) {
    try {
      bytes = validateAvatarBase64(stored.base64).bytes;
    } catch (error) {
      if (!(error instanceof AuthFailure)) throw error;
    }
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=300',
    },
  });
}

