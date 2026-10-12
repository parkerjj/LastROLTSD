import { describe, expect, it } from 'vitest';
import type { SearchFilters } from '@lastroweb/protocol';
import type { MysqlDatabase, MysqlRow } from '../src/db/mysql-client';
import { createMysqlRepository } from '../src/db/mysql-repository';

function recorder() {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const db = {
    async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
      statements.push({ sql, values });
      return [];
    },
  } as unknown as MysqlDatabase;
  return { statements, repo: createMysqlRepository(db) };
}

const basic = { sort: 'price_asc', limit: 20 } satisfies Pick<SearchFilters, 'sort' | 'limit'>;

describe('MySQL item-name search plans', () => {
  it('uses parameterized ngram candidate matching for plain Han phrases', async () => {
    const { statements, repo } = recorder();
    await repo.searchListings({ ...basic, q: '亡者牙齿' });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain('MATCH(name_zh, name, alias_name) AGAINST (? IN BOOLEAN MODE)');
    expect(statements[0]!.sql).toContain('name_zh LIKE ?');
    expect(statements[0]!.sql).toContain('ORDER BY item_id LIMIT 50');
    expect(statements[0]!.values.slice(0, 4)).toEqual(['"亡者牙齿"', '%亡者牙齿%', '%亡者牙齿%', '%亡者牙齿%']);
    expect(statements[0]!.values.at(-1)).toBe(21);
    // The ordinary shop/vendor scopes must still be checked in all-scope searches.
    expect(statements[0]!.sql).toContain('s.title_normalized LIKE ?');
    expect(statements[0]!.sql).toContain('s.vendor_name_normalized');
  });

  it.each(['波', '501', 'Sword', '波利-卡', 'a波利', '波 利'])(
    'preserves the original substring and partial ID match path for %s',
    async (q) => {
      const { statements, repo } = recorder();
      await repo.searchListings({ ...basic, q, q_scope: ['item'] });
      expect(statements[0]!.sql).not.toContain('MATCH(name_zh, name, alias_name)');
      expect(statements[0]!.sql).toContain('CAST(item_id AS CHAR) LIKE ?');
      expect(statements[0]!.values).toContain(`%${q.toLowerCase()}%`);
    },
  );

  it('does not add a catalog MATCH for shop-only queries', async () => {
    const { statements, repo } = recorder();
    await repo.searchListings({ ...basic, q: '亡者牙齿', q_scope: ['shop'] });
    expect(statements[0]!.sql).not.toContain('MATCH(name_zh, name, alias_name)');
    expect(statements[0]!.sql).not.toContain('FROM item_catalog');
    expect(statements[0]!.sql).toContain('s.title_normalized LIKE ?');
  });

  it('binds fulltext input instead of interpolating untrusted text', async () => {
    const { statements, repo } = recorder();
    await repo.searchListings({ ...basic, q: '卡片卡片' });
    expect(statements[0]!.sql).not.toContain('卡片卡片');
    expect(statements[0]!.values[0]).toBe('"卡片卡片"');
  });
});
