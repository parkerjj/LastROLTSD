import { describe, expect, it } from 'vitest';
import { queryInput } from '../src/ke/shared-profile-router';

describe('shared profile list query parsing', () => {
  it('parses family IDs, removes duplicates, and preserves the legacy single ID', () => {
    expect(queryInput({ sort: 'likes', page: '2', job_ids: '1,7,13,7' })).toEqual({
      sort: 'likes', page: 2, job_ids: [1, 7, 13],
    });
    expect(queryInput({ job_id: '9' })).toEqual({ sort: 'newest', page: 1, job_id: 9 });
  });

  it('rejects malformed, oversized, or mixed job filters', () => {
    for (const job_ids of ['', '1,,2', '-1,2', '4294967296']) {
      expect(() => queryInput({ job_ids })).toThrow();
    }
    expect(() => queryInput({ job_ids: Array.from({ length: 65 }, (_, index) => String(index)).join(',') })).toThrow();
    expect(() => queryInput({ job_id: '1', job_ids: '1,2' })).toThrow();
  });
});
