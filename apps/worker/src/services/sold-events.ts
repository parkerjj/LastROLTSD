import { makeTransitionKey } from '../domain/transitions';
import type { ListingRow } from '../db/types';
import type { QuantityTransition } from '../domain/transitions';

export interface SoldEventCandidate { listingId: number; soldQuantity: number; fromQuantity: number; toQuantity: number; reason: string; observedAt: number; transitionKey: string; }
export async function buildSoldEvent(listing: ListingRow, transition: QuantityTransition, reason: string, observedAt: number, baselineComplete: boolean): Promise<SoldEventCandidate | null> {
  if (!baselineComplete || transition.soldQuantity <= 0) return null;
  return { listingId: listing.id, soldQuantity: transition.soldQuantity, fromQuantity: transition.oldQuantity, toQuantity: transition.newQuantity, reason, observedAt, transitionKey: await makeTransitionKey(listing.id, listing.stateVersion, transition.oldQuantity, transition.newQuantity, reason) };
}
