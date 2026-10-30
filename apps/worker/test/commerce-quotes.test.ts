import { describe, expect, it, vi } from 'vitest';
import type { CommerceUnit } from '../src/commerce/unit-repository';
import { createQuote, type QuoteAccountState, type QuoteDependencies, type QuoteRepository } from '../src/commerce/quotes';
import { parseQuoteInput, QuoteInputError, type QuoteSelection } from '../src/commerce/quote-input';
import type { PromotionPreview, StripePreviewItem } from '../src/commerce/promotion-preview';

const DAY_MS = 24n * 60n * 60n * 1000n;
const NOW = 1_800_000_000_000;

function makeSlotUnit(unitId: string, entitlementId: string, expiresAt: bigint): CommerceUnit {
  return {
    unitId,
    userId: '42',
    resource: 'slots',
    unitKind: 'commerce',
    keEntitlementId: entitlementId,
    baselineSource: 'commerce',
    baselineSourceRef: `unit:${unitId}`,
    baselineQuantity: 1,
    baselineStartsAt: BigInt(NOW) - DAY_MS,
    baselineExpiresAt: expiresAt,
    legacyOriginId: null,
    legacyOrdinal: null,
    adminRevokedAt: null,
    refundZeroedAt: null,
    currentQuantity: 1,
    currentStartsAt: BigInt(NOW) - DAY_MS,
    currentExpiresAt: expiresAt,
  };
}

function makeState(overrides: Partial<QuoteAccountState> = {}): QuoteAccountState {
  const slots = [
    makeSlotUnit('11', '101', BigInt(NOW) + 15n * DAY_MS),
    makeSlotUnit('12', '102', BigInt(NOW) + 20n * DAY_MS),
  ];
  const entitlements = [
    { id: '101', unitId: '11', resource: 'slots', quantity: 1, startsAt: BigInt(NOW) - DAY_MS, expiresAt: BigInt(NOW) + 15n * DAY_MS, source: 'commerce', sourceRef: 'unit:11' },
    { id: '102', unitId: '12', resource: 'slots', quantity: 1, startsAt: BigInt(NOW) - DAY_MS, expiresAt: BigInt(NOW) + 20n * DAY_MS, source: 'commerce', sourceRef: 'unit:12' },
    { id: '201', unitId: null, resource: 'slots', quantity: 1, startsAt: BigInt(NOW) - DAY_MS, expiresAt: BigInt(NOW) + 99n * 365n * DAY_MS, source: 'signup', sourceRef: 'email-verified:slots' },
    { id: '202', unitId: null, resource: 'slots', quantity: -1, startsAt: BigInt(NOW) - DAY_MS, expiresAt: BigInt(NOW) + 60n * DAY_MS, source: 'admin', sourceRef: null },
    { id: '203', unitId: null, resource: 'module:standalone', quantity: 1, startsAt: BigInt(NOW) - DAY_MS, expiresAt: BigInt(NOW) + 3n * DAY_MS, source: 'legacy', sourceRef: null },
    { id: '204', unitId: null, resource: 'module:core', quantity: 1, startsAt: BigInt(NOW) - DAY_MS, expiresAt: BigInt(NOW) + 99n * 365n * DAY_MS, source: 'signup', sourceRef: 'email-verified:module:core' },
  ];
  return {
    slotUnits: slots,
    entitlements,
    effective: { slots: 2, modules: new Set(['core', 'standalone']) },
    ...overrides,
  };
}

function makeRepository(state: QuoteAccountState): QuoteRepository {
  return {
    readAccount: vi.fn(async () => state),
    insertQuote: vi.fn(async () => '501'),
  };
}

function dependencies(state = makeState(), overrides: Partial<QuoteDependencies> = {}): QuoteDependencies {
  return {
    repository: makeRepository(state),
    pricingVersion: 'ke-commerce-test-v1',
    now: () => NOW,
    productIds: { slots: 'prod_slots', 'module:standalone': 'prod_offline' },
    ...overrides,
  };
}

function selection(type: QuoteSelection['type'], termDays: 30 | 90 | 180 | 360, extra: Record<string, unknown> = {}): QuoteSelection {
  return { type, termDays, ...extra } as QuoteSelection;
}

