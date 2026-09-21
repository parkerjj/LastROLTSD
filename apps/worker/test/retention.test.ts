import { describe, expect, it } from 'vitest';
import { runRetention } from '../src/services/retention';

describe('retention', () => { it('uses 180-day defaults and bounded chunks', async () => { const calls: Array<[string, number, number]> = []; const repo = { deleteExpiredHistory: async (before: number, limit: number) => { calls.push(['history', before, limit]); return 1; }, deleteExpiredSoldEvents: async (before: number, limit: number) => { calls.push(['sold', before, limit]); return 0; } } as any; const now = 180 * 24 * 60 * 60 * 1000 + 10; const result = await runRetention(now, { chunkSize: 10, maxChunks: 2 }, repo); expect(result.historyDeleted).toBe(1); expect(result.soldEventsDeleted).toBe(0); expect(calls[0]?.[2]).toBe(10); expect(calls[0]?.[1]).toBe(10); }); });
