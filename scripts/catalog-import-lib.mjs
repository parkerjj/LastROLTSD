import { createHash } from 'node:crypto';

export const IMPORTER_VERSION = '1.0.0';
export const MAX_SQL_STATEMENT_BYTES = 90 * 1024;
export const MAX_SQL_STATEMENTS = 45;
const MAX_TEXT_LENGTH = 10_000;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeCatalogText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function normalizeDisplayText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function parseCatalogInput(buffer, metadata) {
  const filename = String(metadata?.filename ?? 'input');
  const kind = metadata?.kind ?? 'items';
  if (kind !== 'items') throw validationError(filename, 1, 'kind', 'only item catalog input is supported in this session');
  const text = decodeInput(buffer, metadata?.encoding ?? 'auto', filename);
  const records = parseRecords(text, filename);
  if (records.length === 0) throw validationError(filename, 1, 'record', 'input contains no records');
  const items = records.map((record) => normalizeItemRecord(record.value, filename, record.line));
  validateItemSet(items, filename);
  return { kind: 'items', items };
}

export function mergeCatalogInputs(inputs) {
  const items = inputs.flatMap((input) => input.items);
  if (items.length === 0) throw validationError('catalog release', 1, 'record', 'input contains no records');
  validateItemSet(items, 'catalog release');
  return { kind: 'items', items };
}

export function catalogChecksum(input) {
  return sha256Hex(canonicalCatalog(input));
}

export function buildCatalogManifest(input, options = {}) {
  const canonical = canonicalCatalog(input);
  const dataChecksum = String(options.dataChecksum ?? sha256Hex(canonical));
  return {
    schemaVersion: 1,
    importerVersion: IMPORTER_VERSION,
    kind: input.kind,
    dataVersion: String(options.version ?? 'unversioned'),
    inputChecksum: String(options.inputChecksum ?? dataChecksum),
    dataChecksum,
    outputChecksum: String(options.outputChecksum ?? ''),
    itemCount: input.items.length,
    aliasCount: input.items.reduce((total, item) => total + item.aliases.length, 0),
    errorCount: 0,
  };
}

export function renderCatalogSql(input, options = {}) {
  const version = String(options.version ?? 'unversioned');
  const dataChecksum = String(options.checksum ?? catalogChecksum(input));
  const outputChecksum = String(options.outputChecksum ?? dataChecksum);
  const items = [...input.items].sort((left, right) => left.itemId - right.itemId);
  const itemIds = items.map((item) => item.itemId);
  const statements = [
    'PRAGMA foreign_keys = ON',
    'BEGIN TRANSACTION',
  ];

  if (itemIds.length > 0) {
    statements.push(...chunkDeleteByIds('search_short_tokens', 'scope_id', itemIds, "scope_type='item'"));
    statements.push(...chunkDeleteByIds('item_search_fts', 'item_id', itemIds));
    statements.push(...chunkDeleteByIds('item_aliases', 'item_id', itemIds));
  }

  statements.push(...chunkInsert(
    'item_catalog',
    ['item_id', 'canonical_name_zh', 'name_normalized', 'description', 'data_version', 'updated_at'],
    items.map((item) => [item.itemId, item.name, normalizeCatalogText(item.name), item.description, version, 0]),
    { conflictClause: 'ON CONFLICT(item_id) DO UPDATE SET canonical_name_zh=excluded.canonical_name_zh,name_normalized=excluded.name_normalized,description=excluded.description,data_version=excluded.data_version,updated_at=excluded.updated_at' },
  ));

  const aliases = items.flatMap((item) => item.aliases.map((alias) => [item.itemId, alias, normalizeCatalogText(alias), 'approved', version, 0]))
    .sort((left, right) => Number(left[0]) - Number(right[0]) || compareCatalogText(String(left[2]), String(right[2])));
  statements.push(...chunkInsert(
    'item_aliases',
    ['item_id', 'alias', 'alias_normalized', 'alias_kind', 'data_version', 'updated_at'],
    aliases,
    { insertPrefix: 'INSERT' },
  ));

  const ftsRows = items.map((item) => [item.itemId, searchableText(item)]);
  statements.push(...chunkInsert('item_search_fts', ['item_id', 'text'], ftsRows));

  const tokenRows = [];
  for (const item of items) {
    const seen = new Set();
    for (const text of [item.name, ...item.aliases, item.description]) {
      const codePoints = [...normalizeCatalogText(text)];
      for (let width = 1; width <= 2; width += 1) {
        for (let index = 0; index + width <= codePoints.length; index += 1) {
          seen.add(codePoints.slice(index, index + width).join(''));
        }
      }
    }
    for (const token of [...seen].sort(compareCatalogText)) tokenRows.push(['item', item.itemId, token]);
  }
  tokenRows.sort((left, right) => Number(left[1]) - Number(right[1]) || compareCatalogText(String(left[2]), String(right[2])));
  statements.push(...chunkInsert('search_short_tokens', ['scope_type', 'scope_id', 'token'], tokenRows, { insertPrefix: 'INSERT OR IGNORE' }));

  statements.push(
    'INSERT INTO catalog_versions(version,checksum,imported_at,item_count,alias_count,option_count,importer_version,output_checksum) VALUES (' +
      [version, dataChecksum, 0, items.length, aliases.length, 0, IMPORTER_VERSION, outputChecksum].map(sqlLiteral).join(',') +
      ') ON CONFLICT(version) DO UPDATE SET checksum=excluded.checksum, imported_at=excluded.imported_at, item_count=excluded.item_count, alias_count=excluded.alias_count, option_count=excluded.option_count, importer_version=excluded.importer_version, output_checksum=excluded.output_checksum',
  );
  statements.push('INSERT INTO catalog_state(id,current_version,updated_at) VALUES (1,' + sqlLiteral(version) + ',0) ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version,updated_at=excluded.updated_at');
  statements.push('COMMIT');
  if (statements.length > MAX_SQL_STATEMENTS) throw new Error('generated SQL exceeds the statement budget; split the catalog release');
  return statements.map((statement) => statement + ';').join('\n') + '\n';
}

