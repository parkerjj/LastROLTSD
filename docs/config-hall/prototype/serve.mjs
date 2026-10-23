import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/u, '');
const publicRoot = fileURLToPath(new URL('../../../apps/web/public/', import.meta.url)).replace(/[\\/]$/u, '');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const base = pathname.startsWith('/ui/') ? publicRoot : root;
    const target = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(base + sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const bytes = await readFile(target);
    response.writeHead(200, {
      'content-type': types[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
}).listen(4173, '127.0.0.1', () => {
  console.log('KE hall prototype: http://127.0.0.1:4173/');
});
