import { describe, expect, it } from 'vitest';
import { hashApiKey, requireSource } from '../src/middleware/auth';

describe('source authentication', () => {
  it('hashes bearer tokens and never reads source id from JSON', async () => {
    const hash = await hashApiKey('local-secret');
    const repo = { findSourceByApiKeyHash: async (value: string) => value === hash ? { id: 'source-a', name: 'A', apiKeyHash: hash, status: 'active' as const } : null } as never;
    const source = await requireSource(new Request('https://example.test', { headers: { authorization: 'Bearer local-secret' } }), repo);
    expect(source.id).toBe('source-a');
  });
  it('rejects missing and disabled sources', async () => {
    const repo = { findSourceByApiKeyHash: async () => ({ id: 'source-a', name: 'A', apiKeyHash: 'x', status: 'disabled' as const }) } as never;
    await expect(requireSource(new Request('https://example.test'), repo)).rejects.toMatchObject({ status: 401 });
    await expect(requireSource(new Request('https://example.test', { headers: { authorization: 'Bearer x' } }), repo)).rejects.toMatchObject({ status: 403 });
  });
});
