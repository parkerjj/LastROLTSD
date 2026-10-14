import { describe, expect, it } from 'vitest';
import { normalizeEmail, parseDisplayName, validatePassword, validatePasswordConfirmation } from '../src/auth/input';
import { AuthFailure } from '../src/auth/types';

describe('account input primitives', () => {
  it.each([
    { label: 'four code points', value: 'abcd', valid: false },
    { label: 'five code points', value: '12345', valid: true },
    { label: '256 code points', value: 'p'.repeat(256), valid: true },
    { label: '257 code points', value: 'p'.repeat(257), valid: false },
  ])('checks password length by code point for $label', ({ value, valid }) => {
    if (valid) expect(validatePassword(value)).toBe(value);
    else expect(() => validatePassword(value)).toThrow(AuthFailure);
  });

  it('allows five emoji and preserves password whitespace', () => {
    const emojiPassword = '😀🚀🧩🦊🌲';
    expect(validatePassword(emojiPassword)).toBe(emojiPassword);
    expect(validatePassword(' 12345 ')).toBe(' 12345 ');
    expect(validatePassword('12345')).toBe('12345');
  });

  it('rejects lone UTF-16 surrogates while preserving valid emoji and U+FFFD passwords', () => {
    expect(() => validatePassword('abcd\uD800')).toThrow(AuthFailure);
    expect(() => validatePassword('abcd\uDC00')).toThrow(AuthFailure);
    expect(validatePassword('😀abcd')).toBe('😀abcd');
    expect(validatePassword('abcd\uFFFD')).toBe('abcd\uFFFD');
  });

  it('rejects a mismatched password confirmation without normalizing either value', () => {
    expect(() => validatePasswordConfirmation(' 12345 ', '12345')).toThrow(AuthFailure);
    expect(validatePasswordConfirmation(' 12345 ', ' 12345 ')).toBe(' 12345 ');
  });

  it('trims display names and enforces the 1–32 code point boundary without uniqueness checks', () => {
    expect(() => parseDisplayName(' \t\n ')).toThrow(AuthFailure);
    expect(parseDisplayName(`  ${'n'.repeat(32)}  `)).toBe('n'.repeat(32));
    expect(() => parseDisplayName('n'.repeat(33))).toThrow(AuthFailure);
    expect(parseDisplayName('波利')).toBe('波利');
    expect(parseDisplayName('波利')).toBe('波利');
  });

  it('normalizes email case and IDN domains while preserving delivery spelling and plus/dot distinctions', () => {
    expect(normalizeEmail('  User@EXAMPLE.COM ').normalized).toBe('user@example.com');
    expect(normalizeEmail('  User@EXAMPLE.COM ').delivery).toBe('User@example.com');
    expect(normalizeEmail('User@BÜCHER.DE')).toEqual({
      delivery: 'User@xn--bcher-kva.de',
      normalized: 'user@xn--bcher-kva.de',
    });
    expect(normalizeEmail('player+tag@example.com').normalized).not.toBe(normalizeEmail('player.tag@example.com').normalized);
  });

  it('rejects control and Unicode line separators in email addresses', () => {
    for (const value of ['bad\r\n@example.com', 'bad@example.com\u2028Bcc:evil@example.com']) {
      expect(() => normalizeEmail(value)).toThrow(AuthFailure);
    }
  });
});
