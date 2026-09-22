import { describe, expect, it } from 'vitest';
import { convertSqliteToMysql } from '../../scripts/convert-sqlite-to-mysql.mjs';

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
});
