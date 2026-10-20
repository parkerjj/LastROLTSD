import type { LicensePayload, WrappedKeyBundle } from './types';

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** WebCrypto 的 BufferSource 需要普通 ArrayBuffer 背书，这里把 Uint8Array 复制进新 ArrayBuffer。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
}

/** Ed25519 签名（privateKeyPkcs8 为 PKCS8 DER 编码的私钥）。 */
export async function ed25519Sign(privateKeyPkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('pkcs8', toArrayBuffer(privateKeyPkcs8), { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key, toArrayBuffer(data)));
}

/** 组装紧凑 license 字符串：`base64url(payload).base64url(signature)`。签名覆盖 base64url(payload) 原文。 */
export async function buildLicense(payload: LicensePayload, privateKeyPkcs8: Uint8Array): Promise<string> {
  // 契约：签名对象是 payload 的原文字节（JSON），不是它的 base64url 文本；KE 解码后对原文字节验签。
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const signature = await ed25519Sign(privateKeyPkcs8, payloadBytes);
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`;
}

async function x25519SharedSecret(ephemeralPrivate: CryptoKey, peerPublic: CryptoKey): Promise<Uint8Array> {
  // WebCrypto X25519 的 deriveBits 参数是 { name, public }；workers-types 把它写成 $public，这里用变量绕过字面量多余属性检查。
  const algorithm: { name: string; public: CryptoKey } = { name: 'X25519', public: peerPublic };
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, ephemeralPrivate, 256));
}

/**
 * 用 KE 上报的 X25519 公钥把分块密钥端到端包裹：X25519 ECDH → HKDF-SHA256 → AES-256-GCM。
 * salt 绑定 instance_id（信息串绑定 chunk），保证只能由该实例解包。
 */
export async function wrapChunkKey(
  chunkKey: Uint8Array,
  kePublicKeyRaw: Uint8Array,
  instanceId: string,
  chunk: string,
): Promise<WrappedKeyBundle> {
  const kePublicKey = await crypto.subtle.importKey('raw', toArrayBuffer(kePublicKeyRaw), { name: 'X25519' }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const sharedBits = await x25519SharedSecret(ephemeral.privateKey, kePublicKey);

  const ikm = await crypto.subtle.importKey('raw', toArrayBuffer(sharedBits), { name: 'HKDF' }, false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(instanceId), info: encoder.encode(`ltsd-ke-${chunk}-v1`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(instanceId) },
    kek,
    toArrayBuffer(chunkKey),
  ));
  const tag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  return {
    ephemeral_public: base64UrlEncode(ephemeralPublicRaw),
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
    tag: base64UrlEncode(tag),
  };
}
