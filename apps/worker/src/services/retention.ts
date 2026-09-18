import type { MarketRepository } from '../db/repository';

export interface RetentionPolicy { historyDays?: number; soldEventDays?: number; chunkSize?: number; maxChunks?: number; }
export interface RetentionResult { historyDeleted: number; soldEventsDeleted: number; chunks: number; cutoff: number; }
const DAY = 24 * 60 * 60 * 1000;
export async function runRetention(now: number, policy: RetentionPolicy, repo: MarketRepository): Promise<RetentionResult> {
  const historyCutoff = now - (policy.historyDays ?? 90) * DAY; const soldCutoff = now - (policy.soldEventDays ?? 90) * DAY; const chunk = Math.min(500, Math.max(1, policy.chunkSize ?? 100)); const maxChunks = Math.min(100, Math.max(1, policy.maxChunks ?? 20)); let historyDeleted = 0; let soldEventsDeleted = 0; let chunks = 0;
  for (let index = 0; index < maxChunks; index += 1) { const deleted = repo.deleteExpiredHistory ? await repo.deleteExpiredHistory(historyCutoff, chunk) : 0; historyDeleted += deleted; chunks += 1; if (deleted < chunk) break; }
  for (let index = 0; index < maxChunks; index += 1) { const deleted = repo.deleteExpiredSoldEvents ? await repo.deleteExpiredSoldEvents(soldCutoff, chunk) : 0; soldEventsDeleted += deleted; chunks += 1; if (deleted < chunk) break; }
  return { historyDeleted, soldEventsDeleted, chunks, cutoff: Math.min(historyCutoff, soldCutoff) };
}
