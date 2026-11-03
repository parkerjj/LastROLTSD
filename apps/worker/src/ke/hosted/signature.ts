/**
 * ke-agent 请求签名（Ed25519）。契约见 KoreEngine 仓库 docs/linux-hosting-design.md 第 8.1 节。
 *
 * canonical = "KE-AGENT-V1\n" + METHOD + "\n" + PATH_AND_QUERY + "\n" + ts + "\n" + nonce + "\n" + hex(sha256(body))
 * 头：x-ke-agent / x-ke-ts（秒）/ x-ke-nonce（16–48 位 base64url）/ x-ke-sig（base64url 的 64 字节签名）。
 * Rust 的 ke-agent 使用同一个 canonical 构造函数与同一份测试向量。
 */
import { base64UrlDecode } from '../crypto';

export const AGENT_ID_PATTERN = /^agt_[0-9a-f]{24}$/u;
export const AGENT_SIGNATURE_SKEW_SECONDS = 60;
export const AGENT_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,48}$/u;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))));
}

export async function canonicalRequest(
  method: string,
  pathAndQuery: string,
  ts: string,
  nonce: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  return encoder.encode(`KE-AGENT-V1\n${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${nonce}\n${await sha256Hex(body)}`);
}

export interface SignedAgentRequest {
  agentId: string;
  ts: number;
  nonce: string;
}

export class AgentSignatureError extends Error {
  constructor(readonly reason: 'malformed' | 'skew' | 'bad_signature') {
    super(reason);
  }
}

/** 只解析并检查格式/时间窗；签名验证需要公钥，由调用方先查 agent 再调用 verifyAgentSignature。 */
export function parseSignedHeaders(headers: Headers, nowMs: number): SignedAgentRequest & { signature: Uint8Array } {
  const agentId = headers.get('x-ke-agent') ?? '';
  const tsText = headers.get('x-ke-ts') ?? '';
  const nonce = headers.get('x-ke-nonce') ?? '';
  const sig = headers.get('x-ke-sig') ?? '';
  const ts = Number(tsText);
  if (!AGENT_ID_PATTERN.test(agentId) || !/^[0-9]{1,12}$/u.test(tsText) || !Number.isSafeInteger(ts)
    || !AGENT_NONCE_PATTERN.test(nonce) || !/^[A-Za-z0-9_-]{86}$/u.test(sig)) {
    throw new AgentSignatureError('malformed');
  }
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > AGENT_SIGNATURE_SKEW_SECONDS) throw new AgentSignatureError('skew');
  return { agentId, ts, nonce, signature: base64UrlDecode(sig) };
}

export async function verifyAgentSignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  method: string,
  pathAndQuery: string,
  ts: number,
  nonce: string,
  body: Uint8Array,
): Promise<void> {
  if (publicKey.byteLength !== 32 || signature.byteLength !== 64) throw new AgentSignatureError('bad_signature');
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(publicKey), { name: 'Ed25519' }, false, ['verify']);
  const message = await canonicalRequest(method, pathAndQuery, String(ts), nonce, body);
  const ok = await crypto.subtle.verify('Ed25519', key, toArrayBuffer(signature), toArrayBuffer(message));
  if (!ok) throw new AgentSignatureError('bad_signature');
}
