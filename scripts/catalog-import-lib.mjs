import { createHash } from 'node:crypto';

export const IMPORTER_VERSION = '2.0.0';
export const MAX_CATALOG_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_DESCRIPTION_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10_000;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeCatalogText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function normalizeDisplayText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function parseCatalogInput(buffer, metadata = {}) {
  const filename = String(metadata.filename ?? 'input');
  if ((metadata.kind ?? 'items') !== 'items') throw validationError(filename, 1, 'kind', 'only item catalog input is supported');
  const records = parseRecords(decodeInput(buffer, metadata.encoding ?? 'auto', filename), filename);
  if (records.length === 0) throw validationError(filename, 1, 'record', 'input contains no records');

  let skippedCount = 0;
  const items = [];
  for (const record of records) {
    const item = normalizeItemRecord(record.value, filename, record.line, metadata.skipEmptyNames === true);
    if (item === null) skippedCount += 1;
    else items.push(item);
  }
  if (items.length === 0) throw validationError(filename, 1, 'record', 'input contains no named records');
  validateItemSet(items, filename);
  return { kind: 'items', items, skippedCount };
}

export function mergeCatalogInputs(inputs) {
  const items = inputs.flatMap((input) => input.items);
  if (items.length === 0) throw validationError('catalog release', 1, 'record', 'input contains no records');
  validateItemSet(items, 'catalog release');
  return {
    kind: 'items',
    items,
    skippedCount: inputs.reduce((total, input) => total + Number(input.skippedCount ?? 0), 0),
  };
}

export function buildCatalogAsset(input, options = {}) {
  const version = String(options.version ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(version)) throw new Error('version must be a stable release identifier');
  validateItemSet(input.items, 'catalog release');

  const items = [...input.items]
    .sort((left, right) => left.itemId - right.itemId)
    .map((item) => ({
      itemId: item.itemId,
      name: item.name,
      aliases: [...item.aliases].sort(compareCatalogText),
    }));
  const asset = { version, checksum: sha256Hex(JSON.stringify(items)), items };
  assertAssetSize(asset);
  return asset;
}

export function parseDescriptionInput(buffer, metadata = {}) {
  const filename = String(metadata.filename ?? 'itemsdescriptions');
  const text = decodeInput(buffer, metadata.encoding ?? 'auto', filename).replace(/\r\n?/gu, '\n');
  const descriptions = new Map();
  let current = null;
  const flush = (line) => {
    if (!current) return;
    const description = normalizeDescriptionText(current.lines.join('\n'));
    if (description) descriptions.set(current.itemId, { itemId: current.itemId, description });
    current = null;
  };
  text.split('\n').forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    const start = /^(\d+)#(.*)$/u.exec(line);
    if (start) {
      flush(lineNumber);
      const itemId = parseItemId(start[1], filename, lineNumber);
      let content = start[2];
      const closed = content.endsWith('#');
      if (closed) content = content.slice(0, -1);
      current = { itemId, lines: [content] };
      if (closed) flush(lineNumber);
      return;
    }
    if (!current) {
      if (!line.trim() || line.trim().startsWith('//')) return;
      throw validationError(filename, lineNumber, 'record', 'description continuation without item id');
    }
    const closed = line.endsWith('#');
    current.lines.push(closed ? line.slice(0, -1) : line);
    if (closed) flush(lineNumber);
  });
  flush(text.split('\n').length);
  return { kind: 'descriptions', descriptions: [...descriptions.values()] };
}

export function buildDescriptionAsset(input, options = {}) {
  const version = String(options.version ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(version)) throw new Error('version must be a stable release identifier');
  const descriptions = [...input.descriptions]
    .sort((left, right) => left.itemId - right.itemId)
    .map((row) => ({ itemId: row.itemId, description: normalizeDescriptionText(row.description) }))
    .filter((row) => row.description);
  const asset = { version, checksum: sha256Hex(JSON.stringify(descriptions)), descriptions };
  const serialized = JSON.stringify(asset) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DESCRIPTION_ASSET_BYTES) throw new Error('description asset exceeds maximum size');
  return asset;
}

function normalizeDescriptionText(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();
}

