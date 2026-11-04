import { describe, expect, it } from 'vitest';
import { getCommerceCatalog } from '@lastroweb/commerce';

describe('commerce catalog', () => {
  it('publishes the three independent CNY products and supported term discounts', () => {
    const catalog = getCommerceCatalog('2026-10-v1');

    expect(catalog).toMatchObject({
      pricingVersion: '2026-10-v1',
      currency: 'CNY',
      billingMonthDays: 30,
      products: [
        {
          key: 'slots',
          name: 'KE 实例额度',
          description: '按额度数量购买；每个付费额度可单独续期。',
          unitLabel: '个额度',
          monthlyUnitPriceCents: '5000',
          purchaseMode: 'quantity-and-duration',
        },
        {
          key: 'module:standalone',
          name: '全平台离线 KoreEngine 功能支持',
          description: '有效期间，账号下所有实例均可使用。',
          unitLabel: '账号功能',
          monthlyUnitPriceCents: '3000',
          purchaseMode: 'duration',
        },
        {
          key: 'module:hosting',
          name: '离线挂机（含全平台离线 KoreEngine 功能）',
          description: '把实例交给服务器 24 小时挂机；购买时自动包含等时长的全平台离线 KoreEngine 功能。托管实例数量受实例额度限制。',
          unitLabel: '账号功能',
          monthlyUnitPriceCents: '5000',
          purchaseMode: 'duration',
        },
      ],
      terms: [
        { days: 30, discountPercent: 100 },
        { days: 90, discountPercent: 100 },
        { days: 180, discountPercent: 80 },
        { days: 360, discountPercent: 70 },
      ],
    });
  });

  it('does not expose Stripe product or price identifiers', () => {
    const serialized = JSON.stringify(getCommerceCatalog('2026-10-v1'));
    expect(serialized).not.toMatch(/prod_[A-Za-z0-9]+|price_[A-Za-z0-9]+/);
  });

  it('rejects a missing pricing version', () => {
    expect(() => getCommerceCatalog('')).toThrow('pricing version is required');
  });
});
