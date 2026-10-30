import { describe, expect, it, vi } from 'vitest';
import { previewPromotion, PromotionCodeError } from '../src/commerce/promotion-preview';
import type { StripeClient } from '../src/commerce/stripe-client';

describe('Stripe promotion preview', () => {
  it('previews only the supplied one-time CNY order and uses invoice total, not balance-adjusted amount_due', async () => {
    const get = vi.fn(async (path: string, params?: Record<string, unknown>) => {
      expect(path).toBe('/promotion_codes');
      expect(params).toEqual({ active: true, code: 'Holiday20', limit: 100 });
      return {
        data: [{
          id: 'promo_holiday', code: 'HOLIDAY20', active: true, customer: null,
          coupon: { id: 'coupon_holiday', valid: true, percent_off: 20, applies_to: { products: ['prod_slots'] } },
        }],
      };
    });
    const post = vi.fn(async (path: string, params?: Record<string, unknown>) => {
      expect(path).toBe('/invoices/create_preview');
      expect(params).toEqual({
        customer: 'cus_commerce',
        currency: 'cny',
        automatic_tax: { enabled: false },
        invoice_items: [
          { description: 'KE slots', discountable: true, price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 },
          { description: 'Offline KoreEngine', discountable: true, price_data: { currency: 'cny', product: 'prod_offline', unit_amount: 3000 }, quantity: 1 },
        ],
        discounts: [{ promotion_code: 'promo_holiday' }],
      });
      return { id: 'upcoming_in_preview', currency: 'cny', subtotal: 8000, total: 6400, amount_due: 0 };
    });
    const stripe = { get, post } as unknown as StripeClient;

    const result = await previewPromotion({
      customerId: 'cus_commerce',
      items: [
        { productKey: 'slots', productId: 'prod_slots', description: 'KE slots', rawUnitAmountCents: 5000, tierUnitAmountCents: 4000, durationMs: '15552000000', quantity: 1 },
        { productKey: 'module:standalone', productId: 'prod_offline', description: 'Offline KoreEngine', rawUnitAmountCents: 3000, tierUnitAmountCents: 3000, durationMs: '2592000000', quantity: 1 },
      ],
      promotionCode: '  Holiday20  ',
    }, stripe);

    expect(result).toEqual({
      promotionCodeId: 'promo_holiday',
      couponId: 'coupon_holiday',
      subtotalCents: 8000,
      totalCents: 6400,
      discountCents: 1600,
      currency: 'cny',
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('selects a customer-specific code over a same-code entry restricted to someone else', async () => {
    const get = vi.fn(async () => ({ data: [
      { id: 'promo_other', code: 'GIFT', active: true, customer: 'cus_someone_else', coupon: { id: 'coupon_other' } },
      { id: 'promo_owner', code: 'gift', active: true, customer: 'cus_current', coupon: { id: 'coupon_owner' } },
    ] }));
    const post = vi.fn(async (_path: string, params: Record<string, unknown>) => {
      expect(params.discounts).toEqual([{ promotion_code: 'promo_owner' }]);
      return { currency: 'cny', subtotal: 1000, total: 900 };
    });
    const result = await previewPromotion({
      customerId: 'cus_current',
      items: [{ productKey: 'slots', productId: 'prod_slots', description: 'KE slot', rawUnitAmountCents: 1000, tierUnitAmountCents: 1000, durationMs: '2592000000', quantity: 1 }],
      promotionCode: 'gift',
    }, { get, post } as unknown as StripeClient);

    expect(result.promotionCodeId).toBe('promo_owner');
  });

  it('aggregates up to 1000 selected units only when the complete checkout line matches', async () => {
    const get = vi.fn(async () => ({ data: [{
      id: 'promo_volume', code: 'VOLUME', active: true, customer: null, coupon: { id: 'coupon_volume' },
    }] }));
    const post = vi.fn(async (_path: string, params: Record<string, unknown>) => {
      const invoiceItems = params.invoice_items as Array<Record<string, unknown>>;
      expect(invoiceItems).toHaveLength(1);
      expect(invoiceItems[0]?.price_data).toEqual({ currency: 'cny', product: 'prod_slots', unit_amount: 500 });
      expect(invoiceItems[0]?.quantity).toBe(1000);
      return { currency: 'cny', subtotal: 500_000, total: 450_000 };
    });
    const result = await previewPromotion({
      customerId: 'cus_current',
      items: Array.from({ length: 1000 }, () => ({ productKey: 'slots' as const, productId: 'prod_slots', description: 'KE slot', rawUnitAmountCents: 500, tierUnitAmountCents: 500, durationMs: '2592000000', quantity: 1 })),
      promotionCode: 'VOLUME',
    }, { get, post } as unknown as StripeClient);

    expect(result.totalCents).toBe(450_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('keeps equal Product and prices separate when duration differs', async () => {
    const stripe = {
      get: vi.fn(async () => ({ data: [{
        id: 'promo_term', code: 'TERM', active: true, customer: null, coupon: { id: 'coupon_term' },
      }] })),
      post: vi.fn(async (_path: string, params: Record<string, unknown>) => {
        expect(params.invoice_items).toEqual([
          { description: 'KE slot', discountable: true, price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 },
          { description: 'KE slot', discountable: true, price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 5000 }, quantity: 1 },
        ]);
        return { currency: 'cny', subtotal: 10000, total: 9000 };
      }),
    } as unknown as StripeClient;

    await previewPromotion({
      customerId: 'cus_current',
      items: [
        { productKey: 'slots', productId: 'prod_slots', description: 'KE slot', rawUnitAmountCents: 5000, tierUnitAmountCents: 5000, durationMs: '2592000000', quantity: 1 },
        { productKey: 'slots', productId: 'prod_slots', description: 'KE slot', rawUnitAmountCents: 5000, tierUnitAmountCents: 5000, durationMs: '2678400000', quantity: 1 },
      ],
      promotionCode: 'TERM',
    }, stripe);
  });

  it('uses the same per-Product aggregate when more than 100 distinct semantic lines exceed Checkout limits', async () => {
    const stripe = {
      get: vi.fn(async () => ({ data: [{
        id: 'promo_many', code: 'MANY', active: true, customer: null, coupon: { id: 'coupon_many' },
      }] })),
      post: vi.fn(async (_path: string, params: Record<string, unknown>) => {
        expect(params.invoice_items).toEqual([{
          description: expect.any(String), discountable: true,
          price_data: { currency: 'cny', product: 'prod_slots', unit_amount: 505_000 }, quantity: 1,
        }]);
        return { currency: 'cny', subtotal: 505_000, total: 404_000 };
      }),
    } as unknown as StripeClient;

    const result = await previewPromotion({
      customerId: 'cus_current',
      items: Array.from({ length: 101 }, (_, index) => ({
        productKey: 'slots', productId: 'prod_slots', description: `KE slot ${index}`,
        rawUnitAmountCents: 5000, tierUnitAmountCents: 5000,
        durationMs: String(2_592_000_000 + index), quantity: 1,
      })),
      promotionCode: 'MANY',
    }, stripe);

    expect(result).toMatchObject({ subtotalCents: 505_000, totalCents: 404_000 });
  });

  it('rejects a preview whose subtotal includes anything beyond the fixed order items', async () => {
    const stripe = {
      get: vi.fn(async () => ({ data: [{
        id: 'promo_holiday', code: 'HOLIDAY', active: true, customer: null, coupon: { id: 'coupon_holiday' },
      }] })),
      post: vi.fn(async () => ({ currency: 'cny', subtotal: 9000, total: 8000 })),
    } as unknown as StripeClient;

    await expect(previewPromotion({
      customerId: 'cus_current',
      items: [{ productKey: 'slots', productId: 'prod_slots', description: 'KE slot', rawUnitAmountCents: 5000, tierUnitAmountCents: 5000, durationMs: '2592000000', quantity: 1 }],
      promotionCode: 'HOLIDAY',
    }, stripe)).rejects.toBeInstanceOf(PromotionCodeError);
  });

  it('rejects inactive, unknown, or other-customer-only codes with a fixed public error', async () => {
    const get = vi.fn(async () => ({ data: [
      { id: 'promo_other', code: 'HOLIDAY', active: true, customer: 'cus_someone_else', coupon: { id: 'coupon_other' } },
    ] }));
    const post = vi.fn();

    await expect(previewPromotion({
      customerId: 'cus_current',
      items: [{ productKey: 'slots', productId: 'prod_slots', description: 'KE slot', rawUnitAmountCents: 1000, tierUnitAmountCents: 1000, durationMs: '2592000000', quantity: 1 }],
      promotionCode: 'HOLIDAY',
    }, { get, post } as unknown as StripeClient)).rejects.toBeInstanceOf(PromotionCodeError);
    await expect(previewPromotion({
      customerId: 'cus_current',
      items: [{ productKey: 'slots', productId: 'prod_slots', description: 'KE slot', rawUnitAmountCents: 1000, tierUnitAmountCents: 1000, durationMs: '2592000000', quantity: 1 }],
      promotionCode: 'HOLIDAY',
    }, { get, post } as unknown as StripeClient)).rejects.toThrow('优惠码无效或不适用于此订单');
    expect(post).not.toHaveBeenCalled();
  });
});