function decodeInput(buffer, encoding, filename) {
  const bytes = Buffer.from(buffer);
  const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const hasLeBom = bytes[0] === 0xff && bytes[1] === 0xfe;
  const hasBeBom = bytes[0] === 0xfe && bytes[1] === 0xff;
  const automatic = encoding === 'auto';
  let selected = encoding;
  if (automatic) selected = hasUtf8Bom ? 'utf8-bom' : hasLeBom ? 'utf16le' : hasBeBom ? 'utf16be' : 'utf8';

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
    throw validationError(filename, 1, 'encoding', 'input is not valid or has uncertain ' + selected);
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
    return text.split(/\r?\n/u).map((line, index) => ({ line: index + 1, value: line.trim() ? parseJsonLine(line, filename, index + 1) : null })).filter((record) => record.value !== null);
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
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; } else quoted = !quoted;
    } else if (character === delimiter && !quoted) { values.push(current); current = ''; } else current += character;
  }
  if (quoted) throw validationError(filename, lineNumber, 'record', 'unterminated quoted field');
  values.push(current);
  return values;
}

function normalizeItemRecord(record, filename, line) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw validationError(filename, line, 'record', 'expected an object');
  const allowed = new Set(['id', 'item_id', 'itemId', 'name', 'canonical_name_zh', 'canonicalNameZh', 'description', 'aliases', 'alias']);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw validationError(filename, line, key, 'unknown field');

  const idValue = record.id ?? record.item_id ?? record.itemId;
  if (typeof idValue !== 'number' && typeof idValue !== 'string') throw validationError(filename, line, 'id', 'invalid item id');
  if (!/^[0-9]+$/u.test(String(idValue).trim())) throw validationError(filename, line, 'id', 'invalid item id');
  const itemId = Number(String(idValue).trim());
  if (!Number.isSafeInteger(itemId) || itemId < 0) throw validationError(filename, line, 'id', 'invalid item id');

  const name = normalizeDisplayText(record.name ?? record.canonical_name_zh ?? record.canonicalNameZh ?? '');
  if (!name) throw validationError(filename, line, 'name', 'empty canonical name');
  if (name.length > MAX_TEXT_LENGTH) throw validationError(filename, line, 'name', 'value is too long');
  const description = normalizeDisplayText(record.description ?? '');
  if (description.length > MAX_TEXT_LENGTH) throw validationError(filename, line, 'description', 'value is too long');

  const aliases = record.aliases ?? record.alias ?? [];
  const aliasList = Array.isArray(aliases) ? aliases : String(aliases).split('|');
  const item = {
    itemId,
    name,
    description,
    aliases: aliasList.map((alias) => normalizeDisplayText(alias)).filter(Boolean).sort(compareCatalogText),
  };
  Object.defineProperties(item, {
    sourceFilename: { value: filename, enumerable: false },
    sourceLine: { value: line, enumerable: false },
  });
  return item;
}


