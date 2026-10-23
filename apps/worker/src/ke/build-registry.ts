import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import type { BuildRegistration } from './build-publisher';
import { sha256 } from './crypto';
import { KeFailure } from './types';

export interface BuildPublisher {
  runId: string;
  runAttempt: string;
  jti: string;
}

export interface BuildRegistrationResult extends BuildRegistration {
  registered: true;
  registry_enforced: true;
}

const conflict = () => new KeFailure('KE_BUILD_REGISTRATION_CONFLICT', 409, '构建登记冲突或已被撤销');
const unavailable = () => new KeFailure('KE_UNAVAILABLE', 503, '构建登记服务暂不可用');
const fields = ['build_id', 'core_sha256', 'commit_sha', 'package_id', 'engine_version', 'release_tag', 'core_key_version'] as const;

export function createBuildRegistry(database: MysqlDatabase) {
  return {
    async isEnforced(): Promise<boolean> {
      const policy = await database.first('SELECT enforced FROM ke_build_policy WHERE id = 1');
      if (!policy || ![0, 1].includes(Number(policy.enforced))) throw unavailable();
      return Number(policy.enforced) === 1;
    },

    async register(input: BuildRegistration, publisher: BuildPublisher, now: number): Promise<BuildRegistrationResult> {
      const jtiHash = [...await sha256(new TextEncoder().encode(publisher.jti))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return database.transaction(async db => {
        // 同一事务锁串行化登记与首次启用，避免并发覆盖以及撤销记录被重新激活。
        const policy = await db.first('SELECT enforced FROM ke_build_policy WHERE id = 1 FOR UPDATE');
        if (!policy || ![0, 1].includes(Number(policy.enforced))) throw unavailable();
        const existing = await db.first('SELECT * FROM ke_builds WHERE build_id = ?', [input.build_id]);
        if (existing) {
          if (existing.status !== 'ACTIVE' || fields.some(key => String(existing[key]) !== String(input[key]))
            || existing.publisher_run_id !== publisher.runId || existing.publisher_run_attempt !== publisher.runAttempt) throw conflict();
        } else {
          const previousRun = await db.first('SELECT build_id FROM ke_builds WHERE publisher_run_id = ? AND publisher_run_attempt = ?', [publisher.runId, publisher.runAttempt]);
          if (previousRun) throw conflict();
          await db.run(`INSERT INTO ke_builds
            (build_id, core_sha256, commit_sha, package_id, engine_version, release_tag, core_key_version,
             publisher_run_id, publisher_run_attempt, publisher_jti_sha256, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
          [input.build_id, input.core_sha256, input.commit_sha, input.package_id, input.engine_version, input.release_tag,
            input.core_key_version, publisher.runId, publisher.runAttempt, jtiHash, now]);
        }
        await db.run('UPDATE ke_build_policy SET enforced = 1, enabled_at = COALESCE(enabled_at, ?) WHERE id = 1', [now]);
        return { registered: true, registry_enforced: true, ...input };
      });
    },

    /** false 仅表示显式首次上线bootstrap；true表示已按数据库白名单验证。SQL异常不会返回false。 */
    async assertAllowed(buildId: string | null, buildHash: string | null): Promise<boolean> {
      const row = await database.first<MysqlRow>(`SELECT p.enforced, b.core_sha256, b.status
        FROM ke_build_policy p LEFT JOIN ke_builds b ON b.build_id = ? WHERE p.id = 1`, [buildId]);
      if (!row || ![0, 1].includes(Number(row.enforced))) throw unavailable();
      if (Number(row.enforced) === 0) return false;
      if (!buildId || !buildHash || row.status !== 'ACTIVE' || row.core_sha256 !== buildHash.toLowerCase()) {
        throw new KeFailure('KE_BUILD_REJECTED', 403, '构建未登记、指纹不匹配或已被撤销');
      }
      return true;
    },
  };
}
