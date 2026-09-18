import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@lastroweb/protocol': resolve(process.cwd(), 'packages/protocol/src/index.ts') } },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'test-results'],
  },
});