function validateItemSet(items, filename) {
  const ids = new Set();
  const canonicalNames = new Map();
  for (const item of items) {
    const itemFilename = item.sourceFilename ?? filename;
    const itemLine = item.sourceLine ?? 1;
    if (ids.has(item.itemId)) throw validationError(itemFilename, itemLine, 'id', 'duplicate item id');
    ids.add(item.itemId);
    const normalizedName = normalizeCatalogText(item.name);
    if (canonicalNames.has(normalizedName)) throw validationError(itemFilename, itemLine, 'name', 'duplicate canonical name');
    canonicalNames.set(normalizedName, item.itemId);
  }

  const aliases = new Map();
  for (const item of items) {
    const itemFilename = item.sourceFilename ?? filename;
    const itemLine = item.sourceLine ?? 1;
    const seen = new Set();
    for (const alias of item.aliases) {
      const normalized = normalizeCatalogText(alias);
      if (!normalized) throw validationError(itemFilename, itemLine, 'alias', 'empty alias');
      if (seen.has(normalized)) throw validationError(itemFilename, itemLine, 'alias', 'duplicate alias');
      seen.add(normalized);
      const canonicalOwner = canonicalNames.get(normalized);
      if (canonicalOwner !== undefined) {
        throw validationError(itemFilename, itemLine, 'alias', canonicalOwner === item.itemId ? 'duplicate alias' : 'alias collision');
      }
      const existing = aliases.get(normalized);
      if (existing !== undefined && existing !== item.itemId) throw validationError(itemFilename, itemLine, 'alias', 'alias collision');
      aliases.set(normalized, item.itemId);
    }
  }
}
function canonicalCatalog(input) {
  return JSON.stringify([...input.items].sort((left, right) => left.itemId - right.itemId).map((item) => ({
    itemId: item.itemId,
    name: item.name,
    description: item.description,
    aliases: [...item.aliases].sort(compareCatalogText),
  })));
}

function searchableText(item) {
  return [item.name, ...item.aliases, item.description].map(normalizeCatalogText).filter(Boolean).join(' ');
}

function chunkInsert(table, columns, rows, options = {}) {
  const prefix = String(options.insertPrefix ?? 'INSERT') + ' INTO ' + sqlIdentifier(table) + '(' + columns.map(sqlIdentifier).join(',') + ') VALUES ';
  const suffix = options.conflictClause ? ' ' + String(options.conflictClause).trim() : '';
  const statements = [];
  let chunk = [];

  const flush = () => {
    if (chunk.length === 0) return;
    const statement = prefix + chunk.join(',') + suffix;
    assertStatementSize(statement);
    statements.push(statement);
    chunk = [];
  };

  for (const row of rows) {
    const rowSql = '(' + row.map(sqlLiteral).join(',') + ')';
    if (Buffer.byteLength(prefix + rowSql + suffix, 'utf8') > MAX_SQL_STATEMENT_BYTES) {
      throw new Error('generated SQL row exceeds the statement-size budget');
    }
    const candidate = prefix + [...chunk, rowSql].join(',') + suffix;
    if (chunk.length > 0 && Buffer.byteLength(candidate, 'utf8') > MAX_SQL_STATEMENT_BYTES) {
      flush();
    }
    chunk.push(rowSql);
  }
  flush();
  return statements;
}

function chunkDeleteByIds(table, idColumn, ids, where = '') {
  const prefix = 'DELETE FROM ' + sqlIdentifier(table) + ' WHERE ' + (where ? where + ' AND ' : '') + sqlIdentifier(idColumn) + ' IN (';
  const statements = [];
  let chunk = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid delete ID');
    const candidate = prefix + [...chunk, String(id)].join(',') + ')';
    if (chunk.length > 0 && Buffer.byteLength(candidate, 'utf8') > MAX_SQL_STATEMENT_BYTES) {
      const statement = prefix + chunk.join(',') + ')';
      assertStatementSize(statement);
      statements.push(statement);
      chunk = [];
    }
    chunk.push(String(id));
  }
  if (chunk.length > 0) {
    const statement = prefix + chunk.join(',') + ')';
    assertStatementSize(statement);
    statements.push(statement);
  }
  return statements;
}

function sqlIdentifier(value) {
  const identifier = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new Error('invalid SQL identifier');
  return identifier;
}

function assertStatementSize(statement) {
  if (Buffer.byteLength(statement, 'utf8') > MAX_SQL_STATEMENT_BYTES) throw new Error('generated SQL statement exceeds the statement-size budget');
}

function compareCatalogText(left, right) {
  const normalizedLeft = normalizeCatalogText(left);
  const normalizedRight = normalizeCatalogText(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  const rawLeft = String(left);
  const rawRight = String(right);
  return rawLeft < rawRight ? -1 : rawLeft > rawRight ? 1 : 0;
}

function sqlLiteral(value) {
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function validationError(filename, line, field, message) {
  return new Error(String(filename).split(/[\\/]/u).at(-1) + ': line ' + line + ': ' + field + ': ' + message);
}
