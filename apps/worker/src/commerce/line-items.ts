import type { CommerceProductKey } from '@lastroweb/commerce';

export const MAX_STRIPE_CHECKOUT_LINE_ITEMS = 100;

export interface StripeCommerceItem {
  productKey: CommerceProductKey;
  productId: string;
  description: string;
  rawUnitAmountCents: number;
  tierUnitAmountCents: number;
  durationMs: string;
  quantity: number;
}

export interface StripeCommerceLine extends Omit<StripeCommerceItem, 'durationMs'> {
  durationMs: string | null;
}

export function groupStripeCommerceLines(items: readonly StripeCommerceItem[]): StripeCommerceLine[] {
  const grouped = new Map<string, StripeCommerceLine>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.rawUnitAmountCents) || item.rawUnitAmountCents <= 0
      || !Number.isSafeInteger(item.tierUnitAmountCents) || item.tierUnitAmountCents <= 0
      || item.tierUnitAmountCents > item.rawUnitAmountCents
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1
      || !/^[1-9]\d{0,15}$/u.test(item.durationMs)) {
      throw new RangeError('invalid commerce Stripe line');
    }
    const key = JSON.stringify([
      item.productKey, item.productId, item.description,
      item.rawUnitAmountCents, item.tierUnitAmountCents, item.durationMs,
    ]);
    const current = grouped.get(key);
    const quantity = (current?.quantity ?? 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) throw new RangeError('invalid commerce Stripe quantity');
    grouped.set(key, { ...item, quantity });
  }

  const exactLines = [...grouped.values()];
  if (exactLines.length <= MAX_STRIPE_CHECKOUT_LINE_ITEMS) return exactLines;

  const totals = new Map<string, { productKey: CommerceProductKey; productId: string; description: string; raw: bigint; tier: bigint }>();
  for (const item of items) {
    const current = totals.get(item.productId);
    totals.set(item.productId, {
      productKey: current?.productKey ?? item.productKey,
      productId: item.productId,
      description: current?.description ?? item.description,
      raw: (current?.raw ?? 0n) + BigInt(item.rawUnitAmountCents) * BigInt(item.quantity),
      tier: (current?.tier ?? 0n) + BigInt(item.tierUnitAmountCents) * BigInt(item.quantity),
    });
  }
  return [...totals.values()].map(({ productKey, productId, description, raw, tier }) => {
    if (raw <= 0n || tier <= 0n || raw > BigInt(Number.MAX_SAFE_INTEGER) || tier > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('commerce Stripe line exceeds safe amount');
    }
    return {
      productKey, productId, description,
      rawUnitAmountCents: Number(raw), tierUnitAmountCents: Number(tier),
      durationMs: null, quantity: 1,
    };
  });
}
