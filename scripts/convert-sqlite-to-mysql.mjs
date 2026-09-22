import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function convertSqliteToMysql(source, options = {}) {
  const context = { primaryKeys: new Map(), dataOnly: options.dataOnly === true };
  const lexer = new StatementLexer();
  const output = [];
  const emit = (statement) => {
    const converted = convertStatement(statement, context);
    if (converted !== null) output.push(`${converted};\n`);
  };
  for (const statement of lexer.feed(source)) emit(statement);
  for (const statement of lexer.finish()) emit(statement);
  return output.join('');
}

export async function convertSqliteFile(inputPath, outputPath, options = {}) {
  const context = { primaryKeys: new Map(), dataOnly: options.dataOnly === true };
  const lexer = new StatementLexer();
  await mkdir(dirname(outputPath), { recursive: true });
  const writer = createWriteStream(outputPath, { encoding: 'utf8' });
  try {
    for await (const chunk of createReadStream(inputPath, { encoding: 'utf8' })) {
      for (const statement of lexer.feed(chunk)) await writeStatement(writer, statement, context);
    }
    for (const statement of lexer.finish()) await writeStatement(writer, statement, context);
  } finally {
    await closeWriter(writer);
  }
}

class StatementLexer {
  #current = '';
  #carry = '';
  #line = 1;
  #startLine = 1;
  #quote = null;
  #lineComment = false;
  #blockComment = false;

  feed(chunk) {
    const input = this.#carry + chunk;
    if (input.length < 2) {
      this.#carry = input;
      return [];
    }
    this.#carry = input.at(-1) ?? '';
    return this.#scan(input);
  }

