import type { MarketRepository } from '../db/repository';
import { MARKET_RETENTION_DAYS } from '../domain/retention';

export interface RetentionPolicy { historyDays?: number; soldEventDays?: number; chunkSize?: number; maxChunks?: number; }
export interface RetentionResult { historyDeleted: number; soldEventsDeleted: number; guestbookRateBucketsDeleted: number; chunks: number; cutoff: number; }
const DAY = 24 * 60 * 60 * 1000;
export async function runRetention(now: number, policy: RetentionPolicy, repo: MarketRepository): Promise<RetentionResult> {
  const historyCutoff = now - (policy.historyDays ?? MARKET_RETENTION_DAYS) * DAY;
  const soldCutoff = now - (policy.soldEventDays ?? MARKET_RETENTION_DAYS) * DAY;
  const chunk = Math.min(500, Math.max(1, policy.chunkSize ?? 100));
  const maxChunks = Math.min(100, Math.max(1, policy.maxChunks ?? 20));
  let chunks = 0;
  const sweep = async (remove: ((before: number, limit: number) => Promise<number>) | undefined, before: number): Promise<number> => {
    let total = 0;
    if (!remove) return total;
    for (let index = 0; index < maxChunks; index += 1) {
      const deleted = await remove(before, chunk);
      total += deleted;
      chunks += 1;
      if (deleted < chunk) break;
    }
    return total;
  };
  const historyDeleted = await sweep(repo.deleteExpiredHistory?.bind(repo), historyCutoff);
  const soldEventsDeleted = await sweep(repo.deleteExpiredSoldEvents?.bind(repo), soldCutoff);
  const guestbookRateBucketsDeleted = await sweep(repo.deleteGuestbookRateBuckets?.bind(repo), now - 2 * DAY);
  return { historyDeleted, soldEventsDeleted, guestbookRateBucketsDeleted, chunks, cutoff: Math.min(historyCutoff, soldCutoff, now - 2 * DAY) };
}
