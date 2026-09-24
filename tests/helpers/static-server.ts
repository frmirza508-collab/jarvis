import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** Minimal SPA static server for built frontends. */
export async function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let file = path.join(root, decodeURIComponent(u.pathname));
    if (!file.startsWith(root)) {
      res.statusCode = 403;
      return res.end();
    }
    try {
      let data: Buffer;
      try {
        data = await readFile(file);
      } catch {
        file = path.join(root, 'index.html');
        data = await readFile(file);
      }
      res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
