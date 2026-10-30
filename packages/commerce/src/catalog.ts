import type { CommerceCatalog, CommerceProduct, CommerceTerm } from './types';

const PRODUCTS: readonly CommerceProduct[] = [
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
];

const TERMS: readonly CommerceTerm[] = [
  { days: 30, discountPercent: 100 },
  { days: 90, discountPercent: 100 },
  { days: 180, discountPercent: 80 },
  { days: 360, discountPercent: 70 },
];

export function getCommerceCatalog(pricingVersion: string): CommerceCatalog {
  if (!pricingVersion.trim()) throw new Error('pricing version is required');

  return {
    pricingVersion,
    currency: 'CNY',
    billingMonthDays: 30,
    products: PRODUCTS.map((product) => ({ ...product })),
    terms: TERMS.map((term) => ({ ...term })),
  };
}
