import type { CatalogItemRow } from '../db/types';

export interface ItemDisplay {
  itemId: number;
  name: string;
}

export function resolveItemDisplay(itemId: number, catalogRow: Pick<CatalogItemRow, 'itemId' | 'name'> | null): ItemDisplay {
  return { itemId, name: catalogRow?.itemId === itemId ? catalogRow.name : `未知物品 #${itemId}` };
}
