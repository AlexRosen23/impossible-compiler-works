// Static file serving for the built IDE (PT_STATIC=1). Paths are decoded defensively (malformed percent-encoding
// is a 400, never an exception), resolved inside `dist` only, and anything else falls back to index.html.
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
// The Constellation (its world "The Compiler Works") shows this IDE in a frame from its own loopback origins, API 4520
// and Vite 4521; no other page may frame it, so clickjacking from the open web stays impossible.
export const FRAME_ANCESTORS = ['http://127.0.0.1:4520', 'http://127.0.0.1:4521', 'http://localhost:4520', 'http://localhost:4521'];
export const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${FRAME_ANCESTORS.join(' ')}`;

export function serveStatic(urlPath: string, res: ServerResponse, distDir: string): void {
  const dist = resolve(distDir);
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('bad URL'); return; }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  let file = resolve(dist, rel);
  if (!file.startsWith(dist + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(readFileSync(file));
}
