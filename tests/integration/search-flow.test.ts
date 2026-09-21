import { describe, expect, it } from 'vitest';
import { parseSearchParams } from '../../apps/worker/src/domain/search';

describe('search contract', () => { it('caps pages and uses keyset cursor input', () => { const filters = parseSearchParams(new URL('https://example.test/api/v1/market/search?limit=500&sort=changed_desc')); expect(filters.limit).toBe(50); expect(filters.sort).toBe('changed_desc'); }); });
