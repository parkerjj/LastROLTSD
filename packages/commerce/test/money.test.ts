import { describe, expect, it } from 'vitest';
import {
  COMMERCE_MONTH_MS,
  chooseDiscountStrategy,
  priceLineCents,
  tierForDuration,
} from '@lastroweb/commerce';

const DAY_MS = 24n * 60n * 60n * 1000n;

describe('commerce pricing', () => {
  it('prices common slot and standalone terms in integer CNY cents', () => {
    expect(COMMERCE_MONTH_MS).toBe(30n * DAY_MS);
    expect(priceLineCents(6n * 5000n, 30n * DAY_MS, 100)).toBe(30000n);
    expect(priceLineCents(5000n, 180n * DAY_MS, 80)).toBe(24000n);
    expect(priceLineCents(2n * 5000n, 90n * DAY_MS, 100)).toBe(30000n);
    expect(priceLineCents(3000n, 30n * DAY_MS, 100)).toBe(3000n);
  });

  it('rounds each prorated item half-up to the nearest fen', () => {
    expect(priceLineCents(5000n, 71n * DAY_MS / 2n, 100)).toBe(5917n);
  });

  it('rounds each charge unit before summing the order total', () => {
    const duration = 71n * DAY_MS / 2n;
    const perUnitTotal = Array.from({ length: 6 }, () => priceLineCents(5000n, duration, 100))
      .reduce((total, line) => total + line, 0n);

    expect(perUnitTotal).toBe(6n * 5917n);
    expect(priceLineCents(6n * 5000n, duration, 100)).toBe(35500n);
  });

  it('applies term discounts at exact duration thresholds', () => {
    expect(tierForDuration(180n * DAY_MS - 1000n)).toBe(100);
    expect(tierForDuration(180n * DAY_MS)).toBe(80);
    expect(tierForDuration(360n * DAY_MS - 1n)).toBe(80);
    expect(tierForDuration(360n * DAY_MS)).toBe(70);
    expect(tierForDuration(540n * DAY_MS)).toBe(70);
  });

  it('chooses the cheaper whole-order discount and keeps term pricing on a tie', () => {
    expect(chooseDiscountStrategy(24000n, 23000n)).toBe('promotion_code');
    expect(chooseDiscountStrategy(24000n, 24000n)).toBe('term');
    expect(chooseDiscountStrategy(24000n, 25000n)).toBe('term');
    expect(chooseDiscountStrategy(24000n, null)).toBe('term');
  });
});
