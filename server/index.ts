// PAPER TIGER API server: 127.0.0.1 only. PT_PORT (default 5580), PT_DB (default var/paper-tiger.sqlite).
// With PT_STATIC=1 it also serves the built IDE from dist/ (npm run build first).
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.ts';
import { openDb } from './db.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PT_PORT ?? 5580);
const dbPath = process.env.PT_DB ?? join(ROOT, 'var', 'paper-tiger.sqlite');
mkdirSync(join(ROOT, 'var'), { recursive: true });

function gitCommit(): string | null {
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: ') ? readFileSync(join(ROOT, '.git', head.slice(5)), 'utf8').trim() : head;
  } catch { return null; }
}

const api = createHandler({ db: openDb(dbPath), root: ROOT, commit: gitCommit(), startedAt: Date.now() });
const DIST = resolve(ROOT, 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const isApi = path === '/health' || path === '/capabilities' || path === '/runs' || path.startsWith('/runs/') || path.startsWith('/api/');
  if (isApi || process.env.PT_STATIC !== '1') { void api(req, res); return; }
  // Static files: resolved inside dist/ only; anything else falls back to index.html (single-page app).
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
  let file = resolve(DIST, rel);
  if (!file.startsWith(DIST + '/') || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(readFileSync(file));
});
server.listen(PORT, '127.0.0.1', () => console.log(`PAPER TIGER API on http://127.0.0.1:${PORT} (db ${dbPath})`));
