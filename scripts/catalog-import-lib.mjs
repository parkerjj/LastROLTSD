import { createHash } from 'node:crypto';

export const IMPORTER_VERSION = '1.1.2';
export const MAX_SQL_STATEMENT_BYTES = 90 * 1024;
export const MAX_SQL_STATEMENTS = 45;
export const MAX_ITEMS_PER_TRANSACTION = 256;
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
  let skippedCount = 0;
  const items = [];
  for (const record of records) {
    const item = normalizeItemRecord(record.value, filename, record.line, { allowEmptyName: metadata?.skipEmptyNames === true });
    if (item === null) skippedCount += 1;
    else items.push(item);
  }
  if (items.length === 0) throw validationError(filename, 1, 'record', 'input contains no named records');
  validateItemSet(items, filename);
  return { kind: 'items', items, skippedCount };
}

export function parseDescriptionInput(buffer, metadata) {
  const filename = String(metadata?.filename ?? 'descriptions');
  const kind = metadata?.kind ?? 'item-descriptions';
  if (kind !== 'item-descriptions') throw validationError(filename, 1, 'kind', 'expected item-descriptions input');
  const text = decodeInput(buffer, metadata?.encoding ?? 'auto', filename);
  const records = parseDescriptionRecords(text, filename);
  if (records.length === 0) throw validationError(filename, 1, 'record', 'input contains no description records');

  const descriptions = new Map();
  let duplicateCount = 0;
  for (const record of records) {
    const itemId = parseItemId(record.id, filename, record.line);
    const description = normalizeDescriptionText(record.body.join('\n'));
    if (description.length > MAX_TEXT_LENGTH) throw validationError(filename, record.line, 'description', 'value is too long');
    if (descriptions.has(itemId)) duplicateCount += 1;
    const value = { itemId, description };
    Object.defineProperties(value, {
      sourceFilename: { value: filename, enumerable: false },
      sourceLine: { value: record.line, enumerable: false },
    });
    descriptions.set(itemId, value);
  }
  return {
    kind: 'item-descriptions',
    descriptions: [...descriptions.values()].sort((left, right) => left.itemId - right.itemId),
    recordCount: records.length,
    duplicateCount,
  };
}

export function mergeCatalogInputs(inputs) {
  const items = inputs.flatMap((input) => input.items);
  if (items.length === 0) throw validationError('catalog release', 1, 'record', 'input contains no records');
  validateItemSet(items, 'catalog release');
  return { kind: 'items', items, skippedCount: inputs.reduce((total, input) => total + (input.skippedCount ?? 0), 0) };
}

export function mergeCatalogDescriptions(input, descriptionInput) {
  if (!descriptionInput || descriptionInput.kind !== 'item-descriptions') throw new TypeError('expected parsed item descriptions');
  const itemIds = new Set(input.items.map((item) => item.itemId));
  for (const description of descriptionInput.descriptions) {
    if (!itemIds.has(description.itemId)) {
      throw validationError(description.sourceFilename ?? 'descriptions', description.sourceLine ?? 1, 'id', 'unknown item id');
    }
  }
  const descriptions = new Map(descriptionInput.descriptions.map((description) => [description.itemId, description.description]));
  const items = input.items.map((item) => {
    const merged = { ...item, description: descriptions.has(item.itemId) ? descriptions.get(item.itemId) : item.description };
    Object.defineProperties(merged, {
      sourceFilename: { value: item.sourceFilename, enumerable: false },
      sourceLine: { value: item.sourceLine, enumerable: false },
    });
    return merged;
  });
  return {
    kind: 'items',
    items,
    skippedCount: input.skippedCount ?? 0,
    descriptionCount: descriptionInput.descriptions.length,
    descriptionRecordCount: descriptionInput.recordCount,
    descriptionDuplicateCount: descriptionInput.duplicateCount,
  };
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
    descriptionCount: Number(options.descriptionCount ?? input.descriptionCount ?? input.items.filter((item) => item.description).length),
    descriptionRecordCount: Number(options.descriptionRecordCount ?? input.descriptionRecordCount ?? input.items.filter((item) => item.description).length),
    descriptionDuplicateCount: Number(options.descriptionDuplicateCount ?? input.descriptionDuplicateCount ?? 0),
    skippedCount: Number(options.skippedCount ?? input.skippedCount ?? 0),
    errorCount: 0,
  };
}

export function renderCatalogSql(input, options = {}) {
  return renderCatalogSqlParts(input, options).join('');
}

