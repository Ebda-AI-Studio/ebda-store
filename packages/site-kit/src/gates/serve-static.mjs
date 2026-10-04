// Minimal static server for the exported site (out/), used by the a11y/Lighthouse gates.
// Mirrors Cloudflare Workers Static Assets `auto-trailing-slash` behaviour.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function startServer(root, port = 0) {
  const base = path.resolve(root);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let rel = decodeURIComponent(url.pathname);
    let file = path.join(base, rel);
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      /* fall through to 404 */
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      const body = await readFile(path.join(base, '404.html')).catch(() => 'not found');
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root = 'out', port = '3005'] = process.argv.slice(2);
  const s = await startServer(root, Number(port));
  console.log(`serving ${root} on http://127.0.0.1:${s.address().port}`);
}
