import type { MysqlDatabase } from '../../db/mysql-client';
import type { AppEnv } from '../../env';
import { resolveAuthConfig } from '../../auth/config';
import { logError } from '../../observability';
import { resolveKeConfig } from '../config';
import { createHostedRepository } from './repository';
import { createHostedService } from './service';
import { createDeathRepository } from '../death/repository';

/**
 * 每 5 分钟：agent 故障转移（带熔断）、资格扫描、队列兜底调度、过期记录清理。
 * 失败只记录，不影响同一次 Cron 里的其他任务；所有步骤都是幂等的（Cron 可能重复或延迟执行）。
 */
export async function runHostedTick(env: AppEnv, database: MysqlDatabase, now: () => number = () => Date.now()): Promise<void> {
  try {
    const authConfig = resolveAuthConfig(env);
    if (!authConfig.enabled) return;
    const keConfig = resolveKeConfig(env, authConfig);
    if (keConfig.hostedCredentialKey === null) return; // 托管未配置：整体不运行
    const service = createHostedService(createHostedRepository(database), keConfig, now, (event, detail) => {
      console.log(JSON.stringify({ event, ...detail }));
    });
    // 死亡报告：每角色最近 100 条且不超过 90 天；失败不影响托管对账。
    await createDeathRepository(database).prune(now()).catch((error: unknown) => logError('lastroweb.death_prune_failed', error, {}));
    const summary = await service.tick();
    if (summary.failedOver.length > 0 || summary.frozen !== 'none' || summary.enforced > 0 || summary.scheduled > 0) {
      console.log(JSON.stringify({ event: 'hosted.tick', ...summary }));
    }
  } catch (error) {
    logError('lastroweb.hosted_tick_failed', error, {});
  }
}
