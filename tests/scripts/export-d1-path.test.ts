import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { prepareD1DumpOutput } from '../../scripts/d1-export-path.mjs';

describe('D1 export output path', () => {
  it('creates a missing parent directory before Wrangler writes the dump', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lastroweb-d1-export-'));
    const output = join(directory, 'nested', 'production.sql');
    try {
      await prepareD1DumpOutput(output);
      expect((await stat(join(directory, 'nested'))).isDirectory()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