describe('commerce quote input', () => {
  it('accepts only server-priced purchase selections and normalizes a promotion code', () => {
    expect(parseQuoteInput({
      selection: [
        { type: 'slot_add', quantity: 6, term_days: 180 },
        { type: 'standalone', term_days: 30 },
      ],
      promotion_code: ' SPRING20 ',
    })).toEqual({
      selection: [
        { type: 'slot_add', quantity: 6, termDays: 180 },
        { type: 'standalone', termDays: 30 },
      ],
      promotionCode: 'SPRING20',
    });
  });

  it('rejects client-supplied prices, expiry, user IDs, unknown keys, and unsupported terms', () => {
    for (const body of [
      { selection: [{ type: 'slot_add', quantity: 1, term_days: 30, amount_cents: 1 }] },
      { user_id: '42', selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }] },
      { selection: [{ type: 'slot_renew', unit_ids: ['11'], duration_ms: '123', term_days: 30 }] },
      { selection: [{ type: 'slot_add', quantity: 1, term_days: 60 }] },
    ]) expect(() => parseQuoteInput(body)).toThrow(QuoteInputError);
  });

  it('rejects duplicate units, multiple slot modes, and combining align with another product', () => {
    for (const body of [
      { selection: [{ type: 'slot_renew', unit_ids: ['11', '11'], term_days: 30 }] },
      { selection: [{ type: 'slot_add', quantity: 1, term_days: 30 }, { type: 'slot_renew', unit_ids: ['11'], term_days: 30 }] },
      { selection: [{ type: 'align_all_paid', term_days: 30 }, { type: 'standalone', term_days: 30 }] },
    ]) expect(() => parseQuoteInput(body)).toThrow(QuoteInputError);
  });
});

