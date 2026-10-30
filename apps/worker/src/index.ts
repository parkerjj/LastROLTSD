import { Hono } from 'hono';
import { resolveAppEnv, type AppEnv } from './env';
import { healthPayload } from './routes/health';
import type { MysqlDatabase } from './db/mysql-client';
import { createWorkerDatabase, hasMysqlConnection } from './db/mysql-connection';
import { createMysqlRepository } from './db/mysql-repository';
import { registerUploadRoute, uploadResponse } from './routes/upload';
import { registerSearchRoute, searchResponse } from './routes/search';
import { registerOptionsRoute } from './routes/options';
import { registerHistoryRoute } from './routes/history';
import { registerStatusRoute } from './routes/status';
import { createListingStateService } from './services/state-transition';
import { registerAdminRoutes } from './routes/admin';
import { runRetention } from './services/retention';
import { logError, recordMetric } from './observability';
import { registerAssetRoute } from './routes/assets';
import { withSearchCache } from './middleware/search-cache';
import { registerCorsMiddleware, withCorsHeaders } from './middleware/cors';
import { createGuestbookRepository } from './db/guestbook-repository';
import { registerGuestbookRoutes } from './routes/guestbook';
import { createUploadHandler } from './services/upload-handler';
import { createSnapshotRepository } from './db/snapshot-repository';
import { consumeSnapshotBatch, processSnapshotWakeup, type SnapshotQueueMessage } from './services/snapshot-dispatcher';
import { registerLastroAccountRoute } from './routes/lastro-accounts';
import { registerMakingCookieRoute } from './routes/making-cookie';
import { registerPresenceRoute } from './routes/presence';
import { registerIwaRoutes } from './routes/iwa';
import { registerSponsorRoutes } from './routes/sponsors';
import { authEnvResolutionFailureResponse, registerAuthRoutes } from './auth/router';
import { registerKeRoutes } from './ke/router';
import { registerKeBuildRoutes } from './ke/build-register-router';
import { createActivityRecorder, NOOP_ACTIVITY_RECORDER } from './activity/recorder';
import { createActivityRepository } from './activity/repository';
import { ACTIVITY_RETENTION_MS } from './activity/types';
import { createKeRepository } from './ke/repository';
import { mailRepositoryOptions, resolveAuthConfig } from './auth/config';
import { createAuthRepository } from './auth/repository';
import { createSessionService } from './auth/session-service';
import { assertCsrf } from './auth/csrf';
import type { GuestbookAuthServices } from './routes/guestbook';
import { runAuthJobTick } from './auth/jobs';
import { consumeMailWakeBatch, createMailWake, isMailWakeMessage } from './auth/mail-wake';
import { mysqlErrorContext } from './db/mysql-error-context';
import { createAdminRepository } from './admin/repository';
import { registerAdminAccountRoutes, type AdminAuthServices } from './admin/router';
import { createAdminService } from './admin/service';
import { createTransferRepository } from './admin/transfer-repository';
import { createTransferService } from './admin/transfer-service';
import { createActionService } from './auth/action-service';
import { runCommerceCronTick } from './commerce/jobs';
import { renderCommerceHtml } from './commerce/page';

export type WorkerBindings = AppEnv;
export type WorkerVariables = { requestId: string };

export function createApp(env: AppEnv, injectedDatabase?: MysqlDatabase, context?: Pick<ExecutionContext, 'waitUntil'>): Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }> {
  const app = new Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }>();
  const database = injectedDatabase ?? createWorkerDatabase(env);
  const wakeMail = createMailWake(env.MAIL_QUEUE, context ? (promise) => context.waitUntil(promise) : undefined);
  registerCorsMiddleware(app);
  app.use('*', async (c, next) => {
    const started = Date.now();
    const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    try {
      await next();
    } finally {
      const declaredBytes = Number(c.req.header('content-length') ?? 0);
      recordMetric({ requestId, route: c.req.path, status: c.res.status, elapsedMs: Date.now() - started, ...(Number.isFinite(declaredBytes) && declaredBytes > 0 ? { bodyBytes: declaredBytes } : {}) });
    }
  });

  app.get('/api/health', async (c) => c.json(await healthPayload(env, database), 200, { 'cache-control': 'no-store' }));
  app.get('/ke/buy', async (c) => renderCommerceHtml(c.req.raw, env, database));
  registerAssetRoute(app);
  registerLastroAccountRoute(app);
  registerMakingCookieRoute(app);
  registerPresenceRoute(app);
  registerIwaRoutes(app, env);
  registerSponsorRoutes(app, env);
  const activity = database ? createActivityRecorder(createActivityRepository(database), env.ENVIRONMENT) : NOOP_ACTIVITY_RECORDER;
  registerAuthRoutes(app, env, database, wakeMail ? { now: () => Date.now(), fetch: globalThis.fetch, wakeMail } : undefined, activity);
  registerKeBuildRoutes(app, env, database);
  registerKeRoutes(app, env, database, undefined, activity);

  if (database) {
    const repository = createMysqlRepository(database, env.CURSOR_SECRET);
    const guestbookRepository = createGuestbookRepository(database, env.CURSOR_SECRET ?? '');
    registerGuestbookRoutes(app, guestbookRepository, {
      getItemIds: async () => loadCatalogItemIds(env.ASSETS),
      cursorSecret: env.CURSOR_SECRET ?? '',
      rateSecret: env.GUESTBOOK_RATE_SECRET ?? '',
      auth: guestbookAuthServices(database, env),
      activity,
    });
    registerAdminAccountRoutes(
      app,
      createAdminService(createAdminRepository(database)),
      adminAuthServices(database, env, wakeMail),
      createTransferService(createTransferRepository(database), createActivityRepository(database)),
    );
    registerSearchRoute(app, repository, env.CURSOR_SECRET);
    registerOptionsRoute(app, repository);
    registerHistoryRoute(app, repository, env.CURSOR_SECRET);
    registerStatusRoute(app, repository);
    registerUploadRoute(app, env, repository, createListingStateService(repository), createUploadHandler(database, env));
    registerAdminRoutes(app, env, repository, createSnapshotRepository(database));
  }

  (app as any).get('*', async (c: any) => {
    if (env.ASSETS) return (env.ASSETS as any).fetch(c.req.raw);
    return c.notFound();
  });

  return app;
}

