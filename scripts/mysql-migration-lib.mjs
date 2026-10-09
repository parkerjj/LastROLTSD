/**
 * Parse migration SQL incrementally. Input is an iterable of lines (without their
 * trailing newline), so a multi-megabyte data migration never needs to be loaded
 * or split into tens of thousands of statements in memory at once.
 */
export async function* sqlStatements(lines) {
  let statement = '';
  let quote = null;
  let escaped = false;
  let blockComment = false;

  for await (const line of lines) {
    const source = `${line}\n`;
    let start = 0;
    let lineComment = false;

    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      const next = source[i + 1];

      if (blockComment) {
        if (ch === '*' && next === '/') {
          blockComment = false;
          start = ++i + 1;
        }
        continue;
      }
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          if (next === quote) i += 1; // SQL doubled-quote escape
          else quote = null;
        }
        continue;
      }
      // Comments are removed outside string and identifier literals only.
      if ((ch === '-' && next === '-' && (i === 0 || /\s/u.test(source[i - 1])) && (source[i + 2] === undefined || /\s/u.test(source[i + 2])))
          || ch === '#') {
        statement += source.slice(start, i);
        lineComment = true;
        break;
      }
      if (ch === '/' && next === '*') {
        statement += source.slice(start, i);
        blockComment = true;
        start = ++i + 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === ';') {
        statement += source.slice(start, i);
        const sql = statement.trim();
        if (sql) yield sql;
        statement = '';
        start = i + 1;
      }
    }
    if (!lineComment && !blockComment) statement += source.slice(start);
    else if (lineComment) statement += '\n';
  }

  if (quote || blockComment) throw new Error('unterminated SQL quote or comment');
  const trailing = statement.trim();
  if (trailing) yield trailing;
}

/**
 * Combine adjacent INSERT IGNORE statements with identical table and column lists.
 * Only this narrow, idempotent INSERT form is batched: DDL, UPDATE, and INSERTs
 * with other semantics remain in their original order. Both limits are applied
 * before concatenation to stay comfortably below common MySQL packet limits.
 */
export async function* batchStatements(statements, { maxRows = 128, maxBytes = 256 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('invalid SQL batch limits');
  }
  const insertPattern = /^(INSERT\s+IGNORE\s+INTO\s+`?[a-zA-Z0-9_]+`?\s*\([^)]*\)\s+VALUES)\s*(\([\s\S]*\))$/iu;
  let prefix = null;
  let tuples = [];
  let bytes = 0;

  for await (const sql of statements) {
    const match = insertPattern.exec(sql);
    if (!match) {
      if (tuples.length) yield { sql: `${prefix} ${tuples.join(',')}`, rows: tuples.length };
      prefix = null;
      tuples = [];
      bytes = 0;
      yield { sql, rows: 1 };
      continue;
    }
    const [, header, tuple] = match;
    const tupleBytes = Buffer.byteLength(tuple, 'utf8') + 1;
    if (tuples.length && (prefix !== header || tuples.length >= maxRows || bytes + tupleBytes > maxBytes)) {
      yield { sql: `${prefix} ${tuples.join(',')}`, rows: tuples.length };
      tuples = [];
      bytes = 0;
    }
    prefix = header;
    tuples.push(tuple);
    bytes += tupleBytes;
  }
  if (tuples.length) yield { sql: `${prefix} ${tuples.join(',')}`, rows: tuples.length };
}
