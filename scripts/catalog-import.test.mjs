import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildCatalogAsset,
  MAX_CATALOG_ASSET_BYTES,
  mergeCatalogInputs,
  parseCatalogInput,
  renderCatalogSqlParts,
  serializeCatalogAsset,
  sha256Hex,
} from './catalog-import-lib.mjs';

const metadata = (filename, encoding = 'auto') => ({ filename, kind: 'items', encoding });

test('imports UTF-8 BOM and UTF-16LE item records', () => {
  const utf8 = parseCatalogInput(Buffer.from('\uFEFF1234#测试剑#\n'), metadata('items.txt'));
  const utf16 = parseCatalogInput(Buffer.from('5678#波利卡片#波利卡\n', 'utf16le'), metadata('items.txt', 'utf16le'));
  assert.deepEqual(utf8.items, [{ itemId: 1234, name: '测试剑', aliases: [] }]);
  assert.deepEqual(utf16.items, [{ itemId: 5678, name: '波利卡片', aliases: ['波利卡'] }]);
});

test('parses JSON, JSONL, CSV, TSV, and id#name# inputs', () => {
  const cases = [
    ['items.json', '[{"id":1,"name":"甲"}]'],
    ['items.jsonl', '{"id":1,"name":"甲"}\n'],
    ['items.csv', 'id,name\n1,甲\n'],
    ['items.tsv', 'id\tname\n1\t甲\n'],
    ['items.txt', '1#甲#\n'],
  ];
  for (const [filename, source] of cases) {
    assert.equal(parseCatalogInput(Buffer.from(source, 'utf8'), metadata(filename, 'utf8')).items[0].name, '甲');
  }
});

test('rejects duplicate IDs, normalized canonical names, aliases, and invalid rows', () => {
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#\n1#乙#\n'), metadata('duplicate.txt')), /duplicate item id/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#Ａ#\n2#a#\n'), metadata('canonical.txt')), /canonical name collision/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#共同\n2#乙#共同\n'), metadata('alias.txt')), /alias collision/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1#甲#甲\n'), metadata('self-alias.txt')), /duplicate alias/i);
  assert.throws(() => parseCatalogInput(Buffer.from('bad#甲#\n'), metadata('invalid.txt')), /invalid item id/i);
  assert.throws(() => parseCatalogInput(Buffer.from('1##\n'), metadata('empty.txt')), /empty canonical name/i);
});

test('explicitly skips empty-name placeholder rows', () => {
  const parsed = parseCatalogInput(Buffer.from('27402##\n1#Valid item#\n'), { ...metadata('items.txt'), skipEmptyNames: true });
  assert.deepEqual(parsed.items.map((item) => item.itemId), [1]);
  assert.equal(parsed.skippedCount, 1);
});

test('merges deterministic input sets and revalidates cross-file collisions', () => {
  const first = parseCatalogInput(Buffer.from('2#乙#别名乙\n'), metadata('b.txt'));
  const second = parseCatalogInput(Buffer.from('1#甲#\n'), metadata('a.txt'));
  assert.deepEqual(mergeCatalogInputs([first, second]).items.map((item) => item.itemId), [2, 1]);
  const collision = parseCatalogInput(Buffer.from('3#丙#\n'), metadata('c.txt'));
  collision.items[0].name = '甲';
  assert.throws(() => mergeCatalogInputs([second, collision]), /canonical name collision/i);
});

test('builds a deterministic browser catalog asset instead of D1 SQL', () => {
  const parsed = parseCatalogInput(Buffer.from('4002#杰勒比#乙|Ａ\n4001#波利卡片#波利卡\n', 'utf8'), metadata('items.txt', 'utf8'));
  const asset = buildCatalogAsset(parsed, { version: 'items-v1' });

  assert.deepEqual(asset.items[0], { itemId: 4001, name: '波利卡片', aliases: ['波利卡'] });
  assert.deepEqual(asset.items[1].aliases, ['A', '乙']);
  assert.equal(asset.checksum, sha256Hex(JSON.stringify(asset.items)));
  assert.equal(renderCatalogSqlParts(parsed, { version: 'items-v1' }), undefined);
  assert.equal(serializeCatalogAsset(asset), JSON.stringify(asset) + '\n');
});

test('keeps checksum scoped to deterministic item data', () => {
  const parsed = parseCatalogInput(Buffer.from('2#Beta#Z|A\n1#Alpha#\n', 'utf8'), metadata('items.txt', 'utf8'));
  const first = buildCatalogAsset(parsed, { version: 'items-v1' });
  const second = buildCatalogAsset(parsed, { version: 'items-v2' });

  assert.deepEqual(first.items, [
    { itemId: 1, name: 'Alpha', aliases: [] },
    { itemId: 2, name: 'Beta', aliases: ['A', 'Z'] },
  ]);
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.checksum, sha256Hex(JSON.stringify(first.items)));
  assert.deepEqual(Object.keys(first), ['version', 'checksum', 'items']);
  assert.equal(JSON.stringify(first).includes('generated'), false);
});

test('rejects an uncompressed asset larger than 2 MiB', () => {
  const input = {
    kind: 'items',
    items: Array.from({ length: 30_000 }, (_, index) => ({ itemId: index + 1, name: `物品-${index}-${'名'.repeat(12)}`, aliases: [] })),
  };
  assert.throws(() => buildCatalogAsset(input, { version: 'items-too-large' }), new RegExp(String(MAX_CATALOG_ASSET_BYTES)));
});

test('CLI writes one deterministic JSON asset and accepts the pnpm separator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-'));
  try {
    const input = join(directory, 'items.json');
    const output = join(directory, 'item-catalog.json');
    await writeFile(input, JSON.stringify([{ id: 2, name: '乙' }, { id: 1, name: '甲' }]), 'utf8');
    const args = [resolve('scripts/catalog-import.mjs'), '--', '--input-file', input, '--kind', 'items', '--version', 'items-test', '--output-file', output];
    const first = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const firstOutput = await readFile(output, 'utf8');
    const second = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(output, 'utf8'), firstOutput);
    assert.deepEqual(JSON.parse(firstOutput).items.map((item) => item.itemId), [1, 2]);
    assert.match(first.stdout, /items=2.*errors=0.*checksum=[0-9a-f]{64}/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI dry-run validates without creating output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-dry-'));
  try {
    const input = join(directory, 'items.txt');
    const output = join(directory, 'missing.json');
    await writeFile(input, '1#甲#\n', 'utf8');
    const result = spawnSync(process.execPath, [resolve('scripts/catalog-import.mjs'), '--input-file', input, '--kind', 'items', '--version', 'items-test', '--output-file', output, '--dry-run'], { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(stat(output));
    assert.match(result.stdout, /dry-run/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI requires an explicit JSON output file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lastroweb-catalog-output-'));
  try {
    const input = join(directory, 'items.txt');
    await writeFile(input, '1#Item\n', 'utf8');
    const result = spawnSync(process.execPath, [resolve('scripts/catalog-import.mjs'), '--input-file', input, '--kind', 'items', '--version', 'items-test'], { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--output-file/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
