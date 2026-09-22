import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function prepareD1DumpOutput(outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
}
