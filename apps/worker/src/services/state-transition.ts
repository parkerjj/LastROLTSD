import type { UploadItem } from '@lastroweb/protocol';
import { calculateQuantityTransition } from '../domain/transitions';
import type { ListingRow } from '../db/types';
import type { AuthenticatedSource } from '../middleware/auth';
import type { ListingStateService, NormalizedObservation, StateBatchResult } from './ingestion';
import type { MarketRepository } from '../db/repository';
import { buildSoldEvent } from './sold-events';
import type { ShopSessionRow } from '../db/types';

export interface ListingObservation { listing: ListingRow; item: UploadItem; observedAt: number; batchId: string; baselineComplete: boolean; }
export interface ObservationResult { updated: boolean; conflict: boolean; historyWritten: boolean; soldEvent: Awaited<ReturnType<typeof buildSoldEvent>>; listing: ListingRow; }

export async function applyListingObservation(input: ListingObservation, repo: MarketRepository): Promise<ObservationResult> {
  const transition = calculateQuantityTransition(input.listing.quantity, input.item.quantity);
  const changed = transition.kind !== 'unchanged' || input.listing.price !== input.item.price;
  let listing = input.listing;
  if (changed) {
    if (!repo.applyListingChanges) throw new Error('repository cannot apply listing changes');
    const result = await repo.applyListingChanges([{ listingId: listing.id, expectedVersion: listing.stateVersion, price: input.item.price, quantity: input.item.quantity, status: input.item.quantity === 0 ? 'sold_out' : 'active', observedAt: input.observedAt, batchId: input.batchId }]);
    if (result.conflicts) return { updated: false, conflict: true, historyWritten: false, soldEvent: null, listing };
    listing = { ...listing, price: input.item.price, lastQuantity: listing.quantity, quantity: input.item.quantity, stateVersion: listing.stateVersion + 1, status: input.item.quantity === 0 ? 'sold_out' : 'active' };
  }
  const historyWritten = changed;
  if (historyWritten && repo.insertHistory) await repo.insertHistory({ listingId: listing.id, observedAt: input.observedAt, price: input.item.price, quantity: input.item.quantity, eventType: transition.kind === 'unchanged' ? 'price_changed' : 'quantity_changed', batchId: input.batchId });
  const soldEvent = await buildSoldEvent(listing, transition, transition.kind === 'sold_out' ? 'sold_out' : 'quantity_decrease', input.observedAt, input.baselineComplete);
  if (soldEvent && repo.insertSoldEvent) await repo.insertSoldEvent(soldEvent);
  return { updated: changed, conflict: false, historyWritten, soldEvent, listing };
}

export function createListingStateService(repo: MarketRepository): ListingStateService {
  return { async applyBatchObservations(source: AuthenticatedSource, session: ShopSessionRow, observations: NormalizedObservation[], batchId: string, observedAt: number): Promise<StateBatchResult> {
    let changedListings = 0; let soldEvents = 0;
    const existing = await repo.loadListingsByFingerprint(session.id, observations.map((observation) => observation.fingerprint));
    const byFingerprint = new Map(existing.map((listing) => [listing.itemFingerprint, listing]));
    for (const observation of observations) {
      const current = byFingerprint.get(observation.fingerprint);
      if (!current) {
        if (!repo.createListing) throw new Error('repository cannot create listings');
        const created = await repo.createListing({ sessionId: session.id, fingerprint: observation.fingerprint, ...(observation.item.item_key === undefined ? {} : { itemKey: observation.item.item_key }), itemId: observation.item.item_id, itemName: observation.item.name, itemNameNormalized: observation.item.name.normalize('NFKC').toLowerCase(), upgrade: observation.item.upgrade, slots: observation.item.slots, cards: observation.item.cards, price: observation.item.price, quantity: observation.item.quantity, observedAt, batchId });
        if (repo.insertHistory) await repo.insertHistory({ listingId: created.id, observedAt, price: created.price, quantity: created.quantity, eventType: 'first_seen', batchId });
        continue;
      }
      const result = await applyListingObservation({ listing: current, item: observation.item, observedAt, batchId, baselineComplete: session.initialSyncComplete }, repo);
      if (result.updated) changedListings += 1;
      if (result.soldEvent) soldEvents += 1;
    }
    return { processedListings: observations.length, changedListings, soldEvents };
  } };
}
