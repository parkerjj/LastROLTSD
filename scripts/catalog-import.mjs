import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, relative, resolve } from 'node:path';
import { buildCatalogManifest, catalogChecksum, IMPORTER_VERSION, mergeCatalogDescriptions, mergeCatalogInputs, parseCatalogInput, parseDescriptionInput, renderCatalogSqlParts, sha256Hex } from './catalog-import-lib.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  const inputs = await loadInputs(args);
  const descriptionInput = await loadDescriptionInput(args);
  const baseParsed = mergeCatalogInputs(inputs.map((input) => input.parsed));
  const parsed = descriptionInput ? mergeCatalogDescriptions(baseParsed, descriptionInput.parsed) : baseParsed;
  const inputChecksum = sha256Hex([
    ...inputs.map((input) => 'items:' + input.checksum),
    ...(descriptionInput ? ['descriptions:' + descriptionInput.checksum] : []),
  ].join('\n'));
  const dataChecksum = catalogChecksum(parsed);
  const sqlParts = renderCatalogSqlParts(parsed, { version: args.version, checksum: dataChecksum, outputChecksum: dataChecksum });
  const outputHasher = createHash('sha256');
  let sqlBytes = 0;
  for (const part of sqlParts) {
    outputHasher.update(part, 'utf8');
    sqlBytes += Buffer.byteLength(part, 'utf8');
  }
  const outputChecksum = outputHasher.digest('hex');
  const manifest = buildCatalogManifest(parsed, { version: args.version, inputChecksum, dataChecksum, outputChecksum });
  manifest.batchCount = sqlParts.length;
  manifest.statementCount = sqlParts.reduce((total, part) => total + (part.match(/;\n/gu) ?? []).length, 0);
  manifest.sqlBytes = sqlBytes;
  manifest.inputFiles = [
    ...inputs.map((input) => ({ role: 'items', name: basename(input.filename), bytes: input.bytes, checksum: input.checksum, records: input.parsed.items.length })),
    ...(descriptionInput ? [{ role: 'descriptions', name: basename(descriptionInput.filename), bytes: descriptionInput.bytes, checksum: descriptionInput.checksum, records: descriptionInput.parsed.recordCount, uniqueRecords: descriptionInput.parsed.descriptions.length, duplicateRecords: descriptionInput.parsed.duplicateCount }] : []),
  ];
  if (!args.dryRun) {
    const outputDir = resolve(args.outputDir);
    await mkdir(outputDir, { recursive: true });
    const prefix = 'catalog-' + args.kind + '-' + args.version;
    await rm(resolve(outputDir, prefix + '.sql'), { force: true });
    manifest.batchFiles = sqlParts.map((_, index) => prefix + '.part-' + String(index + 1).padStart(4, '0') + '.sql');
    await Promise.all(sqlParts.map((part, index) => writeFile(resolve(outputDir, manifest.batchFiles[index]), part, 'utf8')));
    await writeFile(resolve(outputDir, prefix + '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }
  console.log('catalog import ' + (args.dryRun ? 'dry-run' : 'written') + ': version=' + args.version + ' items=' + manifest.itemCount + ' descriptions=' + manifest.descriptionCount + ' descriptionRecords=' + manifest.descriptionRecordCount + ' descriptionDuplicates=' + manifest.descriptionDuplicateCount + ' aliases=' + manifest.aliasCount + ' skipped=' + manifest.skippedCount + ' batches=' + manifest.batchCount + ' statements=' + manifest.statementCount + ' sqlBytes=' + manifest.sqlBytes + ' errors=' + manifest.errorCount + ' inputChecksum=' + manifest.inputChecksum + ' dataChecksum=' + manifest.dataChecksum + ' outputChecksum=' + manifest.outputChecksum + ' importer=' + IMPORTER_VERSION);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('catalog import failed: errors=1');
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run' || token === '--skip-empty-names') flags.add(token);
    else if (token.startsWith('--')) { const value = argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(token + ' requires a value'); values.set(token, value); index += 1; }
    else throw new Error('unexpected argument');
  }
  const inputFile = values.get('--input-file');
  const inputDir = values.get('--input-dir');
  const descriptionFile = values.get('--description-file');
  if ((inputFile ? 1 : 0) + (inputDir ? 1 : 0) !== 1) throw new Error('provide exactly one of --input-file or --input-dir');
  const kind = values.get('--kind');
  if (kind !== 'items') throw new Error('--kind must be items');
  const version = values.get('--version');
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(version)) throw new Error('--version must be a stable release identifier');
  const outputDir = values.get('--output-dir');
  if (!outputDir) throw new Error('--output-dir is required');
  if (!isAllowedOutput(outputDir)) throw new Error('--output-dir must be under .generated');
  const encoding = values.get('--encoding') ?? 'auto';
  if (!['auto', 'utf8', 'utf8-bom', 'utf16le', 'utf16be'].includes(encoding)) throw new Error('--encoding is invalid');
  const descriptionEncoding = values.get('--description-encoding') ?? encoding;
  if (!['auto', 'utf8', 'utf8-bom', 'utf16le', 'utf16be'].includes(descriptionEncoding)) throw new Error('--description-encoding is invalid');
  return { inputFile, inputDir, descriptionFile, kind, version, outputDir, encoding, descriptionEncoding, dryRun: flags.has('--dry-run'), skipEmptyNames: flags.has('--skip-empty-names') };
}

async function loadDescriptionInput(options) {
  if (!options.descriptionFile) return null;
  const filename = resolve(options.descriptionFile);
  const buffer = await readFile(filename);
  return { filename, bytes: buffer.byteLength, checksum: sha256Hex(buffer), parsed: parseDescriptionInput(buffer, { filename, kind: 'item-descriptions', encoding: options.descriptionEncoding }) };
}

async function loadInputs(options) {
  let files = options.inputFile ? [resolve(options.inputFile)] : (await readdir(resolve(options.inputDir), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => resolve(options.inputDir, entry.name)).sort();
  if (files.length === 0) throw new Error('input contains no files');
  const inputs = [];
  for (const filename of files) {
    const buffer = await readFile(filename);
    const parsed = parseCatalogInput(buffer, { filename, kind: options.kind, encoding: options.encoding, skipEmptyNames: options.skipEmptyNames });
    inputs.push({ filename, bytes: buffer.byteLength, checksum: sha256Hex(buffer), parsed, skippedCount: parsed.skippedCount });
  }
  return inputs;
}

function isAllowedOutput(outputDir) {
  const root = resolve(process.cwd());
  const target = resolve(outputDir);
  const relativePath = relative(root, target).replaceAll('\\', '/');
  return relativePath === '.generated' || relativePath.startsWith('.generated/');
}
