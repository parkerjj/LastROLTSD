import type { MysqlDatabase } from '../db/mysql-client';

/** 目前唯一的开关：是否允许 iOS 客户端显示 KoreEngine 挂机界面。 */
export const APP_FLAG_IOS_ENGINE = 'ios_engine';
export const APP_FLAG_KEYS: readonly string[] = [APP_FLAG_IOS_ENGINE];

/** 读开关；行不存在（迁移未播种）按关闭处理。 */
export async function readAppFlag(db: Pick<MysqlDatabase, 'first'>, key: string): Promise<boolean> {
  const row = await db.first<{ enabled: unknown }>('SELECT enabled FROM app_flags WHERE flag_key = ?', [key]);
  return row ? Number(row.enabled) === 1 : false;
}

export async function writeAppFlag(db: Pick<MysqlDatabase, 'run'>, key: string, enabled: boolean, now: number): Promise<void> {
  await db.run(
    'INSERT INTO app_flags (flag_key, enabled, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = VALUES(updated_at)',
    [key, enabled ? 1 : 0, now],
  );
}
