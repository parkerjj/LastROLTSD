import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildCatalogManifest,
  parseCatalogInput,
  renderCatalogSql,
  sha256Hex,
} from './catalog-import-lib.mjs';

const metadata = (filename, encoding = 'auto') => ({ filename, kind: 'items', encoding });

test('imports UTF-8 BOM and parses id#name# item records', () => {
  const parsed = parseCatalogInput(Buffer.from('\uFEFF1234#测试剑#\n'), metadata('items.txt'));
  assert.deepEqual(parsed.items, [{ itemId: 1234, name: '测试剑', description: '', aliases: [] }]);
});

test('imports UTF-16LE with an explicit encoding', () => {
  const source = Buffer.from('1234#测试剑#\n', 'utf16le');
  const parsed = parseCatalogInput(source, metadata('items.txt', 'utf16le'));
  assert.equal(parsed.items[0].name, '测试剑');
});

test('rejects undecodable bytes and reports file, line, and field', () => {
  assert.throws(
    () => parseCatalogInput(Buffer.from([0xc3, 0x28]), metadata('broken.txt', 'auto')),
    /broken\.txt.*line 1.*encoding/i,
  );
});

test('rejects duplicate IDs, duplicate aliases, alias collisions, and invalid rows', () => {
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#\n1#乙#\n'), metadata('duplicate.txt')), /duplicate\.txt.*line 2.*id.*duplicate item id/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#甲\n'), metadata('alias.txt')), /duplicate alias/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲# 甲 \n'), metadata('canonical-alias.txt')), /duplicate alias/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#共同\n2#乙#共同\n'), metadata('collision.txt')), /collision\.txt.*line 2.*alias collision/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#乙\n2#乙#\n'), metadata('later-canonical.txt')), /alias collision/i);
  assert.throws(() => parseCatalogInput(Buffer.from('bad#甲#\n'), metadata('invalid.txt')), /invalid item id/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1##\n'), metadata('empty.txt')), /empty canonical name/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1|甲|\n'), metadata('wrong-separator.txt')), /separator/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#a#说明#多余\n'), metadata('too-many-separators.txt')), /separator/i);
});

test('renders stable SQL and manifest checksums independent of input order', () => {
  const one = parseCatalogInput(Buffer.from('2#乙#别名乙\n1#甲#\n'), metadata('items.txt', 'utf8'));
  const two = parseCatalogInput(Buffer.from('1#甲#\n2#乙#别名乙\n'), metadata('items.txt', 'utf8'));
  const sqlOne = renderCatalogSql(one, { version: 'catalog-test' });
  const sqlTwo = renderCatalogSql(two, { version: 'catalog-test' });
  assert.equal(sqlOne, sqlTwo);
  const manifest = buildCatalogManifest(one, { version: 'catalog-test', outputChecksum: sha256Hex(sqlOne) });
  assert.equal(manifest.itemCount, 2);
  assert.equal(manifest.outputChecksum, sha256Hex(sqlTwo));
  assert.equal(manifest.importerVersion, '1.0.0');
});

test('indexes canonical names, aliases, and descriptions in SQLite search structures', () => {
  const parsed = parseCatalogInput(Buffer.from('1234#测试剑#试剑#稀有说明文本\n'), metadata('items.txt', 'utf8'));
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of readdirSync(resolve('migrations')).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
      db.exec(readFileSync(resolve('migrations', name), 'utf8'));
    }
    db.exec(renderCatalogSql(parsed, { version: 'catalog-test' }));
    assert.deepEqual(db.prepare("SELECT scope_type,scope_id,token FROM search_short_tokens WHERE token IN ('测','试剑') ORDER BY token").all().map(toPlain), [
      { scope_type: 'item', scope_id: 1234, token: '测' },
      { scope_type: 'item', scope_id: 1234, token: '试剑' },
    ]);
    assert.deepEqual(db.prepare("SELECT item_id FROM item_search_fts WHERE text MATCH '说明文本'").all().map(toPlain), [{ item_id: 1234 }]);
  } finally {
    db.close();
  }
});

test('keeps every generated SQL statement below the D1 statement-size budget', () => {
  const source = Array.from({ length: 40 }, (_, index) => `${index + 1}#${index + 1}${'名'.repeat(999)}##${'说明'.repeat(1000)}\n`).join('');
  const parsed = parseCatalogInput(Buffer.from(source, 'utf8'), metadata('large.txt', 'utf8'));
  const sql = renderCatalogSql(parsed, { version: 'catalog-large' });
  const statements = sql.split(';\n').filter(Boolean);
  assert.ok(statements.every((statement) => Buffer.byteLength(statement, 'utf8') < 100 * 1024));
});

