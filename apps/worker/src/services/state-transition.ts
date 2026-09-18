import type { UploadItem } from '@lastroweb/protocol';
import { calculateQuantityTransition } from '../domain/transitions';
import type { ListingRow } from '../db/types';
import type { AuthenticatedSource } from '../middleware/auth';
import type { ListingStateService, NormalizedObservation, StateBatchResult } from './ingestion';
import type { ListingTransitionChange, MarketRepository } from '../db/repository';
import { buildSoldEvent } from './sold-events';
import type { ShopSessionRow } from '../db/types';

export interface ListingObservation { listing: ListingRow; item: UploadItem; observedAt: number; batchId: string; baselineComplete: boolean; }
export interface ObservationResult { updated: boolean; conflict: boolean; historyWritten: boolean; soldEvent: Awaited<ReturnType<typeof buildSoldEvent>>; listing: ListingRow; }

interface TransitionPlan { listing: ListingRow; item: UploadItem; transition: ReturnType<typeof calculateQuantityTransition>; soldEvent: Awaited<ReturnType<typeof buildSoldEvent>>; change: ListingTransitionChange; }

async function makePlan(listing: ListingRow, item: UploadItem, observedAt: number, batchId: string, baselineComplete: boolean): Promise<TransitionPlan> {
  const transition = calculateQuantityTransition(listing.quantity, item.quantity);
  const changed = transition.kind !== 'unchanged' || listing.price !== item.price;
  const soldEvent = await buildSoldEvent(listing, transition, transition.kind === 'sold_out' ? 'sold_out' : 'quantity_decrease', observedAt, baselineComplete);
  return {
    listing,
    item,
    transition,
    soldEvent,
    change: {
      listingId: listing.id,
      shopSessionId: listing.shopSessionId,
      expectedVersion: listing.stateVersion,
      price: item.price,
      quantity: item.quantity,
      status: item.quantity === 0 ? 'sold_out' : 'active',
      observedAt,
      batchId,
      ...(changed ? { history: { eventType: transition.kind === 'unchanged' ? 'price_changed' : 'quantity_changed' } } : {}),
      ...(soldEvent ? { soldEvent: { soldQuantity: soldEvent.soldQuantity, fromQuantity: soldEvent.fromQuantity, toQuantity: soldEvent.toQuantity, reason: soldEvent.reason, transitionKey: soldEvent.transitionKey } } : {}),
    },
  };
}

function updatedListing(plan: TransitionPlan): ListingRow {
  return { ...plan.listing, price: plan.item.price, lastQuantity: plan.listing.quantity, quantity: plan.item.quantity, stateVersion: plan.listing.stateVersion + 1, status: plan.item.quantity === 0 ? 'sold_out' : 'active', lastSeenAt: plan.change.observedAt, missingStreak: 0 };
}

export async function applyListingObservation(input: ListingObservation, repo: MarketRepository): Promise<ObservationResult> {
  const plan = await makePlan(input.listing, input.item, input.observedAt, input.batchId, input.baselineComplete);
  const changed = Boolean(plan.change.history);
  if (!changed) return { updated: false, conflict: false, historyWritten: false, soldEvent: null, listing: input.listing };
  if (repo.applyListingTransitions) {
    let result = await repo.applyListingTransitions([plan.change]);
    let current = plan;
    if (result.conflicts) {
      const refreshed = repo.loadListingById ? await repo.loadListingById(input.listing.id, input.listing.shopSessionId) : null;
      if (!refreshed) return { updated: false, conflict: true, historyWritten: false, soldEvent: null, listing: input.listing };
      current = await makePlan(refreshed, input.item, input.observedAt, input.batchId, input.baselineComplete);
      result = await repo.applyListingTransitions([current.change]);
    }
    if (result.conflicts) return { updated: false, conflict: true, historyWritten: false, soldEvent: null, listing: current.listing };
    return { updated: true, conflict: false, historyWritten: true, soldEvent: current.soldEvent, listing: updatedListing(current) };
  }
  if (!repo.applyListingChanges) throw new Error('repository cannot apply listing changes');
  const result = await repo.applyListingChanges([{ listingId: plan.listing.id, expectedVersion: plan.listing.stateVersion, price: input.item.price, quantity: input.item.quantity, status: plan.change.status, observedAt: input.observedAt, batchId: input.batchId }]);
  if (result.conflicts) return { updated: false, conflict: true, historyWritten: false, soldEvent: null, listing: input.listing };
  const listing = updatedListing(plan);
  if (repo.insertHistory) await repo.insertHistory({ listingId: listing.id, observedAt: input.observedAt, price: input.item.price, quantity: input.item.quantity, eventType: plan.change.history!.eventType, batchId: input.batchId });
  if (plan.soldEvent && repo.insertSoldEvent) await repo.insertSoldEvent(plan.soldEvent);
  return { updated: true, conflict: false, historyWritten: true, soldEvent: plan.soldEvent, listing };
}

