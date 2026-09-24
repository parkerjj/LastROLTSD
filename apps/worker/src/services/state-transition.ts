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

type NewListingInput = { sessionId: number; fingerprint: string; itemKey?: string; itemId: number; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string };

function newListingInput(observation: NormalizedObservation, observedAt: number, batchId: string): NewListingInput {
  return { sessionId: observation.sessionId, fingerprint: observation.fingerprint, ...(observation.item.item_key === undefined ? {} : { itemKey: observation.item.item_key }), itemId: observation.item.item_id, upgrade: observation.item.upgrade, slots: observation.item.slots, cards: observation.item.cards, price: observation.item.price, quantity: observation.item.quantity, observedAt, batchId };
}

export interface ListingObservation { listing: ListingRow; item: UploadItem; observedAt: number; batchId: string; baselineComplete: boolean; }
export interface ObservationResult { updated: boolean; conflict: boolean; historyWritten: boolean; soldEvent: Awaited<ReturnType<typeof buildSoldEvent>>; listing: ListingRow; }

interface TransitionPlan { listing: ListingRow; item: UploadItem; transition: ReturnType<typeof calculateQuantityTransition>; soldEvent: Awaited<ReturnType<typeof buildSoldEvent>>; change: ListingTransitionChange; }

function listingStateConflict(): IngestionError {
  return new IngestionError(409, 'listing_state_conflict', 'Listing state changed during upload', { retryable: true, retryAfterSeconds: 1 });
}

function ingestionInvariantFailed(message: string): IngestionError {
  return new IngestionError(500, 'ingestion_invariant_failed', message, { retryable: true });
}

async function makePlan(listing: ListingRow, item: UploadItem, observedAt: number, batchId: string, baselineComplete: boolean): Promise<TransitionPlan> {
  const transition = calculateQuantityTransition(listing.quantity, item.quantity);
  const reappeared = listing.status === 'missing' || listing.status === 'expired' || listing.missingStreak > 0;
  const changed = observedAt >= listing.lastChangedAt && (transition.kind !== 'unchanged' || listing.price !== item.price || reappeared);
  const soldReason = transition.kind === 'sold_out'
    ? 'sold_out'
    : transition.kind === 'decreased'
      ? 'quantity_decrease'
      : null;
  const resetSaleBaseline = listing.status === 'missing' || listing.status === 'expired';
  const soldEvent = soldReason === null || !changed || resetSaleBaseline
    ? null
    : await buildSoldEvent(listing, transition, soldReason, observedAt, baselineComplete);
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
      ...(changed ? { history: { eventType: reappeared ? 'reappeared' : transition.kind === 'unchanged' ? 'price_changed' : 'quantity_changed' } } : {}),
      ...(soldEvent ? { soldEvent: { soldQuantity: soldEvent.soldQuantity, fromQuantity: soldEvent.fromQuantity, toQuantity: soldEvent.toQuantity, reason: soldEvent.reason, transitionKey: soldEvent.transitionKey } } : {}),
    },
  };
}

function updatedListing(plan: TransitionPlan): ListingRow {
  return { ...plan.listing, price: plan.item.price, lastQuantity: plan.listing.quantity, quantity: plan.item.quantity, stateVersion: plan.listing.stateVersion + 1, status: plan.item.quantity === 0 ? 'sold_out' : 'active', lastChangedAt: plan.change.observedAt, missingStreak: 0 };
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
  if (!repo.applyListingChanges) throw ingestionInvariantFailed('Repository cannot apply listing changes');
  const result = await repo.applyListingChanges([{ listingId: plan.listing.id, expectedVersion: plan.listing.stateVersion, price: input.item.price, quantity: input.item.quantity, status: plan.change.status, observedAt: input.observedAt, batchId: input.batchId }]);
  if (result.conflicts) return { updated: false, conflict: true, historyWritten: false, soldEvent: null, listing: input.listing };
  const listing = updatedListing(plan);
  if (repo.insertHistory) await repo.insertHistory({ listingId: listing.id, observedAt: input.observedAt, price: input.item.price, quantity: input.item.quantity, eventType: plan.change.history!.eventType, batchId: input.batchId });
  if (plan.soldEvent && repo.insertSoldEvent) await repo.insertSoldEvent({ ...plan.soldEvent, snapshotId: input.batchId, price: input.item.price });
  return { updated: true, conflict: false, historyWritten: true, soldEvent: plan.soldEvent, listing };
}

