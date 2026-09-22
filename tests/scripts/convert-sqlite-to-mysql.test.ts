import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { convertSqliteToMysql, writeWithBackpressure } from '../../scripts/convert-sqlite-to-mysql.mjs';

describe('SQLite to MySQL converter', () => {
  it('converts supported DDL and idempotent inserts while preserving UTF-8 strings', () => {
    const source = "PRAGMA foreign_keys=ON;\nCREATE TABLE x(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) WITHOUT ROWID;\nINSERT OR IGNORE INTO x VALUES(1,'中文 O''Brien');\n";

    const output = convertSqliteToMysql(source);

    expect(output).toContain('BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY');
    expect(output).toContain("INSERT INTO x VALUES(1,'中文 O''Brien') ON DUPLICATE KEY UPDATE id=id;");
    expect(output).not.toMatch(/PRAGMA|WITHOUT ROWID|AUTOINCREMENT/u);
  });

  it('fails closed with a source line number for unsupported SQLite statements', () => {
    expect(() => convertSqliteToMysql('CREATE VIRTUAL TABLE f USING fts5(v);'))
      .toThrow('unsupported SQLite statement at line 1');
  });

  it('keeps semicolons inside quoted UTF-8 data and maps SQLite conflict forms explicitly', () => {
    const source = `-- a comment with a semicolon;\nCREATE TABLE y("id" INTEGER PRIMARY KEY, label TEXT);\nINSERT OR REPLACE INTO y VALUES(1,'中文; 保留');\nINSERT INTO y VALUES(1,'next') ON CONFLICT(id) DO NOTHING;`;

    const output = convertSqliteToMysql(source);

    expect(output).toContain("REPLACE INTO y VALUES(1,'中文; 保留');");
    expect(output).toContain("INSERT INTO y VALUES(1,'next') ON DUPLICATE KEY UPDATE id=id;");
  });

  it('removes SQLite defaults from MySQL text columns', () => {
    const source = "CREATE TABLE upload_batches(shop_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(shop_ids_json)));";

    const output = convertSqliteToMysql(source);

    expect(output).toContain('shop_ids_json MEDIUMTEXT NOT NULL CHECK(JSON_VALID(shop_ids_json))');
    expect(output).not.toMatch(/MEDIUMTEXT[^,)]*\bDEFAULT\b/iu);
  });

  it('omits D1 migration metadata from data-only output', () => {
    const source = "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO d1_migrations VALUES(1,'0001_initial.sql');\nCREATE TABLE shops(id INTEGER PRIMARY KEY, title TEXT);\nINSERT INTO shops VALUES(1,'商店');";

    const output = convertSqliteToMysql(source, { dataOnly: true });

    expect(output).not.toContain('d1_migrations');
    expect(output).toContain("INSERT INTO shops VALUES(1,'商店');");
  });

  it('removes the pending error listener after a writer drain', async () => {
    const writer = new EventEmitter() as EventEmitter & { write(value: string): boolean };
    writer.write = () => false;

    const pending = writeWithBackpressure(writer, 'statement;\n');
    expect(writer.listenerCount('error')).toBe(1);
    writer.emit('drain');
    await pending;
    expect(writer.listenerCount('error')).toBe(0);
  });
});
