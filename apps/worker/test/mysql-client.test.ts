import { describe, expect, it } from 'vitest';
import { chunkRows, makePlaceholders, parseMysqlUrl } from '../src/db/mysql-client';

describe('mysql client helpers', () => {
  it('parses a mysql connection URL without exposing credentials', () => {
    expect(parseMysqlUrl('mysql://user:secret@example.com:3307/lastro?ssl=true')).toEqual({
      host: 'example.com',
      port: 3307,
      user: 'user',
      password: 'secret',
      database: 'lastro',
      ssl: true,
    });
  });

  it('decodes URL-encoded credentials and rejects out-of-range ports without exposing them', () => {
    expect(parseMysqlUrl('mysql://alice:p%40ss@db.test:3306/app')).toMatchObject({ user: 'alice', password: 'p@ss' });
    expect(() => parseMysqlUrl('mysql://alice:p%40ss@db.test:70000/app'))
      .toThrow('MYSQL_URL port must be between 1 and 65535');
    expect(() => parseMysqlUrl('mysql://alice:p%40ss@db.test:70000/app'))
      .not.toThrow('p%40ss');
  });

  it('only accepts explicit supported SSL options', () => {
    expect(parseMysqlUrl('mysql://user@example.test/app?ssl=0').ssl).toBe(false);
    expect(() => parseMysqlUrl('mysql://user@example.test/app?ssl=maybe')).toThrow('MYSQL_URL ssl must be true, false, 1, or 0');
  });

  it('creates only trusted SQL placeholder structure and bounded chunks', () => {
    expect(makePlaceholders(3, 2)).toBe('(?, ?), (?, ?), (?, ?)');
    expect(chunkRows(Array.from({ length: 1_000 }), 3, 600)).toHaveLength(5);
    expect(() => makePlaceholders(1, 0)).toThrow('row width must be a positive integer');
    expect(() => chunkRows([1], 2, 1)).toThrow('maximum bound values must be at least the row width');
  });
});
