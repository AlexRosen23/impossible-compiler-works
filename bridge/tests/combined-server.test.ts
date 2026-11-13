// The combined server: one process, both wings, the new name, and the cross-feature endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/app.ts';

let app: ReturnType<typeof createApp>;
let base = '';
const dir = mkdtempSync(path.join(os.tmpdir(), 'icw-test-'));
before(async () => {
  app = createApp({ dbFile: path.join(dir, 'w.db'), staticDir: null, commit: null });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('/health carries the new name, the former names and both wings', async () => {
  const h = await (await fetch(base + '/health')).json();
  assert.equal(h.name, 'THE IMPOSSIBLE COMPILER WORKS');
  assert.deepEqual(h.formerly, ['Paper Tiger Compiler Works', 'The Impossible Witness']);
  assert.equal(h.wings.witness.status, 'ok');
  assert.equal(h.wings.compiler.api, '/engine/compiler');
  assert.equal(h.project_id, 'impossible-witness'); // contract id kept for existing integrations
});

test('the Compiler wing API is mounted unchanged under /engine/compiler', async () => {
  const h = await (await fetch(base + '/engine/compiler/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.service, 'paper-tiger-compiler-works');
  const r = await post('/engine/compiler/api/runs', { source: 'scene "Smoke" size 100 x 100 background #101013 {\n  circle(x: 50, y: 50, radius: 10, fill: #ffffff);\n}\n', project: 'smoke', passes: ['constfold', 'dce', 'cse'] });
  const run = await r.json();
  assert.equal(r.status, 201, JSON.stringify(run).slice(0, 300));
  assert.equal(run.receipt.oracle.agrees, true);
});

test('bridge endpoint: shipped seeds only, verdict + receipt, and the model lands in the Witness wing', async () => {
  const bad = await post('/api/bridge/pass-orders', { seed: '../../package', alphabet: 'safe' });
  assert.equal(bad.status, 400);
  assert.equal((await post('/api/bridge/pass-orders', { seed: 'not-a-shipped-example', alphabet: 'safe' })).status, 400);
  assert.equal((await post('/api/bridge/pass-orders', { seed: 'fault-lab-commute', alphabet: 'everything' })).status, 400);
  const r = await (await post('/api/bridge/pass-orders', { seed: 'fault-lab-commute', alphabet: 'mutant' })).json();
  assert.equal(r.verdict, 'DIVERGENCE_FOUND');
  assert.deepEqual(r.shortestPassSequence, ['BAD_cse_commute_all']);
  assert.equal(r.receipt.schema, 'impossible-witness/receipt');
  const m = await (await fetch(`${base}/api/models/by-slug/${r.slug}`)).json();
  assert.match(m.latest.source, /invariant OptimizedMatchesReference: agree/);
});

test('red-team: cross-site, foreign-origin, non-JSON and rebinding requests are refused on both wings', async () => {
  const body = JSON.stringify({ seed: 'fault-lab-commute', alphabet: 'safe' });
  // another site (or another local port) driving the API from a browser
  for (const p of ['/api/bridge/pass-orders', '/engine/compiler/api/runs']) {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body });
    assert.equal(r.status, 403, p);
    const o = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body });
    assert.equal(o.status, 403, p);
  }
  assert.equal((await fetch(base + '/health', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  // a cross-site "simple" request (text/plain) is never parsed as JSON
  assert.equal((await fetch(base + '/api/bridge/pass-orders', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).status, 415);
  // the UI's own requests still work
  const ok = await fetch(base + '/api/bridge/pass-orders', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' }, body });
  assert.equal(ok.status, 200);
});

test('red-team: malformed paths and hostile receipts do not crash the server', async () => {
  const http = await import('node:http');
  const raw = (path: string, host = '127.0.0.1') => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(new URL(base).port), path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end();
  });
  assert.equal(await raw('/health', 'evil.example'), 421); // DNS rebinding
  assert.ok([400, 404].includes(await raw('/%E0%A4%A')), 'malformed percent-encoding is a 4xx');
  assert.ok([400, 404].includes(await raw('/compiler/%E0%A4%A')));
  assert.equal(await raw('/../../package.json'), 404);
  const deep = '{"receipt":' + '['.repeat(200_000) + '0' + ']'.repeat(200_000) + '}'; // ~400 KB, under the body cap
  const v = await fetch(base + '/api/receipts/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: deep });
  assert.equal(v.status, 400, `deeply nested receipt answered ${v.status}`);
  const pv = await fetch(base + '/engine/compiler/api/reproduce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: deep });
  assert.ok(pv.status >= 400 && pv.status < 500, `Compiler wing: deeply nested receipt answered ${pv.status}`);
  assert.equal((await fetch(base + '/health')).status, 200, 'still alive');
});