test("rejects a release that exceeds the bounded statement budget", () => {
  const input = { kind: "items", items: Array.from({ length: 500 }, (_, index) => ({ itemId: index + 1, name: String(index + 1) + "名".repeat(9998), description: "", aliases: [] })) };
  assert.throws(() => renderCatalogSql(input, { version: "catalog-too-large" }), /statement budget/i);
});

test('dry-run callers can validate without creating output files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-'));
  try {
    const input = join(dir, 'items.txt');
    await writeFile(input, '1#甲#\n', 'utf8');
    const filesBefore = await readdir(dir);
    assert.deepEqual(filesBefore, ['items.txt']);
    const parsed = parseCatalogInput(await readFile(input), metadata(input));
    assert.equal(parsed.items.length, 1);
    const filesAfter = await readdir(dir);
    assert.deepEqual(filesAfter, ['items.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI dry-run validates an input file without creating output files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-cli-'));
  try {
    const input = join(dir, 'items.txt');
    const output = join(dir, 'output');
    await writeFile(input, '1#甲#\n', 'utf8');
    const sourceBefore = await readFile(input);
    const result = spawnSync(process.execPath, [resolve('scripts/catalog-import.mjs'), '--input-file', input, '--kind', 'items', '--version', 'catalog-test', '--output-dir', resolve('.generated/catalog'), '--dry-run'], { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(stat(output));
    assert.deepEqual(await readFile(input), sourceBefore);
    assert.match(result.stdout, /dry-run/iu);
    assert.match(result.stdout, /errors=0/iu);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI accepts pnpm argument separator and reports checksum summary fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-pnpm-'));
  try {
    const input = join(dir, 'items.txt');
    await writeFile(input, '1#甲#\n', 'utf8');
    const result = spawnSync(process.execPath, [resolve('scripts/catalog-import.mjs'), '--', '--input-file', input, '--kind', 'items', '--version', 'catalog-pnpm-test', '--encoding', 'auto', '--output-dir', resolve('.generated/catalog-pnpm-test'), '--dry-run'], { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /inputChecksum=[0-9a-f]{64}/iu);
    assert.match(result.stdout, /dataChecksum=[0-9a-f]{64}/iu);
    assert.match(result.stdout, /outputChecksum=[0-9a-f]{64}/iu);
    assert.match(result.stdout, /errors=0/iu);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI accepts a deterministic input directory and preserves source files', async () => {
  const inputDir = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-dir-'));
  const output = resolve('.generated/catalog-dir-test');
  try {
    const first = join(inputDir, 'b-items.txt');
    const second = join(inputDir, 'a-items.txt');
    await writeFile(first, '2#乙#别名乙\n', 'utf8');
    await writeFile(second, '\uFEFF1#甲#\n', 'utf8');
    const before = [await readFile(first), await readFile(second)];
    const result = spawnSync(process.execPath, [resolve('scripts/catalog-import.mjs'), '--input-dir', inputDir, '--kind', 'items', '--version', 'catalog-dir-test', '--output-dir', output, '--encoding', 'auto'], { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const sql = await readFile(join(output, 'catalog-items-catalog-dir-test.sql'), 'utf8');
    assert.ok(sql.indexOf("(1,'甲'") < sql.indexOf("(2,'乙'"));
    assert.deepEqual(await readFile(first), before[0]);
    assert.deepEqual(await readFile(second), before[1]);
  } finally {
    await rm(inputDir, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('CLI rejects an output directory that is not generated or ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-cli-'));
  try {
    const input = join(dir, 'items.txt');
    await writeFile(input, '1#甲#\n', 'utf8');
    const result = spawnSync(process.execPath, [resolve('scripts/catalog-import.mjs'), '--input-file', input, '--kind', 'items', '--version', 'catalog-test', '--output-dir', join(dir, 'output')], { cwd: resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /generated|ignored/iu);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI output is deterministic and a repeated version is byte-identical', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-cli-'));
  const output = resolve('.generated/catalog-test');
  try {
    const input = join(dir, 'items.txt');
    await writeFile(input, '2#乙#别名乙\n1#甲#\n', 'utf8');
    const args = [resolve('scripts/catalog-import.mjs'), '--input-file', input, '--kind', 'items', '--version', 'catalog-test', '--output-dir', output];
    const first = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const sqlOne = await readFile(join(output, 'catalog-items-catalog-test.sql'), 'utf8');
    const manifestOne = await readFile(join(output, 'catalog-items-catalog-test.manifest.json'), 'utf8');
    const second = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(join(output, 'catalog-items-catalog-test.sql'), 'utf8'), sqlOne);
    assert.equal(await readFile(join(output, 'catalog-items-catalog-test.manifest.json'), 'utf8'), manifestOne);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('generated catalog output is excluded from Git and importer has no OpenKore path dependency', () => {
  const ignore = readFileSync(resolve('.gitignore'), 'utf8');
  assert.match(ignore, /^\.generated\/$/mu);
  const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', '.generated/catalog-items-test.sql'], { cwd: resolve('.') });
  assert.equal(ignored.status, 0, ignored.stderr?.toString());
  for (const filename of ['scripts/catalog-import.mjs', 'scripts/catalog-import-lib.mjs']) {
    assert.doesNotMatch(readFileSync(resolve(filename), 'utf8'), /D:\\openkore/iu);
  }
});

test('reapplying a release is idempotent, a new version updates names, and unknown listings survive', async () => {
  const db = await openMigratedDatabase();
  try {
    db.exec("INSERT INTO market_sources(id,name,api_key_hash,created_at) VALUES ('source','Synthetic','hash',0); INSERT INTO vendors(source_id,vendor_key,name,updated_at) VALUES ('source','vendor','Synthetic vendor',0); INSERT INTO shops(source_id,vendor_id,shop_key,shop_type,last_seen_at,updated_at) VALUES ('source',1,'shop','sell',0,0); INSERT INTO shop_sessions(shop_id,client_run_id,started_at,last_seen_at) VALUES (1,'run',0,0); INSERT INTO listings(shop_session_id,item_fingerprint,item_id,item_name,item_name_normalized,price,quantity,last_quantity,first_seen_at,last_seen_at,last_changed_at) VALUES (1,'fp-unknown',9999,'Legacy name','legacy name',100,1,1,0,0,0);");

    const releaseV1 = parseCatalogInput(Buffer.from('1234#测试剑#试剑\n5678#保留物品#保留\n'), metadata('v1.txt', 'utf8'));
    const releaseV2 = parseCatalogInput(Buffer.from('1234#新测试剑#试剑\n'), metadata('v2.txt', 'utf8'));
    db.exec(renderCatalogSql(releaseV1, { version: 'catalog-v1' }));
    db.exec(renderCatalogSql(releaseV2, { version: 'catalog-v2' }));
    db.exec(renderCatalogSql(releaseV2, { version: 'catalog-v2' }));

    const catalog = toPlain(db.prepare('SELECT canonical_name_zh,data_version FROM item_catalog WHERE item_id=1234').get());
    const listing = toPlain(db.prepare('SELECT item_id FROM listings WHERE item_fingerprint=\'fp-unknown\'').get());
    const versions = toPlain(db.prepare('SELECT COUNT(*) AS count FROM catalog_versions').get());
    const aliases = toPlain(db.prepare('SELECT COUNT(*) AS count FROM item_aliases WHERE item_id=1234').get());
    const retained = toPlain(db.prepare('SELECT canonical_name_zh FROM item_catalog WHERE item_id=5678').get());
    const state = toPlain(db.prepare('SELECT current_version FROM catalog_state WHERE id=1').get());
    assert.deepEqual(catalog, { canonical_name_zh: '新测试剑', data_version: 'catalog-v2' });
    assert.deepEqual(listing, { item_id: 9999 });
    assert.deepEqual(versions, { count: 2 });
    assert.deepEqual(aliases, { count: 1 });
    assert.deepEqual(retained, { canonical_name_zh: '保留物品' });
    assert.deepEqual(state, { current_version: 'catalog-v2' });
  } finally {
    db.close();
  }
});

test("does not silently ignore an alias conflict with an existing catalog item", async () => {
  const db = await openMigratedDatabase();
  try {
    const first = parseCatalogInput(Buffer.from("1#甲#共同别名" + String.fromCharCode(10)), metadata("first.txt", "utf8"));
    const second = parseCatalogInput(Buffer.from("2#乙#共同别名" + String.fromCharCode(10)), metadata("second.txt", "utf8"));
    db.exec(renderCatalogSql(first, { version: "catalog-v1" }));
    assert.throws(() => db.exec(renderCatalogSql(second, { version: "catalog-v2" })), /unique|constraint/i);
    assert.deepEqual(toPlain(db.prepare("SELECT item_id FROM item_aliases WHERE alias_normalized = ?1").get("共同别名")), { item_id: 1 });
  } finally {
    db.close();
  }
});

test("CLI argument failures include the standard error summary", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/catalog-import.mjs"), "--kind", "items", "--version", "catalog-test", "--output-dir", resolve(".generated/catalog-test")], { cwd: resolve("."), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /errors=1/iu);
});

async function openMigratedDatabase() {
  const db = new DatabaseSync(':memory:');
  const names = (await readdir(resolve('migrations'))).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  for (const name of names) db.exec(await readFile(join(resolve('migrations'), name), 'utf8'));
  return db;
}

function toPlain(row) {
  return row === undefined ? row : Object.fromEntries(Object.entries(row));
}
