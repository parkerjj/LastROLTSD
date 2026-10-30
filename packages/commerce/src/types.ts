export type CommerceProductKey = 'slots' | 'module:standalone';
export type CommercePurchaseMode = 'quantity-and-duration' | 'duration';
export type CommerceDiscountPercent = 100 | 80 | 70;

export interface CommerceProduct {
  readonly key: CommerceProductKey;
  readonly name: string;
  readonly description: string;
  readonly unitLabel: string;
  readonly monthlyUnitPriceCents: string;
  readonly purchaseMode: CommercePurchaseMode;
}

export interface CommerceTerm {
  readonly days: number;
  readonly discountPercent: CommerceDiscountPercent;
}

export interface CommerceCatalog {
  readonly pricingVersion: string;
  readonly currency: 'CNY';
  readonly billingMonthDays: 30;
  readonly products: readonly CommerceProduct[];
  readonly terms: readonly CommerceTerm[];
}

export type DiscountStrategy = 'term' | 'promotion_code';
