import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ddl = readFileSync(new URL('../../../migrations/mysql/022_account_activity_log.sql', import.meta.url), 'utf8');

describe('account_activity_log 迁移 022', () => {
  it('建表与索引', () => {
    expect(ddl).toMatch(/CREATE TABLE account_activity_log \(/u);
    for (const column of ['user_id', 'event', 'result', 'ip', 'ip_net', 'country', 'region', 'city', 'latitude', 'longitude',
      'asn', 'as_org', 'is_hosting', 'device_id', 'fingerprint', 'user_agent', 'aid', 'cid', 'nid', 'ref', 'source', 'request_id', 'created_at']) {
      expect(ddl).toContain(column);
    }
    for (const index of ['(user_id, created_at)', '(ip_net, user_id)', '(device_id, user_id)', '(fingerprint, user_id)', '(aid)', '(ref, created_at)', '(created_at)']) {
      expect(ddl).toContain(index);
    }
    expect(ddl).toMatch(/FOREIGN KEY \(user_id\) REFERENCES auth_users \(id\) ON DELETE CASCADE/u);
    expect(ddl).toMatch(/CHECK \(result IN \('SUCCESS', 'FAILURE'\)\)/u);
    expect(ddl).toMatch(/CHECK \(source IN \('live', 'backfill'\)\)/u);
  });
});
