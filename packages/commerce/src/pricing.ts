import type { CommerceDiscountPercent, DiscountStrategy } from './types';
import { COMMERCE_MONTH_MS } from './money';

export function tierForDuration(durationMs: bigint): CommerceDiscountPercent {
  if (durationMs < 0n) throw new RangeError('duration must not be negative');
  if (durationMs >= 12n * COMMERCE_MONTH_MS) return 70;
  if (durationMs >= 6n * COMMERCE_MONTH_MS) return 80;
  return 100;
}

export function chooseDiscountStrategy(
  tierTotalCents: bigint,
  promoTotalCents: bigint | null,
): DiscountStrategy {
  return promoTotalCents !== null && promoTotalCents < tierTotalCents ? 'promotion_code' : 'term';
}
