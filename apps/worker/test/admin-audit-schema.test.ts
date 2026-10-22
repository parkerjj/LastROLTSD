import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ddl = readFileSync(new URL('../../../migrations/mysql/018_admin_audit_log.sql', import.meta.url), 'utf8');

describe('admin_audit_log 迁移 018', () => {
  it('建表：操作者 / 动作 / 目标账号 / JSON 详情 / 请求号 / 时间，按时间与目标账号可查', () => {
    expect(ddl).toMatch(/CREATE TABLE admin_audit_log \(/u);
    for (const column of ['actor_user_id', 'action', 'target_user_id', 'detail JSON', 'request_id', 'created_at']) {
      expect(ddl).toContain(column);
    }
    expect(ddl).toMatch(/INDEX [^(]+\(created_at, id\)/u);
    expect(ddl).toMatch(/INDEX [^(]+\(target_user_id, id\)/u);
  });

  it('操作者与目标账号被删除后审计记录仍保留（外键置空，不级联删除）', () => {
    expect(ddl).toMatch(/FOREIGN KEY \(actor_user_id\) REFERENCES auth_users \(id\) ON DELETE SET NULL/u);
    expect(ddl).toMatch(/FOREIGN KEY \(target_user_id\) REFERENCES auth_users \(id\) ON DELETE SET NULL/u);
  });
});
