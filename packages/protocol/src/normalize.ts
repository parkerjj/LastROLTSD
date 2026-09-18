import type { ItemOption, UploadItem } from './types';

const toInt = (value: unknown): number => {
  if (typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) { const parsed = Number(value); if (Number.isSafeInteger(parsed)) return parsed; }
  throw new TypeError('expected safe integer');
};
const clean = (value: unknown): string => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
export function normalizeOption(input: Record<string, unknown>): ItemOption {
  return { type: toInt(input.type), value: toInt(input.value), param: toInt(input.param), ...(input.display_value === undefined ? {} : { display_value: clean(input.display_value) }) };
}
export function normalizeItem(input: Record<string, unknown>): UploadItem {
  const rawCards = Array.isArray(input.cards) ? input.cards : [];
  const cards = [0, 0, 0, 0].map((_, index) => rawCards[index] === undefined ? 0 : toInt(rawCards[index])).slice(0, 4);
  const rawOptions = Array.isArray(input.options) ? input.options : [];
  const sortedOptions = rawOptions.map((entry) => normalizeOption(entry as Record<string, unknown>)).sort((a, b) => a.type - b.type || a.value - b.value || a.param - b.param || (a.display_value ?? '').localeCompare(b.display_value ?? ''));
  const options: ItemOption[] = [];
  for (const option of sortedOptions) {
    const previous = options.at(-1);
    if (previous && previous.type === option.type && previous.value === option.value && previous.param === option.param) continue;
    options.push(option);
  }
  return {
    ...(input.item_key === undefined ? {} : { item_key: clean(input.item_key) }), item_id: toInt(input.item_id), name: clean(input.name),
    upgrade: input.upgrade === undefined ? 0 : toInt(input.upgrade), slots: input.slots === undefined ? 0 : toInt(input.slots), cards,
    price: toInt(input.price), quantity: toInt(input.quantity), options,
  };
}
