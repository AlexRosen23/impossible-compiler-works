import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveStatic } from '../server/static.ts';

let server: Server;
let port = 0;
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-static-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html>INDEX');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, 'secret.txt'), 'SECRET');
  server = createServer((req, res) => serveStatic((req.url ?? '/').split('?')[0], res, dist));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

const get = (path: string) => new Promise<{ status: number; body: string; csp?: string }>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode!, body, csp: res.headers['content-security-policy'] as string | undefined }));
  }).on('error', reject).end();
});

describe('static IDE serving', () => {
  it('serves files inside dist with a strict CSP, and index.html for anything else', async () => {
    expect((await get('/assets/app.js')).body).toBe('console.log(1)');
    const idx = await get('/no/such/route');
    expect(idx.body).toBe('<!doctype html>INDEX');
    expect(idx.csp).toMatch(/script-src 'self'/);
  });
  it('may be framed only by the Constellation (127.0.0.1/localhost on 4520 and 4521), never by any other page', async () => {
    const csp = (await get('/')).csp ?? '';
    const ancestors = /frame-ancestors ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/);
    expect(ancestors).toEqual(['http://127.0.0.1:4520', 'http://127.0.0.1:4521', 'http://localhost:4520', 'http://localhost:4521']);
  });
  it('answers malformed percent-encoding with 400 instead of crashing', async () => {
    expect((await get('/%E0%A4%A')).status).toBe(400);
    expect((await get('/assets/app.js')).status).toBe(200);
  });
  it('never serves files outside dist (path traversal)', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt']) {
      expect((await get(p)).body, p).not.toContain('SECRET');
    }
  });
});