export function serializeCatalogAsset(asset) {
  const serialized = JSON.stringify(asset) + '\n';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_CATALOG_ASSET_BYTES) {
    throw new Error(`catalog asset is ${bytes} bytes; maximum is ${MAX_CATALOG_ASSET_BYTES}`);
  }
  return serialized;
}

// Catalog publication no longer produces database statements.
export function renderCatalogSqlParts() {
  return undefined;
}

function assertAssetSize(asset) {
  serializeCatalogAsset(asset);
}

function decodeInput(buffer, encoding, filename) {
  const bytes = Buffer.from(buffer);
  const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const hasLeBom = bytes[0] === 0xff && bytes[1] === 0xfe;
  const hasBeBom = bytes[0] === 0xfe && bytes[1] === 0xff;
  const automatic = encoding === 'auto';
  const selected = automatic ? (hasUtf8Bom ? 'utf8-bom' : hasLeBom ? 'utf16le' : hasBeBom ? 'utf16be' : 'utf8') : encoding;

  try {
    if (selected === 'utf8' || selected === 'utf8-bom') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
      if (automatic && text.includes('\u0000')) throw new Error('ambiguous encoding');
      return text;
    }
    if (selected === 'utf16le') {
      if (bytes.length % 2 !== 0) throw new Error('odd byte count');
      return new TextDecoder('utf-16le', { fatal: true }).decode(hasLeBom ? bytes.subarray(2) : bytes).replace(/^\uFEFF/u, '');
    }
    if (selected === 'utf16be') {
      const source = hasBeBom ? bytes.subarray(2) : bytes;
      if (source.length % 2 !== 0) throw new Error('odd byte count');
      const swapped = Buffer.allocUnsafe(source.length);
      for (let index = 0; index < source.length; index += 2) {
        swapped[index] = source[index + 1];
        swapped[index + 1] = source[index];
      }
      return new TextDecoder('utf-16le', { fatal: true }).decode(swapped).replace(/^\uFEFF/u, '');
    }
  } catch {
    throw validationError(filename, 1, 'encoding', `input is not valid or has uncertain ${selected}`);
  }
  throw validationError(filename, 1, 'encoding', 'unsupported encoding');
}

function parseRecords(text, filename) {
  const trimmed = text.trimStart();
  const extension = filename.toLocaleLowerCase().split('.').at(-1) ?? '';
  if (extension === 'json' || trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n'))) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw validationError(filename, 1, 'record', 'invalid JSON'); }
    const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [parsed];
    return values.map((value, index) => ({ value, line: index + 1 }));
  }
  if (extension === 'jsonl') {
    return text.split(/\r?\n/u)
      .map((line, index) => ({ line: index + 1, value: line.trim() ? parseJsonLine(line, filename, index + 1) : null }))
      .filter((record) => record.value !== null);
  }
  if (extension === 'csv' || extension === 'tsv') return parseDelimited(text, extension === 'csv' ? ',' : '\t', filename);
  return text.split(/\r?\n/u).map((line, index) => {
    const lineNumber = index + 1;
    const value = line.trim();
    if (!value || value.startsWith('//')) return null;
    if (!value.includes('#')) throw validationError(filename, lineNumber, 'separator', 'expected id#name# format');
    const fields = value.split('#');
    if (fields.length < 3 || fields.length > 4) throw validationError(filename, lineNumber, 'separator', 'expected exactly 2 or 3 separators');
    return { line: lineNumber, value: { id: fields[0], name: fields[1], aliases: fields[2], description: fields[3] ?? '' } };
  }).filter((record) => record !== null);
}

function parseJsonLine(line, filename, lineNumber) {
  try { return JSON.parse(line); } catch { throw validationError(filename, lineNumber, 'record', 'invalid JSON'); }
}

function parseDelimited(text, delimiter, filename) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length === 0) return [];
  const headers = splitDelimitedLine(lines[0], delimiter, filename, 1).map((header) => normalizeCatalogText(header));
  return lines.slice(1).map((line, offset) => {
    const lineNumber = offset + 2;
    const values = splitDelimitedLine(line, delimiter, filename, lineNumber);
    if (values.length !== headers.length) throw validationError(filename, lineNumber, 'record', 'wrong column count');
    return { line: lineNumber, value: Object.fromEntries(headers.map((header, index) => [header, values[index]])) };
  });
}

