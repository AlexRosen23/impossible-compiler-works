// PAPER TIGER API server: 127.0.0.1 only. PT_PORT (default 5580), PT_DB (default var/paper-tiger.sqlite).
// With PT_STATIC=1 it also serves the built IDE from dist/ (npm run build first).
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.ts';
import { openDb } from './db.ts';
import { serveStatic } from './static.ts';

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
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const isApi = path === '/health' || path === '/capabilities' || path === '/runs' || path.startsWith('/runs/') || path.startsWith('/api/');
  if (isApi || process.env.PT_STATIC !== '1') { void api(req, res); return; }
  serveStatic(path, res, DIST);
});
// Slow clients cannot hold the server: headers within 15 s, a whole request within 30 s, at most 64 sockets.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.maxConnections = 64;
server.listen(PORT, '127.0.0.1', () => console.log(`PAPER TIGER API on http://127.0.0.1:${PORT} (db ${dbPath})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { server.close(); void api.close().then(() => process.exit(0)); });
