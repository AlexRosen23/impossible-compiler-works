import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, publicText } from '../src/server/app.ts';
import { Store } from '../src/server/db.ts';
import { example } from './helpers.ts';

let app: ReturnType<typeof createApp>;
let base = '';
const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-test-'));

before(async () => {
  app = createApp({ dbFile: path.join(dir, 'w.db'), staticDir: null });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const j = async (p: string, init?: RequestInit) => {
  const r = await fetch(base + p, init);
  return { status: r.status, body: await r.json() as any, headers: r.headers };
};
const post = (p: string, body: unknown) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const waitRun = async (id: string, want = ['done', 'failed', 'cancelled']) => {
  for (let i = 0; i < 400; i++) {
    const r = await j(`/api/runs/${id}`);
    if (want.includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('run did not finish');
};

test('health, capabilities and examples are seeded', async () => {
  const h = await j('/health');
  assert.equal(h.body.status, 'ok');
  assert.equal(h.body.ok, true);
  assert.deepEqual(h.body.problems, []);
  const c = await j('/capabilities');
  assert.equal(c.body.schema_version, 1);
  assert.equal(c.body.project_id, 'impossible-witness');
  const ms = await j('/api/models');
  assert.ok(ms.body.models.length >= 30);
});

test('journey: run broken counter -> violation; run repaired -> bounded verification; receipt verifies', async () => {
  const broken = (await j('/api/models/by-slug/counter-race')).body;
  const r1 = await post('/api/runs', { revisionId: broken.latest.id, kind: 'check' });
  assert.equal(r1.status, 202);
  const done1 = await waitRun(r1.body.id);
  assert.equal(done1.status, 'done');
  assert.equal(done1.result.verdict, 'VIOLATION_FOUND');
  assert.equal(done1.result.properties.find((p: any) => p.name === 'NoLostUpdate').trace.length, 4);
  assert.equal(done1.result.graph.nodes.length, 13);
  const fixed = (await j('/api/models/by-slug/counter-atomic')).body;
  const done2 = await waitRun((await post('/api/runs', { revisionId: fixed.latest.id })).body.id);
  assert.equal(done2.result.verdict, 'NO_VIOLATION_IN_BOUNDED_MODEL');
  const receipt: any = await (await fetch(`${base}/api/runs/${done1.id}/receipt`)).json();
  const v = await post('/api/receipts/verify', { receipt });
  assert.equal(v.body.verdict, 'VALID');
  receipt.result.verdict = 'NO_VIOLATION_IN_BOUNDED_MODEL';
  assert.equal((await post('/api/receipts/verify', { receipt })).body.verdict, 'REJECTED');
});

test('editing a model creates content-addressed revisions and diffs', async () => {
  const created = await post('/api/models', { source: example('counter-race'), note: 'first' });
  assert.equal(created.status, 201);
  const id = created.body.model.id;
  const again = await post(`/api/models/${id}/revisions`, { source: example('counter-race') });
  assert.equal(again.body.revision.rev, 1, 'identical source does not create a revision');
  const edited = await post(`/api/models/${id}/revisions`, { source: example('counter-race').replace('counter := tmp + 1', 'counter := counter + 1'), note: 'atomic write' });
  assert.equal(edited.body.revision.rev, 2);
  const m = (await j(`/api/models/${id}`)).body;
  const d = await j(`/api/diff?a=${m.revisions[1].id}&b=${m.revisions[0].id}`);
  assert.ok(d.body.diff.some((l: any) => l.op === '+' && l.text.includes('counter + 1')));
});

test('INCOMPLETE under a 50-state cap, exported, tampered and rejected (journey 6)', async () => {
  const m = (await j('/api/models/by-slug/state-explosion')).body;
  const run = await waitRun((await post('/api/runs', { revisionId: m.latest.id, bounds: { maxStates: 50 } })).body.id);
  assert.equal(run.result.verdict, 'INCOMPLETE');
  assert.equal(run.result.stats.states, 50);
  const receipt: any = await (await fetch(`${base}/api/runs/${run.id}/receipt`)).json();
  assert.equal((await post('/api/receipts/verify', { receipt })).body.verdict, 'VALID');
  receipt.result.verdict = 'NO_VIOLATION_IN_BOUNDED_MODEL';
  const rej = await post('/api/receipts/verify', { receipt });
  assert.equal(rej.body.verdict, 'REJECTED');
  assert.ok(rej.body.checks.some((c: any) => c.name === 'digest' && !c.ok));
});

test('model titles are sanitised in the public contract (XSS) and no source leaks', async () => {
  const evil = example('counter-atomic').replace('"Two threads share one counter (atomic increment — repaired)"', '"<img src=x onerror=alert(1)> \\"pwn\\""');
  const created = await post('/api/models', { source: evil });
  assert.equal(created.status, 201);
  const run = await waitRun((await post('/api/runs', { revisionId: created.body.revision.id })).body.id);
  const list = (await j('/runs?limit=200')).body;
  assert.equal(list.schema_version, 1);
  const mine = list.runs.find((r: any) => r.run_id === run.id);
  assert.doesNotMatch(mine.title, /[<>"']/);
  assert.equal(mine.provenance.label, 'synthetic');
  assert.equal(mine.provenance.synthetic, true);
  assert.equal(mine.status, 'completed');
  assert.ok(Array.isArray((await j('/capabilities')).body.implemented));
  const text = JSON.stringify(list);
  assert.doesNotMatch(text, /counter := counter/);
  assert.doesNotMatch(text, /\/Users\//);
  const one = (await j(`/runs/${run.id}`)).body;
  assert.equal(one.run.run_id, run.id);
  assert.equal(publicText('a<b>"c"\u0000'), 'abc');
  const report = await (await fetch(`${base}/api/runs/${run.id}/report.html`)).text();
  assert.doesNotMatch(report, /<img src=x/);
});

test('malformed and oversized input is rejected with 4xx, never 500', async () => {
  assert.equal((await j('/api/compile', { method: 'POST', body: '{not json' })).status, 400);
  assert.equal((await post('/api/compile', { source: 42 })).status, 400);
  assert.equal((await post('/api/compile', { source: 'x'.repeat(70 * 1024) })).status, 413);
  const big = await fetch(`${base}/api/compile`, { method: 'POST', body: 'x'.repeat(600 * 1024) }).catch(() => null);
  assert.ok(!big || big.status === 413);
  assert.equal((await post('/api/runs', { modelId: 99999, source: 'model m' })).status, 404);
  assert.equal((await post('/api/runs', { revisionId: 1, bounds: { maxStates: -5 } })).status, 400);
  assert.equal((await post('/api/runs', { revisionId: 1, kind: 'rm -rf' })).status, 400);
  const bad = await post('/api/models', { source: 'model m\nvar x : 0..2 = 0\ninvariant I: y' });
  const nr = await post('/api/runs', { revisionId: bad.body.revision.id });
  assert.equal(nr.status, 422);
  assert.equal((await j('/api/runs/run_nope')).status, 404);
  assert.equal((await j('/../../etc/passwd')).status, 404);
});

test('compile diagnostics include positions', async () => {
  const r = await post('/api/compile', { source: 'model m\nvar x : 0..2 = 0\nprocess P { action a { x = 1 } }' });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.diagnostics[0].span.line, 3);
});

test('requests with a non-loopback Host header are refused (DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = await new Promise<number>((resolve) => {
    const u = new URL(base);
    http.get({ host: '127.0.0.1', port: u.port, path: '/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
  });
  assert.equal(status, 421);
});

test('a queued or running job can be cancelled', async () => {
  const m = (await j('/api/models/by-slug/benchmark-grid')).body;
  const id = (await post('/api/runs', { revisionId: m.latest.id, bounds: { maxStates: 2_000_000 } })).body.id;
  await new Promise((r) => setTimeout(r, 30));
  const c = await post(`/api/runs/${id}/cancel`, {});
  assert.equal(c.body.cancelled, true);
  const row = await waitRun(id);
  assert.equal(row.status, 'cancelled');
});

test('crash recovery: a run left running by a dead server is re-queued and completes', async () => {
  const file = path.join(dir, 'crash.db');
  const s = new Store(file);
  const mid = s.createModel('crash-test', 'crash', 'user').id;
  const rev = s.addRevision(mid, example('counter-race'), '');
  const run = s.createRun(rev.id, 'check', { maxStates: 1000, maxEdges: 10000, maxDepth: 100, timeLimitMs: 5000, maxHeapMB: 1024 });
  s.markRunning(run.id);
  s.db.close();
  const app2 = createApp({ dbFile: file, staticDir: null, seedExamples: false });
  try {
    for (let i = 0; i < 200 && app2.store.run(run.id)!.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 25));
    const row = app2.store.run(run.id)!;
    assert.equal(row.status, 'done');
    assert.equal(row.attempts, 2);
    assert.match(row.error ?? '', /recovered/);
  } finally { await app2.close(); }
});

test('mutation-testing jobs report killed mutants', async () => {
  const m = (await j('/api/models/by-slug/mutex-test-and-set')).body;
  const run = await waitRun((await post('/api/runs', { revisionId: m.latest.id, kind: 'mutation' })).body.id);
  assert.equal(run.status, 'done');
  assert.ok(run.result.results.some((r: any) => r.outcome === 'KILLED' && r.killedBy === 'MutualExclusion'));
});

test('a worker that crashes is retried once, then the run fails with an explicit error', async () => {
  process.env.WITNESS_TEST_CRASH_WORKER = '1';
  try {
    const m = (await j('/api/models/by-slug/counter-race')).body;
    const run = await waitRun((await post('/api/runs', { revisionId: m.latest.id })).body.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.attempts, 2);
    assert.match(run.error, /crashed/);
  } finally { delete process.env.WITNESS_TEST_CRASH_WORKER; }
});
