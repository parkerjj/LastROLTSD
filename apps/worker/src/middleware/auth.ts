import type { MarketRepository } from '../db/repository';
import type { SourceRow } from '../db/types';

export interface AuthenticatedSource extends SourceRow { tokenHash: string; }
export class AuthError extends Error { constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError'; } }

export async function hashApiKey(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function requireSource(request: Request, repo: MarketRepository): Promise<AuthenticatedSource> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([^\s]+)$/iu.exec(header);
  if (!match) throw new AuthError(401, 'Bearer token required');
  const tokenHash = await hashApiKey(match[1]!);
  const source = await repo.findSourceByApiKeyHash(tokenHash);
  if (!source) throw new AuthError(401, 'Invalid bearer token');
  if (source.status !== 'active') throw new AuthError(403, 'Source is disabled');
  return { ...source, tokenHash };
}
