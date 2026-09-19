export interface ShopIdentityInput {
  sourceId: string;
  vendorAccountId: string;
  shopType: 'buy' | 'sell';
  mapName: string;
  x: number;
  y: number;
  title: string;
}

export interface NormalizedShopIdentity {
  identityVersion: 1;
  sourceId: string;
  vendorAccountId: string;
  shopType: 'buy' | 'sell';
  mapNameNormalized: string;
  x: number;
  y: number;
  titleNormalized: string;
  canonical: string;
}

const clean = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();

export function normalizeShopIdentity(input: ShopIdentityInput): NormalizedShopIdentity {
  const normalized = {
    identity_version: 1 as const,
    source_id: clean(input.sourceId),
    vendor_account_id: clean(input.vendorAccountId),
    shop_type: input.shopType,
    map_name_normalized: clean(input.mapName),
    x: Math.trunc(input.x),
    y: Math.trunc(input.y),
    title_normalized: clean(input.title),
  };
  return {
    identityVersion: normalized.identity_version,
    sourceId: normalized.source_id,
    vendorAccountId: normalized.vendor_account_id,
    shopType: normalized.shop_type,
    mapNameNormalized: normalized.map_name_normalized,
    x: normalized.x,
    y: normalized.y,
    titleNormalized: normalized.title_normalized,
    canonical: JSON.stringify(normalized),
  };
}

export async function computeShopIdentity(input: ShopIdentityInput): Promise<{ identityHash: string; shopId: string; canonical: string }> {
  const normalized = normalizeShopIdentity(input);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized.canonical));
  const identityHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { identityHash, shopId: `shop_v1_${identityHash}`, canonical: normalized.canonical };
}
