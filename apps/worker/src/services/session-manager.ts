import type { MarketRepository } from '../db/repository';
import type { ShopSessionContextInput } from '../db/repository';
import type { ShopSessionRow } from '../db/types';

export function getOrStartShopSession(sourceId: string, shopKey: string, clientRunId: string, observedAt: number, repo: MarketRepository, context: { vendorKey: string; vendorName: string; title: string; shopType: 'buy' | 'sell'; mapName: string; x: number; y: number }): Promise<ShopSessionRow> {
  return (async () => {
    const vendor = await repo.getOrCreateVendor(sourceId, { vendorKey: context.vendorKey, name: context.vendorName, mapName: context.mapName, x: context.x, y: context.y, updatedAt: observedAt });
    const shop = await repo.getOrCreateShop(sourceId, { shopKey, vendorId: vendor.id, title: context.title, shopType: context.shopType, mapName: context.mapName, x: context.x, y: context.y, lastSeenAt: observedAt, updatedAt: observedAt });
    return repo.getOrCreateSession({ shopId: shop.id, clientRunId, observedAt });
  })();
}

export function getOrStartShopSessions(inputs: ShopSessionContextInput[], repo: MarketRepository): Promise<ShopSessionRow[]> {
  if (inputs.length === 0) return Promise.resolve([]);
  if (repo.getOrCreateSessions) return repo.getOrCreateSessions(inputs);
  return Promise.all(inputs.map((input) => getOrStartShopSession(input.sourceId, input.shopKey, input.clientRunId, input.observedAt, repo, { vendorKey: input.vendorKey, vendorName: input.vendorName, title: input.title, shopType: input.shopType, mapName: input.mapName, x: input.x, y: input.y })));
}