export function renderCatalogSqlParts(input, options = {}) {
  const version = String(options.version ?? 'unversioned');
  const dataChecksum = String(options.checksum ?? catalogChecksum(input));
  const outputChecksum = String(options.outputChecksum ?? dataChecksum);
  const items = [...input.items].sort((left, right) => left.itemId - right.itemId);
  if (items.length === 0) throw new Error('catalog release contains no items');
  const totals = {
    itemCount: items.length,
    aliasCount: items.reduce((total, item) => total + item.aliases.length, 0),
  };
  const parts = [];
  const maxBodyStatements = MAX_SQL_STATEMENTS - 1 - 2;
  let offset = 0;
  while (offset < items.length) {
    let size = Math.min(MAX_ITEMS_PER_TRANSACTION, items.length - offset);
    let preparedBatch;
    let body;
    while (true) {
      preparedBatch = items.slice(offset, offset + size).map((item) => prepareCatalogItem(item, version));
      body = renderCatalogStatements(preparedBatch, { version, dataChecksum, outputChecksum, totals }, false);
      if (body.length <= maxBodyStatements) break;
      if (size === 1) throw new Error('one catalog item exceeds the statement budget');
      size = Math.max(1, Math.floor(size / 2));
    }
    if (offset + size === items.length) {
      body = renderCatalogStatements(preparedBatch, { version, dataChecksum, outputChecksum, totals }, true);
    }
    const statements = ['PRAGMA foreign_keys = ON', ...body];
    if (statements.length > MAX_SQL_STATEMENTS) throw new Error('generated SQL exceeds the statement budget; split the catalog release');
    parts.push(statements.map((statement) => statement + ';').join('\n') + '\n');
    offset += size;
  }
  return parts;
}

function prepareCatalogItem(item, version) {
  const seen = new Set();
  for (const text of [item.name, ...item.aliases, item.description]) {
    const codePoints = [...normalizeCatalogText(text)];
    for (let width = 1; width <= 2; width += 1) {
      for (let index = 0; index + width <= codePoints.length; index += 1) {
        seen.add(codePoints.slice(index, index + width).join(''));
      }
    }
  }
  return {
    itemId: item.itemId,
    catalogRow: [item.itemId, item.name, normalizeCatalogText(item.name), item.description, version, 0],
    aliasRows: item.aliases.map((alias) => [item.itemId, alias, normalizeCatalogText(alias), 'approved', version, 0]),
    ftsRow: [item.itemId, searchableText(item)],
    tokenRows: [...seen].sort(compareCatalogText).map((token) => ['item', item.itemId, token]),
  };
}