export default {
  async fetch(request: Request, bindings: Record<string, unknown>, context?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
    let env: AppEnv;
    try {
      env = resolveAppEnv(bindings);
    } catch (error) {
      const accountResponse = authEnvResolutionFailureResponse(request);
      if (accountResponse) return accountResponse;
      throw error;
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/v1/market/search' && hasMysqlConnection(env)) {
      return fetchSearch(request, url, env, context);
    }
    // A Worker socket belongs to the invocation that opened it.
    const database = createWorkerDatabase(env);
    try {
      if (request.method === 'POST' && url.pathname === '/api/v1/market/upload' && database) {
        return await fetchUpload(request, env, database);
      }
      return await createApp(env, database, context).fetch(request);
    } finally {
      await database?.close();
    }
  },
  async queue(batch: { messages: readonly SnapshotQueueMessage[] }, bindings: Record<string, unknown>): Promise<void> {
    const env = resolveAppEnv(bindings);
    if (batch.messages.length > 0 && batch.messages.every((message) => isMailWakeMessage(message.body))) {
      await consumeMailWakeBatch(batch.messages, env);
      return;
    }
    const database = createWorkerDatabase(env);
    if (!database) throw new Error('MySQL connection is required for snapshot jobs');
    try {
      await consumeSnapshotBatch(batch.messages, env, createSnapshotRepository(database));
    } finally {
      await database.close();
    }
  },
  async scheduled(event: ScheduledEvent, bindings: Record<string, unknown>): Promise<void> {
    const env = resolveAppEnv(bindings);
    if (event.cron === '*/2 * * * *') {
      await runAuthCronTick(env);
      return;
    }
    // The two-minute trigger was observed registered but never invoked, while this per-minute
    // trigger runs reliably. The account tick rides on it; it is isolated from snapshot work.
    if (event.cron === '* * * * *') {
      try {
        await runAuthCronTick(env);
      } catch {
        // Already logged by runAuthCronTick; the snapshot wakeup below must still run.
      }
      try {
        await runCommerceCronTick(env);
      } catch {
        // Commerce retries are isolated; snapshot work and auth remain independent.
      }
    }
    const database = createWorkerDatabase(env);
    if (!database) return;
    try {
      if (event.cron === '* * * * *') await processSnapshotWakeup(env, createSnapshotRepository(database));
      else if (event.cron === '*/5 * * * *') {
        const now = Date.now();
        try {
          await createSnapshotRepository(database).cleanup(now);
          await createKeRepository(database).cleanup(now);
        } finally {
          // 操作日志的 180 天清理独立执行：前面的清理失败不能让它永远跑不到；它自身失败只记录，不影响任务结果。
          try {
            await createActivityRepository(database).cleanup(now - ACTIVITY_RETENTION_MS, 1000);
          } catch (error) {
            logError('lastroweb.activity_cleanup_failed', error, mysqlErrorContext(error));
          }
        }
      } else await runRetention(Date.now(), {}, createMysqlRepository(database));
    } finally {
      await database.close();
    }
  },
};

/** One account background tick: send at most one ready mail, otherwise one capped cleanup batch. */
async function runAuthCronTick(env: AppEnv): Promise<void> {
  let config;
  try {
    config = resolveAuthConfig(env);
  } catch (error) {
    // Invalid auth settings stop all mail silently otherwise; the error carries only a fixed public message.
    logError('lastroweb.auth_job_config_unavailable', error);
    return;
  }
  if (!config.enabled) return;

  const database = createWorkerDatabase(env)!;
  try {
    const repository = createAuthRepository(database, mailRepositoryOptions(config));
    const tick = await runAuthJobTick(repository, config, { now: () => Date.now(), fetch: globalThis.fetch });
    if (tick.kind === 'idle' && tick.result === 'mail_unconfigured') {
      logError('lastroweb.auth_job_mail_unconfigured', new Error('neither RESEND_API_KEY nor SEND_EMAIL is configured; queued mail is not being sent'));
    } else if (tick.kind === 'mail' && tick.result !== 'sent') {
      logError('lastroweb.auth_job_mail_not_sent', new Error(`mail tick ended ${tick.result}`), { result: tick.result });
    }
  } catch (error) {
    logError('lastroweb.auth_job_failed', error, mysqlErrorContext(error));
    throw new Error('auth background job failed');
  } finally {
    await database.close();
  }
}

