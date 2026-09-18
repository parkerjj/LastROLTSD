import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('web production build', () => {
  it('emits the SPA entry document', () => {
    expect(existsSync(resolve(process.cwd(), 'apps/web/dist/index.html'))).toBe(true);
  });
});
