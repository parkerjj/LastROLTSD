import { describe, expect, it } from 'vitest';
import type { D1Usage } from '../src/db/d1-meter';

type ResourceBudget = Partial<Pick<D1Usage, 'rowsRead' | 'rowsWritten' | 'durationMs'>>;

export function expectUsageAtMost(actual: D1Usage, budget: ResourceBudget): void {
  if (budget.rowsRead !== undefined) expect(actual.rowsRead).toBeLessThanOrEqual(budget.rowsRead);
  if (budget.rowsWritten !== undefined) expect(actual.rowsWritten).toBeLessThanOrEqual(budget.rowsWritten);
  if (budget.durationMs !== undefined) expect(actual.durationMs).toBeLessThanOrEqual(budget.durationMs);
}

export function expectStageWrites(actual: D1Usage, stage: string, expected: number): void {
  expect(actual.stages[stage]?.rowsWritten ?? 0).toBe(expected);
}

describe('D1 resource budget assertions', () => {
  it('uses billed rows_written instead of changes', () => {
    const usage: D1Usage = {
      rowsRead: 3,
      rowsWritten: 8,
      changes: 1,
      durationMs: 0.5,
      stages: {
        fixture: { rowsRead: 3, rowsWritten: 8, changes: 1, durationMs: 0.5 },
      },
    };

    expectUsageAtMost(usage, { rowsRead: 3, rowsWritten: 8, durationMs: 1 });
    expectStageWrites(usage, 'fixture', 8);
  });
});
