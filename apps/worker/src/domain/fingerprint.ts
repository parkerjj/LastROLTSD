import type { ItemOption } from '@lastroweb/protocol';

export interface FingerprintInput { sourceId: string; shopSessionId: number | string; itemKey?: string; itemId: number; upgrade?: number; slots?: number; cards?: number[]; options?: ItemOption[]; }
export function canonicalItemString(input: FingerprintInput): string {
  const cards = [0, 0, 0, 0].map((_, index) => Number(input.cards?.[index] ?? 0));
  const options = [...(input.options ?? [])].map((option) => [Number(option.type), Number(option.value), Number(option.param)]).sort((a, b) => (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!));
  return JSON.stringify({ source_id: String(input.sourceId), shop_session_id: String(input.shopSessionId), item_key: input.itemKey ?? null, item_id: Number(input.itemId), upgrade: Number(input.upgrade ?? 0), slots: Number(input.slots ?? 0), cards, options });
}

export async function computeItemFingerprint(input: FingerprintInput): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalItemString(input)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
