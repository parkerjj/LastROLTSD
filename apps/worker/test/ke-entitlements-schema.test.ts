import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KE_PERMANENT_MS } from '../src/ke/entitlements';

const ddl = readFileSync(new URL('../../../migrations/mysql/017_ke_entitlements.sql', import.meta.url), 'utf8');

describe('ke_entitlements 迁移 017', () => {
  it('建表：流水列、幂等唯一键、按用户 + 资源的查询索引、数量非零与时间窗口约束', () => {
    expect(ddl).toMatch(/CREATE TABLE ke_entitlements \(/u);
    for (const column of ['user_id', 'resource', 'quantity', 'starts_at', 'expires_at', 'source', 'source_ref', 'actor_user_id', 'note', 'revoked_at', 'created_at']) {
      expect(ddl).toMatch(new RegExp(`\\b${column}\\b`, 'u'));
    }
    expect(ddl).toMatch(/UNIQUE KEY [^(]+\(user_id, source, source_ref\)/u);
    expect(ddl).toMatch(/INDEX [^(]+\(user_id, resource, expires_at\)/u);
    expect(ddl).toMatch(/CHECK \(quantity <> 0\)/u);
    expect(ddl).toMatch(/CHECK \(expires_at > starts_at\)/u);
    expect(ddl).toMatch(/FOREIGN KEY \(user_id\) REFERENCES auth_users \(id\)/u);
  });

  it('回填：已验证邮箱的存量用户各得一条 99 年的 slots 与 module:core，且可重复执行', () => {
    expect(ddl).toMatch(/INSERT INTO ke_entitlements/u);
    expect(ddl).toMatch(/email_verified_at IS NOT NULL/u);
    expect(ddl).toMatch(/email-verified:slots/u);
    expect(ddl).toMatch(/email-verified:module:core/u);
    expect(ddl).toContain(String(KE_PERMANENT_MS));
    expect(ddl).toMatch(/ON DUPLICATE KEY UPDATE/u);
  });
});
