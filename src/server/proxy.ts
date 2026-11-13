// Tiny loopback proxy used by scripts/start.sh: serves the built UI on the web port and
// forwards API/contract paths to the API process, so one browser origin serves both.
import http from 'node:http';
import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(ROOT, 'web', 'dist');
const webPort = Number(process.env.WITNESS_PORT ?? 5720);
const apiPort = Number(process.env.API_PORT ?? 5721);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer((req, res) => {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { res.writeHead(421).end(); return; }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (/^\/(api\/|health$|capabilities$|runs(\/|$))/.test(url.pathname)) {
    const p = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    p.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"api unavailable"}'); });
    req.pipe(p);
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(dist, '.' + rel);
  if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  createReadStream(file).pipe(res);
}).listen(webPort, '127.0.0.1', () => console.log(`impossible-witness UI on http://127.0.0.1:${webPort} (API ${apiPort})`));
