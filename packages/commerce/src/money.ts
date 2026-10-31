import type { CommerceDiscountPercent } from './types';

export const COMMERCE_DAY_MS = 24n * 60n * 60n * 1000n;
export const COMMERCE_MONTH_MS = 30n * COMMERCE_DAY_MS;

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) throw new RangeError('amount must not be negative');
  if (denominator <= 0n) throw new RangeError('denominator must be positive');

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function priceLineCents(
  monthlyCents: bigint,
  durationMs: bigint,
  tierPercent: CommerceDiscountPercent,
): bigint {
  if (monthlyCents < 0n) throw new RangeError('monthly amount must not be negative');
  if (durationMs < 0n) throw new RangeError('duration must not be negative');
  if (tierPercent !== 100 && tierPercent !== 80 && tierPercent !== 70) {
    throw new RangeError('unsupported discount tier');
  }

  return roundHalfUp(monthlyCents * durationMs * BigInt(tierPercent), COMMERCE_MONTH_MS * 100n);
}
