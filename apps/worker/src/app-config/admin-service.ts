import { insertAdminAudit } from '../admin/audit';
import { AdminFailure } from '../admin/types';
import type { MysqlDatabase } from '../db/mysql-client';
import { APP_FLAG_KEYS, readAppFlag, writeAppFlag } from './repository';

export interface AppFlagsAdmin {
  list(): Promise<Array<{ key: string; enabled: boolean }>>;
  set(actorId: number, key: string, enabled: boolean, requestId: string): Promise<{ key: string; enabled: boolean }>;
}

/** 管理员后台的 app 开关：写开关与审计在同一个事务里提交。 */
export function createAppFlagsAdmin(db: MysqlDatabase, now: () => number = () => Date.now()): AppFlagsAdmin {
  return {
    async list() {
      return Promise.all(APP_FLAG_KEYS.map(async (key) => ({ key, enabled: await readAppFlag(db, key) })));
    },

    async set(actorId, key, enabled, requestId) {
      if (!APP_FLAG_KEYS.includes(key)) throw new AdminFailure('ADMIN_NOT_FOUND', 404, 'Not found');
      const at = now();
      await db.transaction(async (tx) => {
        const from = await readAppFlag(tx, key);
        await writeAppFlag(tx, key, enabled, at);
        await insertAdminAudit(tx, {
          actor_user_id: actorId, action: 'app_flag_set', target_user_id: null,
          detail: { key, from, to: enabled }, request_id: requestId, created_at: at,
        });
      });
      return { key, enabled };
    },
  };
}
