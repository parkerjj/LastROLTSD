import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('has no D1 runtime dependency', () => {
  const root = resolve('apps/worker/src');
  const files = readdirSync(root, { recursive: true }).map(String).filter((file) => file.endsWith('.ts'));
  for (const file of files) expect(readFileSync(resolve(root, file), 'utf8'), file).not.toMatch(/D1Database|createD1Repository|d1-meter|d1-repository/);
});
