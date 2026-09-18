import { describe, expect, it } from 'vitest';
import fullUpload from '../fixtures/full-upload.json';
import deltaUpload from '../fixtures/delta-upload.json';

describe('upload contract fixtures', () => {
  it('contains a complete redacted baseline and delta payload', () => {
    expect(fullUpload.snapshot_mode).toBe('full'); expect(fullUpload.part_count).toBeGreaterThanOrEqual(1); expect(fullUpload.shops[0]?.items[0]?.options).toHaveLength(2); expect('source_id' in fullUpload).toBe(false); expect(deltaUpload.snapshot_mode).toBe('delta');
  });
});