// Upload needs no router or unrelated services. The caller owns this invocation's
// database and closes it after receipt, including on every error path.
export async function fetchUpload(request: Request, env: AppEnv, database: MysqlDatabase): Promise<Response> {
  const started = Date.now();
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
  const repository = createMysqlRepository(database, env.CURSOR_SECRET);
  const response = withCorsHeaders(await uploadResponse(request, env, repository, undefined, createUploadHandler(database, env), requestId));
  response.headers.set('x-request-id', requestId);
  const declaredBytes = Number(request.headers.get('content-length') ?? 0);
  recordMetric({ requestId, route: '/api/v1/market/upload', status: response.status, elapsedMs: Date.now() - started,
    ...(Number.isFinite(declaredBytes) && declaredBytes > 0 ? { bodyBytes: declaredBytes } : {}) });
  return response;
}

const itemIdsCache = new WeakMap<object, Promise<ReadonlySet<number>>>();
let catalogItemIdsFallback: Promise<ReadonlySet<number>> | undefined;

/** 留言板写操作需要登录：复用账号系统会话服务；账号服务未配置时写接口降级为 503 */
function guestbookAuthServices(database: MysqlDatabase, env: AppEnv): GuestbookAuthServices | null {
  try {
    const config = resolveAuthConfig(env);
    if (!config.enabled) return null;
    const repository = createAuthRepository(database, mailRepositoryOptions(config));
    const sessions = createSessionService(repository, config, { now: () => Date.now(), fetch: globalThis.fetch });
    return {
      authenticate: (request) => sessions.authenticate(request),
      assertSession: (request, identity) => assertCsrf(request, config, 'session', identity),
    };
  } catch {
    return null;
  }
}

function adminAuthServices(database: MysqlDatabase, env: AppEnv, wakeMail?: () => void): AdminAuthServices | null {
  try {
    const config = resolveAuthConfig(env);
    if (!config.enabled) return null;
    const repository = createAuthRepository(database, mailRepositoryOptions(config));
    const runtime = { now: () => Date.now(), fetch: globalThis.fetch, ...(wakeMail ? { wakeMail } : {}) };
    const sessions = createSessionService(repository, config, runtime);
    const actions = createActionService(repository, config, runtime);
    return {
      authenticate: (request) => sessions.authenticate(request),
      assertSession: (request, identity) => assertCsrf(request, config, 'session', identity),
      setPassword: (actorId, targetUserId, newPassword, requestId) => actions.adminSetPassword(actorId, targetUserId, newPassword, requestId),
    };
  } catch {
    return null;
  }
}

async function loadCatalogItemIds(assets: AppEnv['ASSETS']): Promise<ReadonlySet<number>> {
  if (!assets || typeof assets !== 'object') {
    catalogItemIdsFallback ??= Promise.resolve(new Set<number>());
    return catalogItemIdsFallback;
  }
  let pending = itemIdsCache.get(assets as object);
  if (!pending) {
    pending = Promise.resolve().then(async () => {
      const response = await assets.fetch('https://lastroweb.invalid/catalog/items.json');
      if (!response.ok) throw new Error('catalog asset unavailable');
      const payload = await response.json() as { items?: Array<{ itemId?: unknown }> };
      if (!Array.isArray(payload.items)) throw new Error('catalog asset invalid');
      return new Set(payload.items.map((item) => Number(item.itemId)).filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0));
    }).catch((error) => {
      itemIdsCache.delete(assets as object);
      throw error;
    });
    itemIdsCache.set(assets as object, pending);
  }
  return pending;
}

// The hot search path reuses this handler instead of rebuilding every Hono route.
async function fetchSearch(request: Request, url: URL, env: AppEnv, context?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const started = Date.now();
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
  let response: Response;
  let errorLogged = false;
  try {
    response = await withSearchCache(request, url, env, async () => {
      const database = createWorkerDatabase(env)!;
      try {
        // MySQL validates the cursor before issuing SQL; avoid route-level revalidation.
        // CORS 头必须在进入缓存前写入，否则 HIT 响应不带 access-control-allow-origin。
        return withCorsHeaders(await searchResponse(request, createMysqlRepository(database, env.CURSOR_SECRET), env.CURSOR_SECRET, false));
      } finally {
        await database.close();
      }
    }, context);
  } catch (error) {
    errorLogged = true;
    logError('lastroweb.search_error', error, { request_id: requestId, route: url.pathname });
    response = withCorsHeaders(new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': 'no-store' } }));
  }
  response.headers.set('x-request-id', requestId);
  if (!errorLogged) recordMetric({ requestId, route: url.pathname, status: response.status, elapsedMs: Date.now() - started });
  return response;
}
