import { describe, expect, it, vi } from 'vitest';
import type { MysqlDatabase } from '../src/db/mysql-client';
import { createSharedProfileRepository } from '../src/ke/shared-profile-repository';

describe('shared profile repository job filters', () => {
  it('uses a parameterized IN filter for a job family and keeps the legacy equality filter', async () => {
    const all = vi.fn(async (_sql: string, _values?: readonly unknown[]) => []);
    const first = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ n: 0 }));
    const repository = createSharedProfileRepository({ all, first } as unknown as MysqlDatabase);

    await repository.list(5, { sort: 'newest', page: 3, job_ids: [1, 7, 13] });
    expect(all.mock.calls[0]?.[0]).toContain('s.job_id IN (?, ?, ?)');
    expect(all.mock.calls[0]?.[1]).toEqual([5, 5, 1, 7, 13, 40]);
    expect(first.mock.calls[0]?.[0]).toContain('s.job_id IN (?, ?, ?)');
    expect(first.mock.calls[0]?.[1]).toEqual([1, 7, 13]);

    await repository.list(5, { sort: 'newest', page: 1, job_id: 9 });
    expect(all.mock.calls[1]?.[0]).toContain('s.job_id = ?');
    expect(all.mock.calls[1]?.[1]).toEqual([5, 5, 9, 0]);
  });
});