function renderCatalogStatements(batch, options, includeMetadata) {
  const { version, dataChecksum, outputChecksum, totals } = options;
  const itemIds = batch.map((entry) => entry.itemId);
  const statements = [];
  statements.push(...chunkDeleteByIds('search_short_tokens', 'scope_id', itemIds, "scope_type='item'"));
  statements.push(...chunkDeleteByIds('item_search_fts', 'rowid', itemIds));
  statements.push(...chunkDeleteByIds('item_aliases', 'item_id', itemIds));
  statements.push(...chunkInsert(
    'item_catalog',
    ['item_id', 'canonical_name_zh', 'name_normalized', 'description', 'data_version', 'updated_at'],
    batch.map((entry) => entry.catalogRow),
    { conflictClause: 'ON CONFLICT(item_id) DO UPDATE SET canonical_name_zh=excluded.canonical_name_zh,name_normalized=excluded.name_normalized,description=excluded.description,data_version=excluded.data_version,updated_at=excluded.updated_at' },
  ));
  const aliases = batch.flatMap((entry) => entry.aliasRows)
    .sort((left, right) => Number(left[0]) - Number(right[0]) || compareCatalogText(String(left[2]), String(right[2])));
  statements.push(...chunkInsert(
    'item_aliases',
    ['item_id', 'alias', 'alias_normalized', 'alias_kind', 'data_version', 'updated_at'],
    aliases,
    { insertPrefix: 'INSERT' },
  ));
  statements.push(...chunkInsert('item_search_fts', ['rowid', 'item_id', 'text'], batch.map((entry) => [entry.itemId, ...entry.ftsRow])));
  const tokenRows = batch.flatMap((entry) => entry.tokenRows);
  statements.push(...chunkJsonInsertIgnore('search_short_tokens', ['scope_type', 'scope_id', 'token'], tokenRows));
  if (includeMetadata) {
    statements.push(
      'INSERT INTO catalog_versions(version,checksum,imported_at,item_count,alias_count,option_count,importer_version,output_checksum) VALUES (' +
        [version, dataChecksum, 0, totals.itemCount, totals.aliasCount, 0, IMPORTER_VERSION, outputChecksum].map(sqlLiteral).join(',') +
        ') ON CONFLICT(version) DO UPDATE SET checksum=excluded.checksum, imported_at=excluded.imported_at, item_count=excluded.item_count, alias_count=excluded.alias_count, option_count=excluded.option_count, importer_version=excluded.importer_version, output_checksum=excluded.output_checksum',
    );
    statements.push('INSERT INTO catalog_state(id,current_version,updated_at) VALUES (1,' + sqlLiteral(version) + ',0) ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version,updated_at=excluded.updated_at');
  }
  return statements;
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

function parseDescriptionRecords(text, filename) {
  const records = [];
  let current = null;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (current === null) {
      if (!line || line.startsWith('//')) continue;
      const header = /^([0-9]+)#(.*)$/u.exec(line);
      if (!header) throw validationError(filename, lineNumber, 'separator', 'expected item description header id#');
      if (header[2].includes('#')) throw validationError(filename, lineNumber, 'separator', 'expected item description header id# or id#text');
      current = { id: header[1], line: lineNumber, body: header[2] ? [header[2]] : [] };
    } else if (line === '#') {
      records.push(current);
      current = null;
    } else {
      current.body.push(line);
    }
  }
  if (current !== null) throw validationError(filename, current.line, 'separator', 'unterminated item description block');
  return records;
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

function normalizeItemRecord(record, filename, line, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw validationError(filename, line, 'record', 'expected an object');
  const allowed = new Set(['id', 'item_id', 'itemId', 'name', 'canonical_name_zh', 'canonicalNameZh', 'description', 'aliases', 'alias']);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw validationError(filename, line, key, 'unknown field');

  const idValue = record.id ?? record.item_id ?? record.itemId;
  const itemId = parseItemId(idValue, filename, line);

  const name = normalizeDisplayText(record.name ?? record.canonical_name_zh ?? record.canonicalNameZh ?? '');
  if (!name) {
    if (options.allowEmptyName === true) return null;
    throw validationError(filename, line, 'name', 'empty canonical name');
  }
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

function parseItemId(value, filename, line) {
  if (typeof value !== 'number' && typeof value !== 'string') throw validationError(filename, line, 'id', 'invalid item id');
  if (!/^[0-9]+$/u.test(String(value).trim())) throw validationError(filename, line, 'id', 'invalid item id');
  const itemId = Number(String(value).trim());
  if (!Number.isSafeInteger(itemId) || itemId < 0) throw validationError(filename, line, 'id', 'invalid item id');
  return itemId;
}

function normalizeDescriptionText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/gu, '\n').replace(/^(?:[ \t]*\n)+/u, '').replace(/(?:\n[ \t]*)+$/u, '');
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
    const owners = canonicalNames.get(normalizedName) ?? new Set();
    owners.add(item.itemId);
    canonicalNames.set(normalizedName, owners);
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
      const canonicalOwners = canonicalNames.get(normalized);
      if (canonicalOwners !== undefined) {
        throw validationError(itemFilename, itemLine, 'alias', canonicalOwners.has(item.itemId) ? 'duplicate alias' : 'alias collision');
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

function chunkJsonInsertIgnore(table, columns, rows) {
  const prefix = 'INSERT OR IGNORE INTO ' + sqlIdentifier(table) + '(' + columns.map(sqlIdentifier).join(',') + ') SELECT ' + columns.map((_, index) => "json_extract(value, '$[" + index + "]')").join(',') + ' FROM json_each(';
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  const statements = [];
  let chunkRows = [];
  let chunkBytes = 1;
  let chunkQuoteCount = 0;

  const flush = () => {
    if (chunkRows.length === 0) return;
    const statement = prefix + sqlLiteral('[' + chunkRows.join(',') + ']') + ')';
    assertStatementSize(statement);
    statements.push(statement);
    chunkRows = [];
    chunkBytes = 1;
    chunkQuoteCount = 0;
  };

  for (const row of rows) {
    const rowJson = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(rowJson, 'utf8');
    const rowQuoteCount = [...rowJson].reduce((count, character) => count + (character === "'" ? 1 : 0), 0);
    const commaBytes = chunkRows.length === 0 ? 0 : 1;
    const candidateBytes = prefixBytes + chunkBytes + commaBytes + rowBytes + 1 + chunkQuoteCount + rowQuoteCount + 3;
    if (chunkRows.length > 0 && candidateBytes > MAX_SQL_STATEMENT_BYTES) flush();
    const singleBytes = prefixBytes + rowBytes + rowQuoteCount + 5;
    if (singleBytes > MAX_SQL_STATEMENT_BYTES) throw new Error('generated JSON row exceeds the statement-size budget');
    chunkRows.push(rowJson);
    chunkBytes += commaBytes + rowBytes;
    chunkQuoteCount += rowQuoteCount;
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
