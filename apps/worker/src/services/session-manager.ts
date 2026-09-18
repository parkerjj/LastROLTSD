import type { MarketRepository } from '../db/repository';
import type { ShopSessionRow } from '../db/types';

export function getOrStartShopSession(sourceId: string, shopKey: string, clientRunId: string, observedAt: number, repo: MarketRepository, context: { vendorKey: string; vendorName: string; title: string; shopType: 'buy' | 'sell'; mapName: string; x: number; y: number }): Promise<ShopSessionRow> {
  return (async () => {
    const vendor = await repo.getOrCreateVendor(sourceId, { vendorKey: context.vendorKey, name: context.vendorName, mapName: context.mapName, x: context.x, y: context.y, updatedAt: observedAt });
    const shop = await repo.getOrCreateShop(sourceId, { shopKey, vendorId: vendor.id, title: context.title, shopType: context.shopType, mapName: context.mapName, x: context.x, y: context.y, lastSeenAt: observedAt, updatedAt: observedAt });
    return repo.getOrCreateSession({ shopId: shop.id, clientRunId, observedAt });
  })();
}
