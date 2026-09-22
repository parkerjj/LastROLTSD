import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  buildCatalogAsset,
  buildDescriptionAsset,
  IMPORTER_VERSION,
  mergeCatalogInputs,
  parseCatalogInput,
  parseDescriptionInput,
  serializeCatalogAsset,
  sha256Hex,
} from './catalog-import-lib.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  const inputs = await loadInputs(args);
  const parsed = mergeCatalogInputs(inputs.map((input) => input.parsed));
  const asset = buildCatalogAsset(parsed, { version: args.version });
  const output = serializeCatalogAsset(asset);
  let descriptionAsset;
  let descriptionOutput;
  if (args.descriptionFile) {
    const descriptionBuffer = await readFile(resolve(args.descriptionFile));
    descriptionAsset = buildDescriptionAsset(parseDescriptionInput(descriptionBuffer, { filename: args.descriptionFile, encoding: args.descriptionEncoding }), { version: args.version });
    descriptionOutput = JSON.stringify(descriptionAsset) + '\n';
  }
  const inputChecksum = sha256Hex(inputs.map((input) => input.checksum).join('\n'));

  if (!args.dryRun) {
    const outputFile = resolve(args.outputFile);
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, output, 'utf8');
    if (descriptionOutput !== undefined) {
      const descriptionFile = resolve(args.descriptionOutputFile ?? join(dirname(args.outputFile), 'itemsdescriptions.json'));
      await mkdir(dirname(descriptionFile), { recursive: true });
      await writeFile(descriptionFile, descriptionOutput, 'utf8');
    }
  }

  console.log(
    `catalog import ${args.dryRun ? 'dry-run' : 'written'}: version=${asset.version}`
      + ` items=${asset.items.length} aliases=${asset.items.reduce((total, item) => total + item.aliases.length, 0)}`
      + ` skipped=${parsed.skippedCount} bytes=${Buffer.byteLength(output, 'utf8')} errors=0`
      + ` inputChecksum=${inputChecksum} checksum=${asset.checksum} importer=${IMPORTER_VERSION}`
      + (descriptionAsset ? ` descriptions=${descriptionAsset.descriptions.length} descriptionChecksum=${descriptionAsset.checksum}` : ''),
  );
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
    else if (token.startsWith('--')) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      values.set(token, value);
      index += 1;
    } else throw new Error(`unexpected argument: ${token}`);
  }

  const inputFile = values.get('--input-file');
  const inputDir = values.get('--input-dir');
  if ((inputFile ? 1 : 0) + (inputDir ? 1 : 0) !== 1) throw new Error('provide exactly one of --input-file or --input-dir');
  if (values.get('--kind') !== 'items') throw new Error('--kind must be items');
  const version = values.get('--version');
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(version)) throw new Error('--version must be a stable release identifier');
  const outputFile = values.get('--output-file');
  if (!outputFile || !outputFile.toLocaleLowerCase().endsWith('.json')) throw new Error('--output-file must be a JSON file');
  const encoding = values.get('--encoding') ?? 'auto';
  const descriptionEncoding = values.get('--description-encoding') ?? encoding;
  if (!['auto', 'utf8', 'utf8-bom', 'utf16le', 'utf16be'].includes(encoding) || !['auto', 'utf8', 'utf8-bom', 'utf16le', 'utf16be'].includes(descriptionEncoding)) throw new Error('--encoding is invalid');
  return { inputFile, inputDir, version, outputFile, encoding, descriptionFile: values.get('--description-file'), descriptionOutputFile: values.get('--description-output-file'), descriptionEncoding, dryRun: flags.has('--dry-run'), skipEmptyNames: flags.has('--skip-empty-names') };
}

async function loadInputs(options) {
  const files = options.inputFile
    ? [resolve(options.inputFile)]
    : (await readdir(resolve(options.inputDir), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(options.inputDir, entry.name))
      .sort();
  if (files.length === 0) throw new Error('input contains no files');

  const inputs = [];
  for (const filename of files) {
    const buffer = await readFile(filename);
    inputs.push({
      checksum: sha256Hex(buffer),
      parsed: parseCatalogInput(buffer, { filename, kind: 'items', encoding: options.encoding, skipEmptyNames: options.skipEmptyNames }),
    });
  }
  return inputs;
}
