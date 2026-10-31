import { assertCommerceId } from './repository';

export type CommerceTermDays = 30 | 90 | 180 | 360;

export type QuoteSelection =
  | { type: 'slot_add'; quantity: number; termDays: CommerceTermDays }
  | { type: 'slot_renew'; unitIds: string[]; termDays: CommerceTermDays }
  | { type: 'standalone'; termDays: CommerceTermDays }
  | { type: 'align_all_paid'; termDays: CommerceTermDays };

export interface ParsedQuoteInput {
  selection: QuoteSelection[];
  promotionCode?: string;
}

export class QuoteInputError extends Error {
  constructor() {
    super('购买选择无效');
    this.name = 'QuoteInputError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function termDays(value: unknown): CommerceTermDays {
  if (value === 30 || value === 90 || value === 180 || value === 360) return value;
  throw new QuoteInputError();
}

function parseSelection(value: unknown): QuoteSelection {
  const input = record(value);
  if (!input || typeof input.type !== 'string') throw new QuoteInputError();
  const duration = termDays(input.term_days);
  switch (input.type) {
    case 'slot_add': {
      if (!exactKeys(input, ['type', 'quantity', 'term_days']) || !Number.isSafeInteger(input.quantity) || Number(input.quantity) < 1 || Number(input.quantity) > 1000) {
        throw new QuoteInputError();
      }
      return { type: 'slot_add', quantity: Number(input.quantity), termDays: duration };
    }
    case 'slot_renew': {
      if (!exactKeys(input, ['type', 'unit_ids', 'term_days']) || !Array.isArray(input.unit_ids) || input.unit_ids.length > 1000) {
        throw new QuoteInputError();
      }
      let unitIds: string[];
      try {
        unitIds = input.unit_ids.map((id) => assertCommerceId(id));
      } catch {
        throw new QuoteInputError();
      }
      if (new Set(unitIds).size !== unitIds.length) throw new QuoteInputError();
      return { type: 'slot_renew', unitIds, termDays: duration };
    }
    case 'standalone':
      if (!exactKeys(input, ['type', 'term_days'])) throw new QuoteInputError();
      return { type: 'standalone', termDays: duration };
    case 'align_all_paid':
      if (!exactKeys(input, ['type', 'term_days'])) throw new QuoteInputError();
      return { type: 'align_all_paid', termDays: duration };
    default:
      throw new QuoteInputError();
  }
}

export function parseQuoteInput(value: unknown): ParsedQuoteInput {
  const input = record(value);
  if (!input || !exactKeys(input, ['selection', 'promotion_code']) || !Array.isArray(input.selection) || input.selection.length < 1 || input.selection.length > 2) {
    throw new QuoteInputError();
  }
  const selection = input.selection.map(parseSelection);
  const types = selection.map((item) => item.type);
  const slotModes = types.filter((type) => type === 'slot_add' || type === 'slot_renew' || type === 'align_all_paid');
  if (new Set(types).size !== types.length || slotModes.length > 1 || (types.includes('align_all_paid') && selection.length !== 1)) {
    throw new QuoteInputError();
  }

  if (input.promotion_code === undefined) return { selection };
  if (typeof input.promotion_code !== 'string' || input.promotion_code.length > 100) throw new QuoteInputError();
  const promotionCode = input.promotion_code.trim();
  return promotionCode ? { selection, promotionCode } : { selection };
}
