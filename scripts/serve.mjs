#!/usr/bin/env node
/* Minimal static server for the demo. Serves the REPO ROOT — not just demo/ — because
   demo/controls.js imports '../src/angular-browser-builder.js'.

   Usage:  npm run serve                # http://127.0.0.1:8137/demo/index.html
           NGB_PORT=9000 npm run serve
*/
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.NGB_PORT ?? 8137);
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let p = join(ROOT, normalize(url));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }
  try {
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(await readFile(p));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404 ' + url);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/demo/index.html`);
});
