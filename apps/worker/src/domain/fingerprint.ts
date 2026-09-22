import type { ItemOption } from '@lastroweb/protocol';
import { Buffer } from 'node:buffer';

const encoder = new TextEncoder();
const compareOptions = (a: number[], b: number[]): number => (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);

export interface FingerprintInput { sourceId: string; shopSessionId: number | string; itemKey?: string; itemId: number; upgrade?: number; slots?: number; cards?: number[]; options?: ItemOption[]; }
export function canonicalItemString(input: FingerprintInput): string {
  const cards = [0, 0, 0, 0].map((_, index) => Number(input.cards?.[index] ?? 0));
  const options = (input.options ?? []).map((option) => [Number(option.type), Number(option.value), Number(option.param)]);
  // Ingestion already sorts these once during normalization. Other callers may not.
  for (let index = 1; index < options.length; index++) {
    if (compareOptions(options[index - 1]!, options[index]!) > 0) {
      options.sort(compareOptions);
      break;
    }
  }
  return JSON.stringify({ source_id: String(input.sourceId), shop_session_id: String(input.shopSessionId), item_key: input.itemKey ?? null, item_id: Number(input.itemId), upgrade: Number(input.upgrade ?? 0), slots: Number(input.slots ?? 0), cards, options });
}

export async function computeItemFingerprint(input: FingerprintInput): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalItemString(input)));
  return Buffer.from(digest).toString('hex');
}
