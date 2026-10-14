import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL('../../../migrations/mysql/009_account_system.sql', import.meta.url);
const ddl = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

function tableDdl(name: string): string {
  const match = new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\) ENGINE=InnoDB[^;]*;`, 'u').exec(ddl);
  return match?.[0] ?? '';
}

describe('account schema migration', () => {
  it('adds eight InnoDB tables with the account ID, email, FK, and avatar constraints', () => {
    const tables = Array.from(ddl.matchAll(/CREATE TABLE ([a-z_]+)/gu), (match) => match[1]).sort();
    expect(tables).toEqual([
      'auth_action_tokens',
      'auth_avatars',
      'auth_credentials',
      'auth_mail_outbox',
      'auth_rate_limits',
      'auth_security_events',
      'auth_sessions',
      'auth_users',
    ]);
    expect(ddl.match(/ENGINE=InnoDB/gu)).toHaveLength(8);
    expect(tableDdl('auth_users')).toMatch(/AUTO_INCREMENT=10000/u);
    expect(tableDdl('auth_users')).toMatch(/UNIQUE KEY [^(]+\(email_normalized\)/u);
    expect(ddl).toMatch(/FOREIGN KEY \(user_id\) REFERENCES auth_users \(id\)/u);
    expect(tableDdl('auth_avatars')).toMatch(/avatar_base64 TEXT CHARACTER SET ascii COLLATE ascii_bin/u);
    expect(tableDdl('auth_avatars')).toMatch(/CHAR_LENGTH\(avatar_base64\) <= 43692/u);
  });
});
