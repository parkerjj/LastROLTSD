import type { UploadItem, UploadShop } from '@lastroweb/protocol';
import { computeItemFingerprint } from './fingerprint';

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function clean(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

export async function computeShopProfileHash(shop: Pick<UploadShop, 'vendor_account_id' | 'vendor_name' | 'title' | 'shop_type' | 'map_name' | 'x' | 'y'>): Promise<string> {
  const canonical = JSON.stringify({ vendor_account_id: clean(shop.vendor_account_id), vendor_name: clean(shop.vendor_name), title: clean(shop.title), shop_type: shop.shop_type, map_name: clean(shop.map_name), x: Math.trunc(shop.x), y: Math.trunc(shop.y) });
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

export async function computeFullShopStateHash(sourceId: string, identityHash: string, items: readonly UploadItem[]): Promise<string> {
  const states = await Promise.all(items.map(async (item) => ({ fingerprint: await computeItemFingerprint({ sourceId, shopSessionId: identityHash, ...(item.item_key === undefined ? {} : { itemKey: item.item_key }), itemId: item.item_id, upgrade: item.upgrade, slots: item.slots, cards: item.cards, options: item.options }), price: item.price, quantity: item.quantity })));
  states.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.price - b.price || a.quantity - b.quantity);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(states))));
}
