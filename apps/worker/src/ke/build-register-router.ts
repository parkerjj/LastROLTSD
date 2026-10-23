import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import type { MysqlDatabase } from '../db/mysql-client';
import { readAuthJson } from '../auth/body';
import { AuthFailure } from '../auth/types';
import { jsonError } from '../middleware/errors';
import { KeFailure } from './types';
import { validateBuildRegistration, verifyGithubBuildPublisher } from './build-publisher';
import { createBuildRegistry } from './build-registry';

export function registerKeBuildRoutes(app: Hono<{ Bindings: AppEnv; Variables: { requestId: string } }>, env: AppEnv,
  database?: MysqlDatabase, verifyPublisher = verifyGithubBuildPublisher): void {
  app.post('/api/v1/ke/builds/register', async c => {
    c.header('cache-control', 'no-store');
    try {
      const authorization = c.req.header('authorization') ?? '';
      const match = /^Bearer ([A-Za-z0-9_.-]+)$/u.exec(authorization);
      if (!match || authorization.length > 17 * 1024) throw new KeFailure('KE_BUILD_PUBLISHER_UNAUTHORIZED', 401, '构建登记身份无效');
      const input = validateBuildRegistration(await readAuthJson(c.req.raw, 8192));
      const publisher = await verifyPublisher(match[1]!, input);
      if (!database || env.AUTH_ENABLED !== 'true' || env.ENVIRONMENT !== 'production') throw new KeFailure('KE_UNAVAILABLE', 503, '构建登记服务暂不可用');
      const keyVersion = Number(env.KE_CORE_KEY_VERSION ?? '1');
      if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new KeFailure('KE_UNAVAILABLE', 503, '构建登记服务暂不可用');
      if (input.core_key_version !== keyVersion) throw new KeFailure('KE_BUILD_KEY_VERSION_MISMATCH', 409, '构建密钥版本与授权服务器不一致');
      const result = await createBuildRegistry(database).register(input, publisher, Date.now());
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof AuthFailure) return jsonError('KE_BAD_REQUEST', error.publicMessage, error.status, c.get('requestId'));
      if (error instanceof KeFailure) return jsonError(error.code, error.publicMessage, error.status, c.get('requestId'));
      // 不记录请求体、Bearer 或底层SQL；客户端只得到稳定错误码。
      return jsonError('KE_UNAVAILABLE', '构建登记服务暂不可用', 503, c.get('requestId'));
    }
  });
}
