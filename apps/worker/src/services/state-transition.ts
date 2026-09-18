import type { UploadItem } from '@lastroweb/protocol';
import { calculateQuantityTransition } from '../domain/transitions';
import type { ListingRow } from '../db/types';
import type { AuthenticatedSource } from '../middleware/auth';
import type { ListingStateService, NormalizedObservation, StateBatchResult } from './ingestion';
import type { ListingTransitionChange, MarketRepository } from '../db/repository';
import { buildSoldEvent } from './sold-events';
import type { ShopSessionRow } from '../db/types';
import { IngestionError } from './ingestion';

const LOOKUP_CHUNK_SIZE = 40;
const CREATE_CHUNK_SIZE = 20;

type NewListingInput = { sessionId: number; fingerprint: string; itemKey?: string; itemId: number; itemName: string; itemNameNormalized: string; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string };

function newListingInput(observation: NormalizedObservation, observedAt: number, batchId: string): NewListingInput {
  return { sessionId: observation.sessionId, fingerprint: observation.fingerprint, ...(observation.item.item_key === undefined ? {} : { itemKey: observation.item.item_key }), itemId: observation.item.item_id, itemName: observation.item.name, itemNameNormalized: observation.item.name.normalize('NFKC').toLowerCase(), upgrade: observation.item.upgrade, slots: observation.item.slots, cards: observation.item.cards, price: observation.item.price, quantity: observation.item.quantity, observedAt, batchId };
}

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
    const existing: ListingRow[] = [];
    for (let offset = 0; offset < observations.length; offset += LOOKUP_CHUNK_SIZE) {
      existing.push(...await repo.loadListingsByFingerprint(session.id, observations.slice(offset, offset + LOOKUP_CHUNK_SIZE).map((observation) => observation.fingerprint)));
    }
    const byFingerprint = new Map(existing.map((listing) => [listing.itemFingerprint, listing]));
    const plans: TransitionPlan[] = [];
    const newObservations: NormalizedObservation[] = [];
    for (const observation of observations) {
      const current = byFingerprint.get(observation.fingerprint);
      if (!current) {
        newObservations.push(observation);
        continue;
      }
      const plan = await makePlan(current, observation.item, observedAt, batchId, session.initialSyncComplete);
      if (plan.change.history) plans.push(plan);
    }
    if (newObservations.length > 0) {
      if (repo.createListingsBatch && repo.insertHistoriesBatch && repo.insertListingOptionsBatch) {
        for (let offset = 0; offset < newObservations.length; offset += CREATE_CHUNK_SIZE) {
          const chunk = newObservations.slice(offset, offset + CREATE_CHUNK_SIZE);
          const created = await repo.createListingsBatch(chunk.map((observation) => newListingInput(observation, observedAt, batchId)));
          await repo.insertHistoriesBatch(created.map((listing) => ({ listingId: listing.id, observedAt, price: listing.price, quantity: listing.quantity, eventType: 'first_seen', batchId })));
          await repo.insertListingOptionsBatch(created.map((listing, index) => ({ listingId: listing.id, options: chunk[index]!.item.options })));
        }
      } else {
        if (!repo.createListing) throw new Error('repository cannot create listings');
        for (const observation of newObservations) {
          const created = await repo.createListing(newListingInput(observation, observedAt, batchId));
          if (repo.insertHistory) await repo.insertHistory({ listingId: created.id, observedAt, price: created.price, quantity: created.quantity, eventType: 'first_seen', batchId });
          if (repo.insertListingOptions) await repo.insertListingOptions({ listingId: created.id, options: observation.item.options });
        }
      }
    }
    if (plans.length > 0 && repo.applyListingTransitions) {
      const result = await repo.applyListingTransitions(plans.map((plan) => plan.change));
      changedListings += result.updated;
      soldEvents += result.soldEvents;
      const conflictIds = new Set(result.conflictIds ?? plans.slice(0, result.conflicts).map((plan) => plan.listing.id));
      for (const plan of plans.filter((candidate) => conflictIds.has(candidate.listing.id))) {
        const refreshed = repo.loadListingById ? await repo.loadListingById(plan.listing.id, plan.listing.shopSessionId) : null;
        if (!refreshed) throw new IngestionError(409, 'Listing state changed during upload');
        const retry = await makePlan(refreshed, plan.item, observedAt, batchId, session.initialSyncComplete);
        const retryResult = await repo.applyListingTransitions([retry.change]);
        if (retryResult.conflicts) throw new IngestionError(409, 'Listing state changed during upload');
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
