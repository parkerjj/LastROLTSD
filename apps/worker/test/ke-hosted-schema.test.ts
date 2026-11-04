import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ddl = readFileSync(new URL('../../../migrations/mysql/028_ke_hosted.sql', import.meta.url), 'utf8');

describe('迁移 028：托管（离线挂机）', () => {
  it('不会出现“逗号被写进 -- 注释里”这类让建表语句失效的写法', () => {
    // 行内 `-- 注释` 之后不能再有逗号（逗号属于注释，下一列会变成语法错误）。
    for (const line of ddl.split('\n')) {
      const comment = line.indexOf('--');
      if (comment > 0) expect(line.slice(comment), line).not.toMatch(/,\s*$/u);
    }
  });

  it('建表：agent、nonce、凭据、托管实例、托管 token、状态快照', () => {
    for (const table of ['ke_agents', 'ke_agent_nonces', 'ke_hosted_credentials', 'ke_hosted_instances', 'ke_hosted_tokens', 'ke_instance_status']) {
      expect(ddl).toMatch(new RegExp(`CREATE TABLE ${table} \\(`, 'u'));
    }
    // 括号必须平衡（粗略检查整份文件）。
    expect((ddl.match(/\(/gu) ?? []).length).toBe((ddl.match(/\)/gu) ?? []).length);
  });

  it('同一角色同时只有一个运行中的托管记录：用可空唯一键保证，无竞态', () => {
    expect(ddl).toMatch(/active_char_key VARCHAR\(40\)[^,]*NULL/u);
    expect(ddl).toMatch(/UNIQUE KEY uq_ke_hosted_active_char \(active_char_key\)/u);
    expect(ddl).toMatch(/UNIQUE KEY uq_ke_hosted_credentials_char \(user_id, nid, aid, cid\)/u);
  });

  it('托管 token 记录签发时的账号版本，改密码后失效；关联实例删除时级联', () => {
    expect(ddl).toMatch(/credential_version INT UNSIGNED NOT NULL/u);
    expect(ddl).toMatch(/auth_version INT UNSIGNED NOT NULL/u);
    expect(ddl).toMatch(/FOREIGN KEY \(instance_id\) REFERENCES ke_hosted_instances \(instance_id\) ON DELETE CASCADE/u);
  });

  it('既有 manual 行迁移为 auto，并新增被踢原因列', () => {
    expect(ddl).toMatch(/UPDATE ke_instances SET mode = 'auto' WHERE mode <> 'auto'/u);
    expect(ddl).toMatch(/ADD COLUMN kick_reason/u);
  });

  it('外键两端字符集一致（ascii_bin），否则 MySQL 建外键会失败', () => {
    const idColumns = ddl.match(/(?:instance_id|agent_id|assigned_agent)\s+CHAR\((?:36|28)\)[^,\n]*/gu) ?? [];
    expect(idColumns.length).toBeGreaterThan(5);
    for (const column of idColumns) expect(column, column).toMatch(/CHARACTER SET ascii COLLATE ascii_bin/u);
  });
});
