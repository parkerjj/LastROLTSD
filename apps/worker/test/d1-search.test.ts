import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';
import { parseSearchParams } from '../src/domain/search';

class LocalStatement {
  values: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.values) as T[] }; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}

class LocalD1 {
  readonly statements: LocalStatement[] = [];
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string) { const statement = new LocalStatement(this.database, sql); this.statements.push(statement); return statement; }
  async batch(statements: LocalStatement[]) {
    this.database.exec('BEGIN');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.database.exec('COMMIT');
      return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}

function fixture() {
  const database = new DatabaseSync(':memory:');
  for (const name of readdirSync(resolve(process.cwd(), 'migrations')).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
  }
  database.exec(`
    INSERT INTO market_sources(id,name,api_key_hash,created_at) VALUES ('s','Synthetic','hash',0);
    INSERT INTO vendors(id,source_id,vendor_key,name,name_normalized,updated_at) VALUES
      (1,'s','vendor-a','一般卖家','一般卖家',0),(2,'s','vendor-b','波利商人','波利商人',0),(3,'s','vendor-c','已关店卖家','已关店卖家',0);
    INSERT INTO shops(id,source_id,vendor_id,shop_key,title,title_normalized,shop_type,status,last_seen_at,updated_at,shop_id) VALUES
      (1,'s',1,'shop-a','普通商店','普通商店','sell','active',0,0,'shop-v1-a'),
      (2,'s',2,'shop-b','普通商店','普通商店','sell','active',0,0,'shop-v1-b'),
      (3,'s',1,'shop-c','波利专卖','波利专卖','sell','active',0,0,'shop-v1-c'),
      (4,'s',3,'shop-d','已关商店','已关商店','sell','closed',0,0,'shop-v1-d');
    INSERT INTO shop_sessions(id,shop_id,client_run_id,started_at,last_seen_at,ended_at) VALUES
      (1,1,'run',0,0,NULL),(2,2,'run',0,0,NULL),(3,3,'run',0,0,NULL),(4,4,'run',0,0,1);
    INSERT INTO item_catalog(item_id,canonical_name_zh,name_normalized,description,data_version,updated_at) VALUES
      (100,'波利卡片','波利卡片','','v1',0),(101,'波利帽','波利帽','','v1',0),(102,'普通卡片','普通卡片','','v1',0);
    INSERT INTO item_aliases(item_id,alias,alias_normalized,alias_kind,data_version,updated_at) VALUES
      (102,'波利纪念品','波利纪念品','approved','v1',0);
    INSERT INTO catalog_versions(version,checksum,imported_at,item_count,alias_count,importer_version,output_checksum)
      VALUES ('v1','c',0,3,1,'test','c');
    INSERT INTO catalog_state(id,current_version,updated_at) VALUES (1,'v1',0);
    INSERT INTO listings(id,shop_session_id,item_fingerprint,item_id,item_name_legacy,item_name_normalized_legacy,price,quantity,last_quantity,first_seen_at,last_seen_at,last_changed_at) VALUES
      (1,1,'a',100,'伪造名字','伪造名字',10,1,1,0,0,0),
      (2,1,'b',101,'伪造名字','伪造名字',20,1,1,0,0,0),
      (3,1,'c',102,'伪造名字','伪造名字',30,1,1,0,0,0),
      (4,2,'d',999,'伪造名字','伪造名字',40,1,1,0,0,0),
      (5,3,'e',999,'伪造名字','伪造名字',50,1,1,0,0,0),
      (6,4,'f',100,'伪造名字','伪造名字',60,1,1,0,0,0);
    INSERT INTO listing_options(listing_id,option_index,option_type,option_value,option_param) VALUES
      (1,0,12,49,0),(2,0,12,50,0),(3,0,12,51,0),(3,1,12,80,0),(3,2,198,150,7),(4,0,999,7,3);
    INSERT INTO option_definitions(data_version,option_type,handle,label_zh,description_template,value_type,unit,scale,allowed_operators_json,param_policy_json,repeat_policy,display_template,search_tokens_json,updated_at)
      VALUES ('options-lastro-70.83',198,'test_rate','倍率','倍率 {value}','scaled_integer','%',100,'["eq","gte"]','{"mode":"required_exact","filterable":true,"value":7}','same','倍率 {value}','[]',0);
    INSERT INTO item_search_fts(rowid,item_id,text) VALUES
      (100,100,'波利卡片'),(101,101,'波利帽'),(102,102,'普通卡片 波利纪念品');
    INSERT INTO shop_search_fts(rowid,shop_id,text) VALUES
      (1,1,'普通商店 一般卖家'),(2,2,'普通商店 波利商人'),(3,3,'波利专卖 一般卖家'),(4,4,'已关商店 已关店卖家');
    INSERT INTO search_short_tokens(scope_type,scope_id,token) VALUES
      ('item',100,'波'),('item',100,'波利'),('item',101,'波'),('item',101,'波利'),('item',102,'波'),('item',102,'波利'),
      ('shop',2,'波'),('shop',2,'波利'),('shop',3,'波'),('shop',3,'波利');
  `);
  const d1 = new LocalD1(database);
  const repo = createD1Repository(d1 as never);
  return { database, d1, repo };
}

async function search(repo: ReturnType<typeof createD1Repository>, query: string) {
  const filters = parseSearchParams(new URL(`https://x.test/api/v1/market/search?${query}`), { verifyCursor: false });
  return repo.searchListings(filters);
}

