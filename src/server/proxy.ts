// Tiny loopback proxy used by scripts/start.sh: serves the built UI on the web port and
// forwards API/contract paths to the API process, so one browser origin serves both.
import http from 'node:http';
import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CSP as COMPILER_CSP } from '../../wings/compiler/server/static.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(ROOT, 'web', 'dist');
const webPort = Number(process.env.WITNESS_PORT ?? 5720);
const apiPort = Number(process.env.API_PORT ?? 5721);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

http.createServer((req, res) => {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { res.writeHead(421).end(); return; }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (/^\/(api\/|engine\/|health$|capabilities$|runs(\/|$))/.test(url.pathname)) {
    const p = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers /* host kept: the API's origin checks compare Origin with the browser-facing host */ }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    p.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"api unavailable"}'); });
    req.pipe(p);
    return;
  }
  let rel: string;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('bad URL'); return; }
  const compilerPage = rel === '/compiler' || rel.startsWith('/compiler/');
  if (rel === '/' || !path.extname(rel)) rel = compilerPage ? '/compiler/index.html' : '/index.html';
  const file = path.resolve(dist, '.' + rel);
  if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': compilerPage ? COMPILER_CSP : "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  createReadStream(file).pipe(res);
}).listen(webPort, '127.0.0.1', () => console.log(`THE IMPOSSIBLE COMPILER WORKS UI on http://127.0.0.1:${webPort} (API ${apiPort})`));
