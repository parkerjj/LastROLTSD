import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sqlStatements, batchStatements } from './mysql-migration-lib.mjs';

async function collect(iterable) {
  const result = [];
  for await (const item of iterable) result.push(item);
  return result;
}

test('SQL parser ignores comments and preserves semicolons inside quoted strings', async () => {
  const input = [
    '-- comment; not SQL',
    "INSERT IGNORE INTO items (id,v) VALUES (1,'a; b\\'s'); -- trailing; comment",
    "INSERT IGNORE INTO items (id,v) VALUES (2,'it''s; good');",
    '/* block; comment */ SELECT 1;',
  ];
  const result = await collect(sqlStatements(input));
  assert.equal(result.length, 3);
  assert.match(result[0], /a; b/u);
  assert.match(result[1], /it''s; good/u);
  assert.equal(result[2], 'SELECT 1');
});

test('SQL parser handles multi-line DDL and rejects unterminated SQL', async () => {
  assert.deepEqual(await collect(sqlStatements(['CREATE TABLE t (', 'id INT', ');'])), ['CREATE TABLE t (\nid INT\n)']);
  await assert.rejects(collect(sqlStatements(["INSERT INTO t VALUES ('broken);"])), /unterminated/u);
});

test('batch insert groups only consecutive, identical INSERT IGNORE', async () => {
  const source = [
    'INSERT IGNORE INTO t (id) VALUES (1)',
    'INSERT IGNORE INTO t (id) VALUES (2)',
    'INSERT IGNORE INTO t (id) VALUES (3)',
    'ALTER TABLE t ADD COLUMN name TEXT',
    'INSERT IGNORE INTO t (id) VALUES (4)',
    'INSERT INTO t (id) VALUES (5)',
  ];
  const result = await collect(batchStatements(source, { maxRows: 2 }));
  assert.deepEqual(result.map((x) => x.rows), [2, 1, 1, 1, 1]);
  assert.equal(result[0].sql, 'INSERT IGNORE INTO t (id) VALUES (1),(2)');
  assert.equal(result[3].sql, 'INSERT IGNORE INTO t (id) VALUES (4)');
});

test('byte size limits force batches to split', async () => {
  const source = [
    "INSERT IGNORE INTO t (v) VALUES ('中文内容')",
    "INSERT IGNORE INTO t (v) VALUES ('中文内容')",
  ];
  const batches = await collect(batchStatements(source, { maxBytes: 25 }));
  assert.deepEqual(batches.map((x) => x.rows), [1, 1]);
});

test('29356 catalogue inserts require only a few hundred bounded batches', async () => {
  async function* generate() {
    for (let i = 0; i < 29356; i += 1) {
      yield 'INSERT IGNORE INTO item_catalog (item_id,name) VALUES (' + i + ",'Item " + i + "')";
    }
  }
  let count = 0;
  let rows = 0;
  for await (const batch of batchStatements(generate())) {
    count += 1;
    rows += batch.rows;
    assert.ok(batch.rows <= 128);
    assert.ok(Buffer.byteLength(batch.sql, 'utf8') < 262400);
  }
  assert.equal(rows, 29356);
  assert.equal(count, Math.ceil(rows / 128));
});
