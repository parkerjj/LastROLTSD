import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

const input = option('--input');
const dryRun = process.argv.includes('--dry-run');
const replaceExisting = process.argv.includes('--replace-existing');

let stage = 'validating_input';
try {
  if (!input) throw new Error('usage: --input <mysql.sql> [--dry-run]');
  if (replaceExisting && !process.argv.includes('--confirm-replace-existing')) throw new Error('--replace-existing requires --confirm-replace-existing');
  const config = parseMysqlUrl(requireMysqlUrl());
  stage = 'reading_input';
  const statements = await readStatements(resolve(input));
  if (statements.some((statement) => /\bDROP\s+DATABASE\b/iu.test(statement))) throw new Error('DROP DATABASE is never allowed');
  stage = 'opening_connection';
  const connection = await mysql.createConnection(config);
  try {
    stage = 'checking_target';
    const [databaseRows] = await connection.execute('SELECT DATABASE() AS database_name');
    if (!Array.isArray(databaseRows) || databaseRows[0]?.database_name === null) throw new Error('target database is not selected');
    if (dryRun) {
      process.stdout.write(`[mysql-import] dry run: ${statements.length} statements validated\n`);
    } else {
      for (const group of chunks(statements, 250)) {
        await connection.beginTransaction();
        try {
          for (const statement of group) await connection.execute(statement);
          await connection.commit();
        } catch {
          await connection.rollback();
          throw new Error('import failed');
        }
      }
      process.stdout.write(`[mysql-import] import completed: ${statements.length} statements\n`);
    }
  } finally {
    await connection.end();
  }
} catch (error) {
  process.stderr.write(`[mysql-import] ${safeError(error, stage)}\n`);
  process.exitCode = 1;
}

async function readStatements(path) {
  await access(path);
  const lexer = new MysqlStatementLexer();
  const statements = [];
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) statements.push(...lexer.feed(chunk));
  statements.push(...lexer.finish());
  return statements;
}

class MysqlStatementLexer {
  #current = '';
  #carry = '';
  #quote = null;
  feed(chunk) {
    const input = this.#carry + chunk;
    if (input.length < 2) { this.#carry = input; return []; }
    this.#carry = input.at(-1) ?? '';
    return this.#scan(input);
  }
  finish() {
    const statements = this.#scan(this.#carry + '\0');
    if (this.#quote !== null) throw new Error('unterminated SQL string');
    if (this.#current.trim() !== '') statements.push(this.#current.trim());
    return statements;
  }
  #scan(input) {
    const statements = [];
    for (let index = 0; index < input.length - 1; index += 1) {
      const character = input[index];
      const next = input[index + 1];
      this.#current += character;
      if (this.#quote !== null) {
        if (character === this.#quote && next === this.#quote) { this.#current += next; index += 1; }
        else if (character === this.#quote) this.#quote = null;
      } else if (character === "'" || character === '"' || character === '`') {
        this.#quote = character;
      } else if (character === ';') {
        const statement = this.#current.slice(0, -1).trim();
        if (statement !== '') statements.push(statement);
        this.#current = '';
      }
    }
    return statements;
  }
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function requireMysqlUrl() {
  if (!process.env.MYSQL_URL) throw new Error('MYSQL_URL is required');
  return process.env.MYSQL_URL;
}

function parseMysqlUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'mysql:' || !url.hostname || !url.username || url.pathname.length < 2) throw new Error();
    return { host: url.hostname, port: url.port === '' ? 3306 : Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), ...(url.searchParams.get('ssl') === 'true' || url.searchParams.get('ssl') === '1' ? { ssl: { rejectUnauthorized: true } } : {}) };
  } catch {
    throw new Error('MYSQL_URL must be a valid mysql URL');
  }
}

function option(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
function safeError(error, failedStage) {
  if (error instanceof Error && /^(usage:|MYSQL_URL|--replace-existing|DROP DATABASE|target database|unterminated SQL|string|import failed)/u.test(error.message)) return error.message;
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
  if (code && /^(ECONN|EHOST|ENOTFOUND|ETIMEDOUT|EPIPE|ECONNRESET)/u.test(code)) return `database connection failed (${code})`;
  if (code && /^ER_/u.test(code)) return `import database error (${code})`;
  if (code === 'ENOENT') return 'input SQL file is unavailable';
  return `import failed during ${failedStage}`;
}
