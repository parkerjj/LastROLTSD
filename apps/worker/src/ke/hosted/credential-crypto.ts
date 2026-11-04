/**
 * 托管游戏密码的可逆加密（AES-256-GCM）。
 *
 * 密文布局：nonce(12) || ciphertext || tag(16)。AAD 绑定 (user_id, nid, aid, cid, key_version)，
 * 防止密文在行之间被移花接木；改这些字段一律视为删除再新建，需要重新加密。
 * 注意：Worker secret 同时能解密所有密码，Worker 本身是这套机制最大的信任根。
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CREDENTIAL_NONCE_BYTES = 12;
export const MAX_GAME_PASSWORD_BYTES = 128;

export interface CredentialBinding {
  userId: number;
  nid: number;
  aid: number;
  cid: number;
  keyVersion: number;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function aad(binding: CredentialBinding): Uint8Array {
  return encoder.encode(`ke-hosted-cred-v1|${binding.userId}|${binding.nid}|${binding.aid}|${binding.cid}|${binding.keyVersion}`);
}

async function importKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (key.byteLength !== 32) throw new Error('credential key must be 32 bytes');
  return crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptGamePassword(key: Uint8Array, binding: CredentialBinding, password: string): Promise<Uint8Array> {
  const plain = encoder.encode(password);
  if (plain.byteLength === 0 || plain.byteLength > MAX_GAME_PASSWORD_BYTES) throw new Error('invalid password length');
  const nonce = crypto.getRandomValues(new Uint8Array(CREDENTIAL_NONCE_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad(binding)) },
    await importKey(key, 'encrypt'),
    toArrayBuffer(plain),
  ));
  const out = new Uint8Array(nonce.byteLength + sealed.byteLength);
  out.set(nonce, 0);
  out.set(sealed, nonce.byteLength);
  return out;
}

export async function decryptGamePassword(key: Uint8Array, binding: CredentialBinding, blob: Uint8Array): Promise<string> {
  if (blob.byteLength <= CREDENTIAL_NONCE_BYTES + 16) throw new Error('credential blob too short');
  const nonce = blob.subarray(0, CREDENTIAL_NONCE_BYTES);
  const sealed = blob.subarray(CREDENTIAL_NONCE_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad(binding)) },
    await importKey(key, 'decrypt'),
    toArrayBuffer(sealed),
  );
  return decoder.decode(plain);
}