export function createListingStateService(repo: MarketRepository): ListingStateService {
  const applyBatchObservations = async (source: AuthenticatedSource, session: ShopSessionRow, observations: NormalizedObservation[], batchId: string, observedAt: number): Promise<StateBatchResult> => {
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
      if (repo.createListingsBundleBatch) {
        for (let offset = 0; offset < newObservations.length; offset += CREATE_CHUNK_SIZE) {
          const chunk = newObservations.slice(offset, offset + CREATE_CHUNK_SIZE);
          await repo.createListingsBundleBatch(chunk.map((observation) => ({ ...newListingInput(observation, observedAt, batchId), options: observation.item.options as never })));
        }
      } else if (repo.createListingsBatch && repo.insertHistoriesBatch && repo.insertListingOptionsBatch) {
        for (let offset = 0; offset < newObservations.length; offset += CREATE_CHUNK_SIZE) {
          const chunk = newObservations.slice(offset, offset + CREATE_CHUNK_SIZE);
          const created = await repo.createListingsBatch(chunk.map((observation) => newListingInput(observation, observedAt, batchId)));
          const observationsByFingerprint = new Map(chunk.map((observation) => [observation.fingerprint, observation]));
          await repo.insertHistoriesBatch(created.map((listing) => ({ listingId: listing.id, observedAt, price: listing.price, quantity: listing.quantity, eventType: 'first_seen', batchId })));
          await repo.insertListingOptionsBatch(created.map((listing) => ({ listingId: listing.id, options: observationsByFingerprint.get(listing.itemFingerprint)?.item.options ?? [] })));
        }
      } else {
        if (!repo.createListing) throw ingestionInvariantFailed('Repository cannot create listings');
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
        if (!refreshed) throw listingStateConflict();
        const retry = await makePlan(refreshed, plan.item, observedAt, batchId, session.initialSyncComplete);
        const retryResult = await repo.applyListingTransitions([retry.change]);
        if (retryResult.conflicts) throw listingStateConflict();
        changedListings += retryResult.updated;
        soldEvents += retryResult.soldEvents;
      }
    } else {
      for (const plan of plans) {
        const result = await applyListingObservation({ listing: plan.listing, item: plan.item, observedAt, batchId, baselineComplete: session.initialSyncComplete }, repo);
        if (result.conflict) throw listingStateConflict();
        if (result.updated) changedListings += 1;
        if (result.soldEvent) soldEvents += 1;
      }
    }
    return { processedListings: observations.length, changedListings, soldEvents };
  };

  const applyBatchObservationsBulk = async (source: AuthenticatedSource, sessions: Map<number, ShopSessionRow>, observations: NormalizedObservation[], batchId: string, observedAt: number): Promise<StateBatchResult> => {
    if (observations.length === 0) return { processedListings: 0, changedListings: 0, soldEvents: 0 };
    if (repo.loadListingsByObservations && repo.insertNewListingsBulk) {
      const existing = await repo.loadListingsByObservations(observations.map((observation) => ({ sessionId: observation.sessionId, fingerprint: observation.fingerprint })));
      const byKey = new Map(existing.map((listing) => [listing.shopSessionId + ':' + listing.itemFingerprint, listing]));
      const newInputs = observations.filter((observation) => !byKey.has(observation.sessionId + ':' + observation.fingerprint)).map((observation) => ({ ...newListingInput(observation, observedAt, batchId), options: observation.item.options }));
      if (newInputs.length > 0) await repo.insertNewListingsBulk(newInputs);
      const plans: TransitionPlan[] = [];
      for (const observation of observations) {
        const listing = byKey.get(observation.sessionId + ':' + observation.fingerprint);
        if (!listing) continue;
        const session = sessions.get(observation.sessionId);
        if (!session) throw ingestionInvariantFailed('Session disappeared during upload');
        const plan = await makePlan(listing, observation.item, observedAt, batchId, session.initialSyncComplete);
        if (plan.change.history) plans.push(plan);
      }
      if (plans.length > 0 && repo.applyListingTransitionsBulk) {
        const result = await repo.applyListingTransitionsBulk(plans.map((plan) => plan.change));
        let changedListings = result.updated;
        let soldEvents = result.soldEvents;
        if (result.conflicts > 0) {
          if (!result.conflictIds) throw listingStateConflict();
          const conflictIds = new Set(result.conflictIds ?? []);
          for (const plan of plans.filter((candidate) => conflictIds.has(candidate.listing.id))) {
            const refreshed = repo.loadListingById ? await repo.loadListingById(plan.listing.id, plan.listing.shopSessionId) : null;
            if (!refreshed) throw listingStateConflict();
            const session = sessions.get(plan.listing.shopSessionId);
            if (!session) throw ingestionInvariantFailed('Session disappeared during upload');
            const retry = await makePlan(refreshed, plan.item, observedAt, batchId, session.initialSyncComplete);
            const retryResult = await repo.applyListingTransitionsBulk([retry.change]);
            if (retryResult.conflicts > 0) throw listingStateConflict();
            changedListings += retryResult.updated;
            soldEvents += retryResult.soldEvents;
          }
        }
        return { processedListings: observations.length, changedListings, soldEvents };
      }
      if (plans.length > 0 && repo.applyListingTransitions) {
        let changedListings = 0;
        let soldEvents = 0;
        for (const plan of plans) {
          const result = await applyListingObservation({ listing: plan.listing, item: plan.item, observedAt, batchId, baselineComplete: sessions.get(plan.listing.shopSessionId)?.initialSyncComplete ?? false }, repo);
          if (result.conflict) throw listingStateConflict();
          if (result.updated) changedListings += 1;
          if (result.soldEvent) soldEvents += 1;
        }
        return { processedListings: observations.length, changedListings, soldEvents };
      }
      if (plans.length > 0) throw ingestionInvariantFailed('Repository cannot apply listing transitions');
      return { processedListings: observations.length, changedListings: 0, soldEvents: 0 };
    }
    const groups = new Map<number, NormalizedObservation[]>();
    for (const observation of observations) groups.set(observation.sessionId, [...(groups.get(observation.sessionId) ?? []), observation]);
    let total: StateBatchResult = { processedListings: 0, changedListings: 0, soldEvents: 0 };
    for (const [sessionId, group] of groups) {
      const session = sessions.get(sessionId);
      if (!session) throw ingestionInvariantFailed('Session disappeared during upload');
      const next = await applyBatchObservations(source, session, group, batchId, observedAt);
      total = { processedListings: total.processedListings + next.processedListings, changedListings: total.changedListings + next.changedListings, soldEvents: total.soldEvents + next.soldEvents };
    }
    return total;
  };

  return { applyBatchObservations, applyBatchObservationsBulk };
}