  finish() {
    const statements = this.#scan(this.#carry + '\0');
    this.#carry = '';
    if (this.#quote !== null || this.#blockComment) throw unsupported(this.#startLine);
    if (this.#current.trim() !== '') statements.push({ sql: this.#current, line: this.#startLine });
    this.#current = '';
    return statements;
  }

  #scan(input) {
    const statements = [];
    for (let index = 0; index < input.length - 1; index += 1) {
      const character = input[index];
      const next = input[index + 1];
      if (this.#lineComment) {
        if (character === '\n') {
          this.#lineComment = false;
          this.#line += 1;
          this.#current += '\n';
        }
        continue;
      }
      if (this.#blockComment) {
        if (character === '*' && next === '/') {
          this.#blockComment = false;
          index += 1;
        } else if (character === '\n') {
          this.#line += 1;
        }
        continue;
      }
      if (this.#quote !== null) {
        this.#current += character;
        if (character === this.#quote && next === this.#quote) {
          this.#current += next;
          index += 1;
        } else if (character === this.#quote) {
          this.#quote = null;
        }
        if (character === '\n') this.#line += 1;
        continue;
      }
      if (character === '-' && next === '-') {
        this.#lineComment = true;
        this.#current += ' ';
        index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        this.#blockComment = true;
        this.#current += ' ';
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        this.#quote = character;
        this.#current += character;
        continue;
      }
      if (character === ';') {
        if (this.#current.trim() !== '') statements.push({ sql: this.#current, line: this.#startLine });
        this.#current = '';
        this.#startLine = this.#line;
        continue;
      }
      this.#current += character;
      if (character === '\n') {
        this.#line += 1;
        if (this.#current.trim() === '') this.#startLine = this.#line;
      }
    }
    return statements;
  }
}

function convertStatement(statement, context) {
  const sql = statement.sql.trim();
  if (sql === '') return null;
  if (/^(?:PRAGMA|BEGIN(?:\s+TRANSACTION)?|COMMIT|ROLLBACK|VACUUM|ANALYZE)\b/iu.test(sql)) return null;
  if (/\b(?:CREATE\s+VIRTUAL\s+TABLE|CREATE\s+TRIGGER|ATTACH|DETACH|REINDEX)\b/iu.test(sql)) throw unsupported(statement.line);
  if (/\b(?:json_each|sqlite_master|sqlite_sequence)\b/iu.test(sql)) {
    if (/^(?:INSERT|DELETE|UPDATE)\b/iu.test(sql)) return null;
    throw unsupported(statement.line);
  }
  if (/\bON\s+CONFLICT\b/iu.test(sql) && !/^INSERT\b/iu.test(sql)) throw unsupported(statement.line);
  if (/\bUPDATE\b[\s\S]*\bFROM\b/iu.test(sql) || /\|\|/u.test(sql)) throw unsupported(statement.line);

  if (/^CREATE\s+TABLE\b/iu.test(sql)) return convertCreateTable(sql, statement.line, context);
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu.test(sql)) return convertIndex(sql, statement.line, context);
  if (/^INSERT\b/iu.test(sql)) return convertInsert(sql, statement.line, context);
  if (/^DELETE\s+FROM\s+(?:`|"|\[)?sqlite_sequence/iu.test(sql)) return null;
  throw unsupported(statement.line);
}

function convertCreateTable(sql, line, context) {
  const table = tableName(sql, /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/iu);
  if (!table) throw unsupported(line);
  const primaryKey = primaryKeyName(sql);
  if (primaryKey) context.primaryKeys.set(table, primaryKey);
  if (context.dataOnly) return null;

  let converted = sql
    .replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/iu, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/\s+WITHOUT\s+ROWID\s*$/iu, '')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/iu, 'BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\b/iu, 'BIGINT UNSIGNED PRIMARY KEY')
    .replace(/\bTEXT\s+PRIMARY\s+KEY\b/iu, 'VARCHAR(191) PRIMARY KEY')
    .replace(/\bAUTOINCREMENT\b/iu, 'AUTO_INCREMENT')
    .replace(/\bINTEGER\b/giu, 'BIGINT')
    .replace(/\bTEXT\b/giu, 'VARCHAR(191)')
    .replace(/\b(shop_ids_json|response_json)\s+VARCHAR\(191\)/giu, '$1 MEDIUMTEXT')
    .replace(/\b(shop_ids_json|response_json)\s+MEDIUMTEXT(\s+(?:NOT\s+NULL|NULL))?\s+DEFAULT\s+'(?:''|[^'])*'/giu, '$1 MEDIUMTEXT$2')
    .replace(/\b(vendor_name_normalized|title_normalized)\s+VARCHAR\(191\)/giu, '$1 VARCHAR(128)')
    .replace(/\bmap_name\s+VARCHAR\(191\)/giu, 'map_name VARCHAR(64)')
    .replace(/\bshop_type\s+VARCHAR\(191\)/giu, 'shop_type VARCHAR(4)')
    .replace(/\b(status|close_reason|event_type|reason|snapshot_mode)\s+VARCHAR\(191\)/giu, '$1 VARCHAR(32)')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*_id|id)\s+BIGINT(?!\s+UNSIGNED)\b/gu, '$1 BIGINT UNSIGNED')
    .replace(/\bjson_valid\s*\(/giu, 'JSON_VALID(')
    .replace(/"([^"\n]+)"/gu, '`$1`');
  if (/\bWITHOUT\s+ROWID\b|\bAUTOINCREMENT\b/iu.test(converted)) throw unsupported(line);
  return `${converted} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

function convertIndex(sql, line, context) {
  if (context.dataOnly) return null;
  let converted = sql.replace(/"([^"\n]+)"/gu, '`$1`');
  const partial = /\s+WHERE\s+status\s*=\s*'active'\s*$/iu.test(converted);
  if (/\s+WHERE\s+/iu.test(converted) && !partial) throw unsupported(line);
  if (partial) {
    converted = converted.replace(/\s+WHERE\s+status\s*=\s*'active'\s*$/iu, '');
    converted = converted.replace(/\(([^()]+)\)\s*$/u, (_match, columns) => `(status, ${columns})`);
  }
  return converted;
}

function convertInsert(sql, line, context) {
  const table = tableName(sql, /^INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+/iu);
  if (!table) throw unsupported(line);
  if (context.dataOnly && table.toLowerCase() === 'd1_migrations') return null;
  const primaryKey = context.primaryKeys.get(table) ?? conflictTarget(sql);
  const unquoted = sql.replace(/"([^"\n]+)"/gu, '`$1`');
  if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+/iu.test(unquoted)) {
    return unquoted.replace(/^INSERT\s+OR\s+REPLACE\s+INTO\s+/iu, 'REPLACE INTO ');
  }
  if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+/iu.test(unquoted)) {
    if (!primaryKey) throw unsupported(line);
    return `${unquoted.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\s+/iu, 'INSERT INTO ')} ON DUPLICATE KEY UPDATE ${primaryKey}=${primaryKey}`;
  }
  if (/\bON\s+CONFLICT\b/iu.test(unquoted)) {
    if (!primaryKey) throw unsupported(line);
    if (/\bDO\s+NOTHING\s*$/iu.test(unquoted)) {
      const conflictIndex = unquoted.toUpperCase().lastIndexOf(' ON CONFLICT');
      if (conflictIndex === -1) throw unsupported(line);
      return `${unquoted.slice(0, conflictIndex)} ON DUPLICATE KEY UPDATE ${primaryKey}=${primaryKey}`;
    }
    if (/\bON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+UPDATE\s+SET\s+/iu.test(unquoted)) {
      return unquoted
        .replace(/\s+ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+UPDATE\s+SET\s+/iu, ' ON DUPLICATE KEY UPDATE ')
        .replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)/giu, 'VALUES($1)');
    }
    throw unsupported(line);
  }
  return unquoted;
}

