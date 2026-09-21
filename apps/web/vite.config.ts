import { defineConfig } from 'vite';

const apiOrigin = process.env.LASTRO_API_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  publicDir: 'public',
  build: { emptyOutDir: false },
  server: {
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
});