describe('local D1 catalog and option search', () => {
  it('unions all catalog item IDs for 波利 without reading uploaded listing names', async () => {
    const { database, repo, d1 } = fixture();
    try {
      const page = await search(repo, 'q=波利');
      expect(page.items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
      expect((await search(repo, 'q=波')).items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
      expect((await search(repo, 'q=伪造名字')).items).toEqual([]);
      const statement = d1.statements.find((entry) => entry.sql.includes('FROM listings l'))!;
      expect(statement.sql).toContain('search_short_tokens');
      expect(statement.sql).not.toContain('l.item_name');
      expect(statement.sql).not.toContain('item_id IN (');
      expect(statement.values).toContain('波利');
      expect(page.items.find((item) => item.id === 2)?.options[0]?.display).toBe('SP恢复速度增加50%');
      expect(page.items.find((item) => item.id === 4)?.options[0]?.display).toBe('未知词条 type=999 value=7 param=3');
      expect(page.items.find((item) => item.id === 4)).toMatchObject({ itemName: '未知物品 #999', shopId: 'shop-v1-b', shopStatus: 'active' });
    } finally { database.close(); }
  });

  it('never returns closed shops, including when stale listings are requested', async () => {
    const { database, repo } = fixture();
    try {
      expect((await search(repo, 'include_stale=true')).items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    } finally { database.close(); }
  });

  it('tracks catalog rename and alias changes through the derived indexes', async () => {
    const { database, repo } = fixture();
    try {
      expect((await search(repo, 'q=波利帽')).items.map((item) => item.id)).toEqual([2]);
      expect((await search(repo, 'q=波利商人')).items.map((item) => item.id)).toEqual([4]);
      expect((await search(repo, 'q=波利专卖')).items.map((item) => item.id)).toEqual([5]);
      database.exec("UPDATE item_catalog SET canonical_name_zh='新帽',name_normalized='新帽' WHERE item_id=101; DELETE FROM search_short_tokens WHERE scope_type='item' AND scope_id=101; DELETE FROM item_search_fts WHERE rowid=101; INSERT INTO item_search_fts(rowid,item_id,text) VALUES (101,101,'新帽'); INSERT INTO search_short_tokens(scope_type,scope_id,token) VALUES ('item',101,'新帽');");
      expect((await search(repo, 'q=波利帽')).items).toEqual([]);
      expect((await search(repo, 'q=新帽')).items[0]?.itemName).toBe('新帽');
      expect((await search(repo, 'q=波利纪')).items.map((item) => item.id)).toEqual([3]);
    } finally { database.close(); }
  });

  it('joins FTS matches through the indexed item ID instead of the virtual-table rowid', async () => {
    const { database, repo } = fixture();
    try {
      database.exec("DELETE FROM item_search_fts WHERE rowid=100; INSERT INTO item_search_fts(rowid,item_id,text) VALUES (9001,100,'波利卡片');");
      expect(database.prepare('SELECT rowid,item_id FROM item_search_fts WHERE rowid=9001').all()).toEqual([{ rowid: 9001, item_id: 100 }]);
      expect((await search(repo, 'q=波利卡片')).items.map((item) => item.id)).toEqual([1]);
    } finally { database.close(); }
  });

  it.each([
    ['gt', [3]], ['gte', [2, 3]], ['eq', [2]], ['neq', [1, 3]], ['lt', [1]], ['lte', [1, 2]],
  ] as const)('applies %s comparison at the value 50 boundary', async (operator, expected) => {
    const { database, repo } = fixture();
    try { expect((await search(repo, `option=12:${operator}:50`)).items.map((item) => item.id)).toEqual(expected); }
    finally { database.close(); }
  });

  it('enforces all/any and same-occurrence repeated option type semantics', async () => {
    const { database, repo } = fixture();
    try {
      expect((await search(repo, 'option=12:gte:50&option=12:lt:60')).items.map((item) => item.id)).toEqual([2, 3]);
      expect((await search(repo, 'option=12:gte:70&option=12:lt:60')).items).toEqual([]);
      expect((await search(repo, 'option=12:gte:70&option=12:lt:60&option_mode=any')).items.map((item) => item.id)).toEqual([1, 2, 3]);
    } finally { database.close(); }
  });

  it('applies definition scale, allowed operators, and required param policy', async () => {
    const { database, repo } = fixture();
    try {
      expect((await search(repo, 'option=198:gte:1.50:7')).items.map((item) => item.id)).toEqual([3]);
      await expect(search(repo, 'option=198:gte:1.50')).rejects.toThrow('param is required');
      await expect(search(repo, 'option=198:neq:1.50:7')).rejects.toThrow('operator is not allowed');
      await expect(search(repo, 'option=198:eq:1.50:8')).rejects.toThrow('Invalid option param');
    } finally { database.close(); }
  });

  it('rejects unknown types and disallowed operators without crashing', async () => {
    const { database, repo } = fixture();
    try {
      await expect(search(repo, 'option=999:gte:7')).rejects.toThrow('Unknown option type');
      await expect(search(repo, 'option=12:between:7')).rejects.toThrow('Invalid option operator');
    } finally { database.close(); }
  });

  it('keeps SQL and bind count bounded at eight conditions and a 50-row limit', async () => {
    const { database, repo, d1 } = fixture();
    try {
      await search(repo, Array.from({ length: 8 }, () => 'option=12:gte:1').join('&') + '&limit=500');
      const statements = d1.statements.filter((entry) => entry.sql.includes('FROM listings l') || entry.sql.includes('FROM listing_options lo'));
      expect(statements.length).toBeLessThanOrEqual(2);
      for (const statement of statements) {
        expect(statement.values.length).toBeLessThanOrEqual(100);
        expect(new TextEncoder().encode(statement.sql).length).toBeLessThan(100 * 1024);
      }
      expect(statements[0]?.values).toContain(51);
    } finally { database.close(); }
  });
});
