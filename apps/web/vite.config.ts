import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const apiOrigin = process.env.LASTRO_API_ORIGIN ?? 'http://127.0.0.1:8787';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** node_modules 可能软链到仓库外，Vite 默认不提供根目录外的文件，需放行真实路径（图标字体）。 */
function realNodeModules(): string[] {
  try {
    return [fs.realpathSync(path.resolve(projectRoot, '../../node_modules'))];
  } catch {
    return [];
  }
}

export default defineConfig({
  publicDir: 'public',
  build: { emptyOutDir: false },
  server: {
    fs: {
      allow: [projectRoot, ...realNodeModules()],
    },
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
});

