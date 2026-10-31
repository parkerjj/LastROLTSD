import { getCommerceCatalog } from '@lastroweb/commerce';
import { createAuthRepository } from '../auth/repository';
import { mailRepositoryOptions, resolveAuthConfig } from '../auth/config';
import { AuthFailure } from '../auth/types';
import { createSessionService } from '../auth/session-service';
import { DEFAULT_COMMERCE_PRICING_VERSION, resolveCommerceConfig, type AppEnv } from '../env';
import type { MysqlDatabase } from '../db/mysql-client';
import { createQuoteRepository } from './quote-repository';

const COMMERCE_BOOTSTRAP_MARKER = '<!--commerce-bootstrap-->';

export interface CommerceBootstrap {
  version: 1;
  catalog: ReturnType<typeof getCommerceCatalog>;
  session: Awaited<ReturnType<ReturnType<typeof createSessionService>['me']>> | null;
  account: {
    units: Array<{
      unitId: string;
      entitlementId: string | null;
      resource: string;
      kind: 'commerce' | 'legacy';
      quantity: number;
      startsAt: string;
      expiresAt: string;
      source: string | null;
      sourceRef: string | null;
      isGift: boolean;
    }>;
    entitlements: Array<{
      id: string;
      unitId: string | null;
      resource: string;
      quantity: number;
      startsAt: string;
      expiresAt: string;
      source: string;
      sourceRef: string | null;
      isGift: boolean;
    }>;
    effective: { slots: number; modules: string[] };
  };
}

class CommercePageUnavailable extends Error {}

function emptyAccount(): CommerceBootstrap['account'] {
  return { units: [], entitlements: [], effective: { slots: 0, modules: [] } };
}

function isPermanentGift(resource: string, source: string, sourceRef: string | null): boolean {
  return (resource === 'slots' && source === 'signup' && sourceRef === 'email-verified:slots')
    || (resource === 'module:core' && source === 'signup' && sourceRef === 'email-verified:module:core')
    || (resource === 'module:standalone' && source === 'signup' && sourceRef === 'email-verified:module:standalone');
}

function accountSnapshot(account: Awaited<ReturnType<ReturnType<typeof createQuoteRepository>['readAccount']>>): CommerceBootstrap['account'] {
  const entitlementByUnit = new Map(account.entitlements.flatMap((entitlement) => entitlement.unitId
    ? [[entitlement.unitId, entitlement] as const]
    : []));
  return {
    units: account.slotUnits.map((unit) => {
      const entitlement = unit.keEntitlementId ? entitlementByUnit.get(unit.unitId) : undefined;
      const source = entitlement ? entitlement.source : unit.baselineSource;
      const sourceRef = entitlement ? entitlement.sourceRef : unit.baselineSourceRef;
      return {
        unitId: unit.unitId,
        entitlementId: unit.keEntitlementId,
        resource: unit.resource,
        kind: unit.unitKind,
        quantity: unit.currentQuantity,
        startsAt: unit.currentStartsAt.toString(),
        expiresAt: unit.currentExpiresAt.toString(),
        source,
        sourceRef,
        isGift: isPermanentGift(unit.resource, source, sourceRef),
      };
    }),
    entitlements: account.entitlements.map((entitlement) => ({
      id: entitlement.id,
      unitId: entitlement.unitId,
      resource: entitlement.resource,
      quantity: entitlement.quantity,
      startsAt: entitlement.startsAt.toString(),
      expiresAt: entitlement.expiresAt.toString(),
      source: entitlement.source,
      sourceRef: entitlement.sourceRef,
      isGift: isPermanentGift(entitlement.resource, entitlement.source, entitlement.sourceRef),
    })),
    effective: { slots: account.effective.slots, modules: [...account.effective.modules].sort() },
  };
}

export async function buildCommerceBootstrap(
  request: Request,
  env: AppEnv,
  database: MysqlDatabase | undefined,
): Promise<CommerceBootstrap> {
  let authConfig;
  try {
    authConfig = resolveAuthConfig(env);
  } catch {
    throw new CommercePageUnavailable();
  }

  let session: CommerceBootstrap['session'] = null;
  let account = emptyAccount();
  if (authConfig.enabled) {
    if (!database) throw new CommercePageUnavailable();
    const repository = createAuthRepository(database, mailRepositoryOptions(authConfig));
    const sessions = createSessionService(repository, authConfig, { now: () => Date.now(), fetch: globalThis.fetch });
    try {
      const identity = await sessions.authenticate(request);
      session = await sessions.me(identity);
      const current = await createQuoteRepository(database).readAccount(session.user.id, Date.now());
      account = accountSnapshot(current);
    } catch (error) {
      if (!(error instanceof AuthFailure) || error.status !== 401) throw new CommercePageUnavailable();
    }
  }

  return {
    version: 1,
    catalog: getCommerceCatalog(resolveCommerceConfig(env)?.pricingVersion ?? DEFAULT_COMMERCE_PRICING_VERSION),
    session,
    account,
  };
}

function serializeHtmlJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case '<': return '\\u003c';
      case '>': return '\\u003e';
      case '&': return '\\u0026';
      case '\u2028': return '\\u2028';
      default: return '\\u2029';
    }
  });
}

function unavailableResponse(): Response {
  return new Response('购买页面暂时不可用', {
    status: 503,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'text/plain; charset=UTF-8',
    },
  });
}

export async function renderCommerceHtml(
  request: Request,
  env: AppEnv,
  database: MysqlDatabase | undefined,
): Promise<Response> {
  if (!env.ASSETS) return unavailableResponse();
  try {
    const assetUrl = new URL('/index.html', request.url);
    const assetResponse = await env.ASSETS.fetch(new Request(assetUrl));
    if (!assetResponse.ok) return unavailableResponse();
    const html = await assetResponse.text();
    const markerAt = html.indexOf(COMMERCE_BOOTSTRAP_MARKER);
    if (markerAt < 0 || html.indexOf(COMMERCE_BOOTSTRAP_MARKER, markerAt + COMMERCE_BOOTSTRAP_MARKER.length) >= 0) {
      return unavailableResponse();
    }
    const bootstrap = await buildCommerceBootstrap(request, env, database);
    const script = `<script type="application/json" id="commerce-bootstrap">${serializeHtmlJson(bootstrap)}</script>`;
    const response = new Response(html.replace(COMMERCE_BOOTSTRAP_MARKER, script), {
      status: 200,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': 'text/html; charset=UTF-8',
        vary: 'Cookie',
      },
    });
    return response;
  } catch {
    return unavailableResponse();
  }
}
