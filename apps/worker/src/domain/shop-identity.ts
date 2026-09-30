import { Buffer } from 'node:buffer';

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
const encoder = new TextEncoder();
type ShopIdentity = { identityHash: string; shopId: string; canonical: string };
const identities = new Map<string, ShopIdentity>();
const MAX_CACHED_IDENTITIES = 1024;

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
  // Cache only immutable calculations, never source status, market state or I/O.
  // Include every raw identity field so normalized/hash semantics remain unchanged.
  const key = JSON.stringify([input.sourceId, input.vendorAccountId, input.shopType, input.mapName, input.x, input.y, input.title]);
  const cached = identities.get(key);
  if (cached) return { ...cached };
  const normalized = normalizeShopIdentity(input);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalized.canonical));
  const identityHash = Buffer.from(digest).toString('hex');
  const identity = { identityHash, shopId: `shop_v1_${identityHash}`, canonical: normalized.canonical };
  if (identities.size >= MAX_CACHED_IDENTITIES) identities.delete(identities.keys().next().value!);
  identities.set(key, identity);
  return { ...identity };
}