function tableName(sql, prefix) {
  const rest = sql.replace(prefix, '');
  const match = /^(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/u.exec(rest);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function primaryKeyName(sql) {
  const tablePrimaryKey = /PRIMARY\s+KEY\s*\(\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/iu.exec(sql);
  if (tablePrimaryKey) return tablePrimaryKey[1] ?? tablePrimaryKey[2] ?? tablePrimaryKey[3] ?? tablePrimaryKey[4] ?? null;
  const inlinePrimaryKey = /[,(]\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s+[^,]*?\bPRIMARY\s+KEY\b/iu.exec(sql);
  return inlinePrimaryKey?.[1] ?? inlinePrimaryKey?.[2] ?? inlinePrimaryKey?.[3] ?? inlinePrimaryKey?.[4] ?? null;
}

function conflictTarget(sql) {
  const match = /\bON\s+CONFLICT\s*\(\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/iu.exec(sql);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function unsupported(line) {
  return new Error(`unsupported SQLite statement at line ${line}`);
}

async function writeStatement(writer, statement, context) {
  const converted = convertStatement(statement, context);
  if (converted !== null) await writeWithBackpressure(writer, `${converted};\n`);
}

export function writeWithBackpressure(writer, text) {
  if (writer.write(text)) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const removeListeners = () => {
      writer.removeListener('drain', onDrain);
      writer.removeListener('error', onError);
    };
    const onDrain = () => {
      removeListeners();
      resolvePromise();
    };
    const onError = (error) => {
      removeListeners();
      reject(error);
    };
    writer.once('drain', onDrain);
    writer.once('error', onError);
  });
}

function closeWriter(writer) {
  return new Promise((resolvePromise, reject) => {
    writer.once('error', reject);
    writer.end(resolvePromise);
  });
}

async function main() {
  const input = option('--input');
  const output = option('--output');
  if (!input || !output) throw new Error('usage: --input <sqlite.sql> --output <mysql.sql> [--data-only]');
  await convertSqliteFile(resolve(input), resolve(output), { dataOnly: process.argv.includes('--data-only') });
  process.stdout.write('[sqlite-to-mysql] conversion completed\n');
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[sqlite-to-mysql] ${error instanceof Error ? error.message : 'conversion failed'}\n`);
    process.exitCode = 1;
  });
}
