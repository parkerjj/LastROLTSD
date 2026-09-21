import type { MarketRepository } from '../db/repository';
import type { SourceRow } from '../db/types';

export interface AuthenticatedSource extends SourceRow { tokenHash: string; }
export interface AuthErrorDetails extends Record<string, unknown> { expected?: string; actual?: string; tokenHashPrefix?: string; storedHashPrefix?: string; sourceId?: string; }
export class AuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string, public readonly details: AuthErrorDetails = {}) { super(message); this.name = 'AuthError'; }
}

export async function hashApiKey(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function requireSource(request: Request, repo: MarketRepository): Promise<AuthenticatedSource> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([^\s]+)$/iu.exec(header);
  if (!match) throw new AuthError(401, 'Bearer token required', { expected: 'Authorization: Bearer <api-key>', actual: header ? 'malformed authorization header' : 'missing authorization header' });
  const tokenHash = await hashApiKey(match[1]!);
  const source = await repo.findSourceByApiKeyHash(tokenHash);
  if (!source) throw new AuthError(401, 'Invalid bearer token', { expected: 'an active source with a matching SHA-256 API key hash', actual: 'no matching source', tokenHashPrefix: tokenHash.slice(0, 16) });
  if (source.status !== 'active') throw new AuthError(403, 'Source is disabled', { expected: 'active', actual: source.status, tokenHashPrefix: tokenHash.slice(0, 16), storedHashPrefix: source.apiKeyHash.slice(0, 16), sourceId: source.id });
  return { ...source, tokenHash };
}