export function createListingStateService(repo: MarketRepository): ListingStateService {
  return { async applyBatchObservations(source: AuthenticatedSource, session: ShopSessionRow, observations: NormalizedObservation[], batchId: string, observedAt: number): Promise<StateBatchResult> {
    let changedListings = 0; let soldEvents = 0;
    const existing = await repo.loadListingsByFingerprint(session.id, observations.map((observation) => observation.fingerprint));
    const byFingerprint = new Map(existing.map((listing) => [listing.itemFingerprint, listing]));
    const plans: TransitionPlan[] = [];
    for (const observation of observations) {
      const current = byFingerprint.get(observation.fingerprint);
      if (!current) {
        if (!repo.createListing) throw new Error('repository cannot create listings');
        const created = await repo.createListing({ sessionId: session.id, fingerprint: observation.fingerprint, ...(observation.item.item_key === undefined ? {} : { itemKey: observation.item.item_key }), itemId: observation.item.item_id, itemName: observation.item.name, itemNameNormalized: observation.item.name.normalize('NFKC').toLowerCase(), upgrade: observation.item.upgrade, slots: observation.item.slots, cards: observation.item.cards, price: observation.item.price, quantity: observation.item.quantity, observedAt, batchId });
        if (repo.insertHistory) await repo.insertHistory({ listingId: created.id, observedAt, price: created.price, quantity: created.quantity, eventType: 'first_seen', batchId });
        if (repo.insertListingOptions) await repo.insertListingOptions({ listingId: created.id, options: observation.item.options });
        continue;
      }
      const plan = await makePlan(current, observation.item, observedAt, batchId, session.initialSyncComplete);
      if (plan.change.history) plans.push(plan);
    }
    if (plans.length > 0 && repo.applyListingTransitions) {
      const result = await repo.applyListingTransitions(plans.map((plan) => plan.change));
      changedListings += result.updated;
      soldEvents += result.soldEvents;
      const conflictIds = new Set(result.conflictIds ?? []);
      for (const plan of plans.filter((candidate) => conflictIds.has(candidate.listing.id))) {
        const refreshed = repo.loadListingById ? await repo.loadListingById(plan.listing.id, plan.listing.shopSessionId) : null;
        if (!refreshed) continue;
        const retry = await makePlan(refreshed, plan.item, observedAt, batchId, session.initialSyncComplete);
        const retryResult = await repo.applyListingTransitions([retry.change]);
        changedListings += retryResult.updated;
        soldEvents += retryResult.soldEvents;
      }
    } else {
      for (const plan of plans) {
        const result = await applyListingObservation({ listing: plan.listing, item: plan.item, observedAt, batchId, baselineComplete: session.initialSyncComplete }, repo);
        if (result.updated) changedListings += 1;
        if (result.soldEvent) soldEvents += 1;
      }
    }
    return { processedListings: observations.length, changedListings, soldEvents };
  } };
}
