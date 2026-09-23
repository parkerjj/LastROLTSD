import type { MarketRepository } from '../db/repository';

export interface RetentionPolicy { historyDays?: number; soldEventDays?: number; chunkSize?: number; maxChunks?: number; }
export interface RetentionResult { historyDeleted: number; soldEventsDeleted: number; guestbookRateBucketsDeleted: number; chunks: number; cutoff: number; }
const DAY = 24 * 60 * 60 * 1000;
export async function runRetention(now: number, policy: RetentionPolicy, repo: MarketRepository): Promise<RetentionResult> {
  const historyCutoff = now - (policy.historyDays ?? 180) * DAY; const soldCutoff = now - (policy.soldEventDays ?? 180) * DAY; const chunk = Math.min(500, Math.max(1, policy.chunkSize ?? 100)); const maxChunks = Math.min(100, Math.max(1, policy.maxChunks ?? 20)); let historyDeleted = 0; let soldEventsDeleted = 0; let chunks = 0;
  const deletedHistory = repo.deleteExpiredHistory ? await repo.deleteExpiredHistory(historyCutoff, chunk) : 0;
  historyDeleted += deletedHistory;
  chunks += 1;
  const deletedSold = repo.deleteExpiredSoldEvents ? await repo.deleteExpiredSoldEvents(soldCutoff, chunk) : 0;
  soldEventsDeleted += deletedSold;
  chunks += 1;
  let guestbookRateBucketsDeleted = 0;
  if (repo.deleteGuestbookRateBuckets) {
    for (let index = 0; index < maxChunks; index += 1) {
      const deleted = await repo.deleteGuestbookRateBuckets(now - 2 * DAY, chunk);
      guestbookRateBucketsDeleted += deleted;
      chunks += 1;
      if (deleted < chunk) break;
    }
  }
  return { historyDeleted, soldEventsDeleted, guestbookRateBucketsDeleted, chunks, cutoff: Math.min(historyCutoff, soldCutoff, now - 2 * DAY) };
}
