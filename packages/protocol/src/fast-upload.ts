import { z } from 'zod';
import type { ItemOption, UploadItem, UploadRequest, UploadShop } from './types';

// Keep date acceptance in one place, including Zod's offset/leap-year behavior.
// Only this one root field uses Zod on the valid upload path.
export const uploadObservedAtSchema = z.string().datetime({ offset: true });
const uuid = /^[0-9a-f]{8}\b-[0-9a-f]{4}\b-[0-9a-f]{4}\b-[0-9a-f]{4}\b-[0-9a-f]{12}$/iu;
const requestKeys = new Set(['protocol_version', 'client_run_id', 'snapshot_id', 'snapshot_mode', 'part_index', 'part_count', 'observed_at', 'shops']);
const shopKeys = new Set(['shop_id', 'uuid', 'shop_status', 'vendor_account_id', 'vendor_name', 'title', 'shop_type', 'map_name', 'x', 'y', 'items']);
const itemKeys = new Set(['item_key', 'item_id', 'upgrade', 'slots', 'cards', 'price', 'quantity', 'options']);
const optionKeys = new Set(['type', 'value', 'param']);

function record(value: unknown, keys: ReadonlySet<string>): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  // Exotic JS objects use the reference parser; network JSON is always plain.
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!keys.has(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) return false;
  }
  for (const key in value) if (!keys.has(key)) return false;
  return true;
}

function array(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value[Symbol.iterator] === Array.prototype[Symbol.iterator];
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function text(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : undefined;
}

function parseOption(input: unknown): ItemOption | undefined {
  if (!record(input, optionKeys) || !integer(input.type, 0, 65535)
    || !integer(input.value, -2147483648, 2147483647) || !integer(input.param, -2147483648, 2147483647)) return undefined;
  return { type: input.type, value: input.value, param: input.param };
}

function parseItem(input: unknown): UploadItem | undefined {
  if (!record(input, itemKeys)) return undefined;
  const key = input.item_key === undefined ? undefined : text(input.item_key, 1, 80);
  if (input.item_key !== undefined && key === undefined) return undefined;
  const upgrade = input.upgrade === undefined ? 0 : input.upgrade;
  const slots = input.slots === undefined ? 0 : input.slots;
  if (!integer(input.item_id, 0, 2147483647) || !integer(upgrade, 0, 20) || !integer(slots, 0, 4)
    || !integer(input.price, 0, Number.MAX_SAFE_INTEGER) || !integer(input.quantity, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  const rawCards = input.cards === undefined ? [] : input.cards;
  const rawOptions = input.options === undefined ? [] : input.options;
  if (!array(rawCards) || rawCards.length > 4 || !array(rawOptions) || rawOptions.length > 32) return undefined;
  const cards: number[] = [];
  for (let index = 0; index < rawCards.length; index++) {
    const card = rawCards[index];
    if (!integer(card, 0, 2147483647)) return undefined;
    cards.push(card);
  }
  const options: ItemOption[] = [];
  for (let index = 0; index < rawOptions.length; index++) {
    const option = parseOption(rawOptions[index]);
    if (!option) return undefined;
    options.push(option);
  }
  // Output order/defaults match the reference schema byte-for-byte for hashing.
  // Explicit undefined optional keys remain present, as in Zod's output.
  return { ...('item_key' in input ? { item_key: key } : {}), item_id: input.item_id,
    upgrade, slots, cards, price: input.price, quantity: input.quantity, options } as UploadItem;
}

function parseShop(input: unknown): UploadShop | undefined {
  if (!record(input, shopKeys)) return undefined;
  const shopId = input.shop_id === undefined ? undefined : text(input.shop_id, 1, 120);
  if (input.shop_id !== undefined && shopId === undefined) return undefined;
  const account = text(input.vendor_account_id, 1, 120);
  const vendor = text(input.vendor_name, 0, 160);
  const title = text(input.title, 0, 200);
  const map = text(input.map_name, 1, 80);
  if (account === undefined || vendor === undefined || title === undefined || map === undefined
    || typeof input.uuid !== 'string' || !uuid.test(input.uuid)
    || (input.shop_status !== 'opening' && input.shop_status !== 'dismissed')
    || (input.shop_type !== 'buy' && input.shop_type !== 'sell')
    || !integer(input.x, 0, 1000) || !integer(input.y, 0, 1000)
    || !array(input.items) || input.items.length > 256
    || (input.shop_status === 'dismissed' && input.items.length !== 0)) return undefined;
  const items: UploadItem[] = [];
  for (let index = 0; index < input.items.length; index++) {
    const item = parseItem(input.items[index]);
    if (!item) return undefined;
    items.push(item);
  }
  return { ...('shop_id' in input ? { shop_id: shopId } : {}), uuid: input.uuid, shop_status: input.shop_status,
    vendor_account_id: account, vendor_name: vendor, title, shop_type: input.shop_type, map_name: map,
    x: input.x, y: input.y, items } as UploadShop;
}

// Undefined means use the reference schema, preserving all existing error issues.
export function tryParseUploadRequest(input: unknown): UploadRequest | undefined {
  if (!record(input, requestKeys) || input.protocol_version !== 2) return undefined;
  const run = text(input.client_run_id, 1, 120);
  const snapshot = text(input.snapshot_id, 1, 160);
  if (run === undefined || snapshot === undefined
    || (input.snapshot_mode !== 'full' && input.snapshot_mode !== 'delta' && input.snapshot_mode !== 'heartbeat')
    || !integer(input.part_index, 0, 63) || !integer(input.part_count, 1, 64) || input.part_index >= input.part_count
    || typeof input.observed_at !== 'string' || !uploadObservedAtSchema.safeParse(input.observed_at).success
    || !array(input.shops) || input.shops.length > 300) return undefined;
  const shops: UploadShop[] = [];
  const uuids = new Set<string>();
  for (let index = 0; index < input.shops.length; index++) {
    const shop = parseShop(input.shops[index]);
    if (!shop || uuids.has(shop.uuid)) return undefined;
    uuids.add(shop.uuid);
    shops.push(shop);
  }
  return { protocol_version: 2, client_run_id: run, snapshot_id: snapshot, snapshot_mode: input.snapshot_mode,
    part_index: input.part_index, part_count: input.part_count, observed_at: input.observed_at, shops };
}