function splitDelimitedLine(line, delimiter, filename, lineNumber) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      values.push(current);
      current = '';
    } else current += character;
  }
  if (quoted) throw validationError(filename, lineNumber, 'record', 'unterminated quoted field');
  values.push(current);
  return values;
}

function normalizeItemRecord(record, filename, line, allowEmptyName) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw validationError(filename, line, 'record', 'expected an object');
  const allowed = new Set(['id', 'item_id', 'itemId', 'name', 'canonical_name_zh', 'canonicalNameZh', 'description', 'aliases', 'alias']);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw validationError(filename, line, key, 'unknown field');

  const itemId = parseItemId(record.id ?? record.item_id ?? record.itemId, filename, line);
  const name = normalizeDisplayText(record.name ?? record.canonical_name_zh ?? record.canonicalNameZh ?? '');
  if (!name) {
    if (allowEmptyName) return null;
    throw validationError(filename, line, 'name', 'empty canonical name');
  }
  if (name.length > MAX_TEXT_LENGTH) throw validationError(filename, line, 'name', 'value is too long');

  const aliases = record.aliases ?? record.alias ?? [];
  const aliasList = Array.isArray(aliases) ? aliases : String(aliases).split('|');
  const item = {
    itemId,
    name,
    aliases: aliasList.map((alias) => normalizeDisplayText(alias)).filter(Boolean).sort(compareCatalogText),
  };
  Object.defineProperties(item, {
    sourceFilename: { value: filename, enumerable: false },
    sourceLine: { value: line, enumerable: false },
  });
  return item;
}

function parseItemId(value, filename, line) {
  if (typeof value !== 'number' && typeof value !== 'string') throw validationError(filename, line, 'id', 'invalid item id');
  if (!/^[0-9]+$/u.test(String(value).trim())) throw validationError(filename, line, 'id', 'invalid item id');
  const itemId = Number(String(value).trim());
  if (!Number.isSafeInteger(itemId) || itemId < 0) throw validationError(filename, line, 'id', 'invalid item id');
  return itemId;
}

function validateItemSet(items, fallbackFilename) {
  const ids = new Set();
  const canonicalNames = new Map();
  for (const item of items) {
    const filename = item.sourceFilename ?? fallbackFilename;
    const line = item.sourceLine ?? 1;
    if (ids.has(item.itemId)) throw validationError(filename, line, 'id', 'duplicate item id');
    ids.add(item.itemId);
    const normalized = normalizeCatalogText(item.name);
    if (!normalized) throw validationError(filename, line, 'name', 'empty canonical name');
    if (!canonicalNames.has(normalized)) canonicalNames.set(normalized, item.itemId);
  }

  const aliases = new Map();
  for (const item of items) {
    const filename = item.sourceFilename ?? fallbackFilename;
    const line = item.sourceLine ?? 1;
    const seen = new Set();
    for (const alias of item.aliases) {
      const normalized = normalizeCatalogText(alias);
      if (!normalized) throw validationError(filename, line, 'alias', 'empty alias');
      if (seen.has(normalized)) throw validationError(filename, line, 'alias', 'duplicate alias');
      seen.add(normalized);
      if (canonicalNames.has(normalized)) throw validationError(filename, line, 'alias', canonicalNames.get(normalized) === item.itemId ? 'duplicate alias' : 'alias collision');
      if (aliases.has(normalized)) {
        const previousId = aliases.get(normalized);
        if (previousId !== item.itemId) throw validationError(filename, line, 'alias', 'alias collision');
        throw validationError(filename, line, 'alias', 'duplicate alias');
      }
      aliases.set(normalized, item.itemId);
    }
  }
}

function compareCatalogText(left, right) {
  const normalizedLeft = normalizeCatalogText(left);
  const normalizedRight = normalizeCatalogText(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function validationError(filename, line, field, message) {
  return new Error(`${filename}: line ${line}: ${field}: ${message}`);
}