describe('authoritative commerce quotes', () => {
  it('refuses empty renewal and never renews the permanent signup quota', async () => {
    await expect(createQuote({ userId: '42', selection: [selection('slot_renew', 30, { unitIds: [] })] }, dependencies()))
      .rejects.toMatchObject({ code: 'COMMERCE_NO_RENEWABLE_SLOTS' });
    await expect(createQuote({ userId: '42', selection: [selection('slot_renew', 30, { unitIds: ['201'] })] }, dependencies()))
      .rejects.toMatchObject({ code: 'COMMERCE_TARGET_UNAVAILABLE' });
  });

  it('renews only selected paid units and leaves gifts and unselected expiries unchanged', async () => {
    const state = makeState();
    const quote = await createQuote({ userId: '42', selection: [selection('slot_renew', 30, { unitIds: ['12'] })] }, dependencies(state));
    const renewed = quote.items.find((item) => item.targetUnitId === '12');

    expect(quote.items).toHaveLength(1);
    expect(renewed).toMatchObject({ targetEntitlementId: '102', durationMs: String(30n * DAY_MS) });
    expect(BigInt(renewed!.expectedExpiresAt)).toBe(BigInt(NOW) + 50n * DAY_MS);
    expect(quote.accountPreview.after.entitlements.find((item) => item.entitlementId === '101')?.expiresAt)
      .toBe(String(BigInt(NOW) + 15n * DAY_MS));
    expect(quote.accountPreview.after.entitlements.find((item) => item.entitlementId === '101')?.unitId).toBe('11');
    expect(quote.accountPreview.after.entitlements.find((item) => item.entitlementId === '201')?.expiresAt)
      .toBe(String(BigInt(NOW) + 99n * 365n * DAY_MS));
  });

  it('extends standalone independently from every slot', async () => {
    const state = makeState({
      entitlements: [
        ...makeState().entitlements,
        { id: '205', unitId: null, resource: 'module:standalone', quantity: 1, startsAt: BigInt(NOW) - DAY_MS, expiresAt: BigInt(NOW) + 8n * DAY_MS, source: 'legacy', sourceRef: null },
      ],
    });
    const quote = await createQuote({ userId: '42', selection: [selection('standalone', 30)] }, dependencies(state));
    const feature = quote.items[0]!;

    expect(feature).toMatchObject({ productKey: 'module:standalone', operation: 'RENEW', targetEntitlementId: '205' });
    expect(BigInt(feature.expectedExpiresAt)).toBe(BigInt(NOW) + 38n * DAY_MS);
    expect(quote.accountPreview.after.entitlements.find((item) => item.entitlementId === '101')?.expiresAt)
      .toBe(String(BigInt(NOW) + 15n * DAY_MS));
  });

  it('opens standalone when signed adjustments currently make it unavailable', async () => {
    const state = makeState({
      entitlements: [
        ...makeState().entitlements,
        { id: '205', unitId: null, resource: 'module:standalone', quantity: -1, startsAt: BigInt(NOW) - DAY_MS,
          expiresAt: BigInt(NOW) + 60n * DAY_MS, source: 'admin', sourceRef: null },
      ],
      effective: { slots: 2, modules: new Set(['core']) },
    });
    const quote = await createQuote({ userId: '42', selection: [selection('standalone', 30)] }, dependencies(state));

    expect(quote.items[0]).toMatchObject({ operation: 'ADD', targetEntitlementId: null });
    expect(BigInt(quote.items[0]!.expectedExpiresAt)).toBe(BigInt(NOW) + 30n * DAY_MS);
    expect(quote.accountPreview.after.effective.modules).toContain('standalone');
  });

  it('excludes a standalone row when signed adjustments make the module ineffective during alignment', async () => {
    const state = makeState({
      entitlements: [
        ...makeState().entitlements,
        { id: '205', unitId: null, resource: 'module:standalone', quantity: -1, startsAt: BigInt(NOW) - DAY_MS,
          expiresAt: BigInt(NOW) + 60n * DAY_MS, source: 'admin', sourceRef: null },
      ],
      effective: { slots: 2, modules: new Set(['core']) },
    });
    const quote = await createQuote({ userId: '42', selection: [selection('align_all_paid', 30)] }, dependencies(state));

    expect(quote.items).toHaveLength(2);
    expect(quote.items.every((item) => item.productKey === 'slots')).toBe(true);
  });

  it('calculates post-purchase slot access from signed rows instead of the clamped current total', async () => {
    const state = makeState({
      slotUnits: [],
      entitlements: [
        { id: '301', unitId: null, resource: 'slots', quantity: -1, startsAt: BigInt(NOW) - DAY_MS,
          expiresAt: BigInt(NOW) + 30n * DAY_MS, source: 'admin', sourceRef: null },
      ],
      effective: { slots: 0, modules: new Set() },
    });
    const quote = await createQuote({ userId: '42', selection: [selection('slot_add', 30, { quantity: 1 })] }, dependencies(state));

    expect(quote.accountPreview.after.effective.slots).toBe(0);
  });

  it('aligns every chargeable item to the latest expiry plus term, excluding gifts and adjustments', async () => {
    const quote = await createQuote({ userId: '42', selection: [selection('align_all_paid', 30)] }, dependencies());
    const target = BigInt(NOW) + 50n * DAY_MS;

    expect(quote.items).toHaveLength(3);
    expect(quote.items.every((item) => BigInt(item.expectedExpiresAt) === target)).toBe(true);
    expect(quote.items.map((item) => BigInt(item.durationMs)).sort((a, b) => Number(a - b)))
      .toEqual([30n * DAY_MS, 35n * DAY_MS, 47n * DAY_MS]);
    expect(quote.rawTotalCents).toBe('15533');
    expect(quote.tierTotalCents).toBe('15533');
    expect(quote.accountPreview.after.entitlements.find((item) => item.entitlementId === '201')?.expiresAt)
      .toBe(String(BigInt(NOW) + 99n * 365n * DAY_MS));
    expect(quote.items.some((item) => item.targetEntitlementId === '202')).toBe(false);
  });

  it('refuses alignment when paid expiries are less than 24 hours apart and creates no quote', async () => {
    const closeUnits = [
      makeSlotUnit('11', '101', BigInt(NOW) + 5n * DAY_MS),
      makeSlotUnit('12', '102', BigInt(NOW) + 5n * DAY_MS + 23n * 60n * 60n * 1000n),
    ];
    const state = makeState({
      slotUnits: closeUnits,
      entitlements: makeState().entitlements.filter((item) => item.resource !== 'module:standalone'),
      effective: { slots: 3, modules: new Set(['core']) },
    });
    const deps = dependencies(state);

    await expect(createQuote({ userId: '42', selection: [selection('align_all_paid', 30)] }, deps))
      .rejects.toMatchObject({ code: 'COMMERCE_ALIGN_NOT_NEEDED' });
    expect(deps.repository.insertQuote).not.toHaveBeenCalled();
  });

  it('keeps one-time alignment supplements above 30 days when expiry spread reaches one day', async () => {
    const units = [
      makeSlotUnit('11', '101', BigInt(NOW) + 5n * DAY_MS),
      makeSlotUnit('12', '102', BigInt(NOW) + 6n * DAY_MS),
    ];
    const state = makeState({
      slotUnits: units,
      entitlements: makeState().entitlements.filter((item) => item.resource === 'slots'),
      effective: { slots: 3, modules: new Set() },
    });
    const quote = await createQuote({ userId: '42', selection: [selection('align_all_paid', 30)] }, dependencies(state));

    expect(quote.items).toHaveLength(2);
    expect(quote.items.some((item) => BigInt(item.durationMs) > 30n * DAY_MS)).toBe(true);
    expect(quote.items.some((item) => BigInt(item.durationMs) === 30n * DAY_MS)).toBe(true);
  });

  it('limits a quote to 1000 item units and rejects duplicate targets before persistence', async () => {
    const deps = dependencies();
    await expect(createQuote({ userId: '42', selection: [selection('slot_add', 30, { quantity: 1001 })] }, deps))
      .rejects.toMatchObject({ code: 'COMMERCE_ITEM_LIMIT' });
    await expect(createQuote({ userId: '42', selection: [selection('slot_renew', 30, { unitIds: ['11', '11'] })] }, deps))
      .rejects.toMatchObject({ code: 'COMMERCE_SELECTION_INVALID' });
    expect(deps.repository.insertQuote).not.toHaveBeenCalled();
  });

  it('chooses the cheapest whole-order strategy without stacking and uses term price for ties', async () => {
    const promo = vi.fn(async (_code: string, _items: readonly StripePreviewItem[]): Promise<PromotionPreview> => ({
      promotionCodeId: 'promo_spring', couponId: 'coupon_spring', subtotalCents: 60_000, totalCents: 47_000,
      discountCents: 13_000, currency: 'cny',
    }));
    const chosen = await createQuote({
      userId: '42', selection: [selection('slot_add', 180, { quantity: 2 })], promotionCode: 'SPRING',
    }, dependencies(makeState(), { previewPromotion: promo }));

    expect(promo).toHaveBeenCalledTimes(1);
    expect(promo).toHaveBeenCalledWith('SPRING', expect.any(Array), '42');
    expect(chosen).toMatchObject({ rawTotalCents: '60000', tierTotalCents: '48000', promoTotalCents: '47000', selectedTotalCents: '47000', discountStrategy: 'promotion_code' });
    expect(chosen.items.map((item) => item.paidCents)).toEqual(['23500', '23500']);
    expect(chosen.items.every((item) => item.tierCents === '24000')).toBe(true);

    const tie = await createQuote({
      userId: '42', selection: [selection('slot_add', 180, { quantity: 2 })], promotionCode: 'SPRING',
    }, dependencies(makeState(), {
      previewPromotion: vi.fn(async () => ({ promotionCodeId: 'promo_spring', couponId: 'coupon_spring', subtotalCents: 60_000, totalCents: 48_000, discountCents: 12_000, currency: 'cny' })),
    }));
    expect(tie.discountStrategy).toBe('term');
    expect(tie.selectedTotalCents).toBe('48000');
  });

  it('does not call Stripe when there is no promotion code', async () => {
    const promo = vi.fn();
    await createQuote({ userId: '42', selection: [selection('slot_add', 30, { quantity: 1 })] }, dependencies(makeState(), { previewPromotion: promo }));
    expect(promo).not.toHaveBeenCalled();
  });

  it('rejects inconsistent Stripe promotion totals before persisting a quote', async () => {
    const deps = dependencies(makeState(), {
      previewPromotion: vi.fn(async () => ({
        promotionCodeId: 'promo_spring', couponId: 'coupon_spring', subtotalCents: 5000, totalCents: 4000,
        discountCents: 999, currency: 'cny',
      })),
    });

    await expect(createQuote({
      userId: '42', selection: [selection('slot_add', 30, { quantity: 1 })], promotionCode: 'SPRING',
    }, deps)).rejects.toMatchObject({ code: 'COMMERCE_PROMOTION_INVALID' });
    expect(deps.repository.insertQuote).not.toHaveBeenCalled();
  });
});
