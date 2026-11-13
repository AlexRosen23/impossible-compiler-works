import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Handler, createHandler } from '../server/app.ts';
import { JobError, JobRunner } from '../server/jobs.ts';
import { openDb } from '../server/db.ts';
import { ROOT, examples } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let server: Server;
let handler: Handler;
let port = 0;
beforeAll(async () => {
  handler = createHandler({ db: openDb(':memory:'), root: ROOT, commit: 'test', startedAt: Date.now(), caps: { runs: 5 } });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { server.close(); await handler.close(); });

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('read-only Constellation contract', () => {
  it('GET /health and /capabilities', async () => {
    const h = await call('GET', '/health');
    expect(h.status).toBe(200);
    expect(h.json.ok).toBe(true);
    const c = await call('GET', '/capabilities');
    expect(c.json.passes).toEqual(['constfold', 'dce', 'cse']);
    expect(c.json.examples).toBeGreaterThanOrEqual(12);
  });
  it('records a run server-side, content-addressed, and serves it from /runs and /runs/{id}', async () => {
    const src = examples()[0].source;
    const a = await call('POST', '/api/runs', { source: src, project: 'almanac' });
    expect(a.status).toBe(201);
    expect(a.json.receipt.oracle.agrees).toBe(true);
    const b = await call('POST', '/api/runs', { source: src, project: 'almanac' });
    expect(b.json.id).toBe(a.json.id);
    expect(b.json.deduplicated).toBe(true);
    const list = await call('GET', '/runs');
    expect(list.json.runs.map((r: { id: string }) => r.id)).toContain(a.json.id);
    const one = await call('GET', `/runs/${a.json.id}`);
    expect(one.json.receipt.sceneHash).toBe(a.json.receipt.sceneHash);
    expect((await call('GET', '/runs/nothex')).status).toBe(400);
    expect((await call('GET', '/runs/0123456789abcdef')).status).toBe(404);
  });
  it('rejects compile errors with diagnostics, not a run', async () => {
    const r = await call('POST', '/api/runs', { source: 'scene "s" { circle(x: "a", y: 1, radius: 1); }' });
    expect(r.status).toBe(422);
    expect(r.json.diagnostics[0].code).toBe('C002');
  });
});

describe('API safety', () => {
  it('refuses non-loopback Host headers (DNS rebinding)', async () => {
    expect((await call('GET', '/health', undefined, { host: 'evil.example:5580' })).status).toBe(421);
  });
  it('caps bodies, requires JSON and validates fields', async () => {
    expect((await call('POST', '/api/runs', 'x'.repeat(600_000))).status).toBe(413);
    expect((await call('POST', '/api/runs', 'not json')).status).toBe(400);
    expect((await call('POST', '/api/runs', { source: 'scene "s" {}', passes: ['eval'] })).status).toBe(400);
    expect((await call('POST', '/api/runs', { source: 'scene "s" {}', fixtures: ['../../etc/passwd'] })).status).toBe(400);
    expect((await call('POST', '/api/runs', { source: 'scene "s" {}', fixtures: { '../x': [1] } })).status).toBe(400);
  });
});

describe('projects: save, conflict, history, restore, fork', () => {
  it('versions saves, refuses stale saves with 409, restores and forks', async () => {
    const p = await call('POST', '/api/projects', { name: 'poster', source: 'scene "a" {}' });
    expect(p.status).toBe(201);
    const id = p.json.id, v1 = p.json.head.id;
    const s2 = await call('POST', `/api/projects/${id}/versions`, { baseVersion: v1, source: 'scene "b" {}' });
    expect(s2.json.head.seq).toBe(2);
    const stale = await call('POST', `/api/projects/${id}/versions`, { baseVersion: v1, source: 'scene "c" {}' });
    expect(stale.status).toBe(409);
    expect(stale.json.head.source).toBe('scene "b" {}');
    const r = await call('POST', `/api/projects/${id}/restore`, { seq: 1 });
    expect(r.json.head.source).toBe('scene "a" {}');
    expect(r.json.versions.length).toBe(3);
    const f = await call('POST', `/api/projects/${id}/fork`, { seq: 2, name: 'poster b' });
    expect(f.json.head.source).toBe('scene "b" {}');
    expect(f.json.forkedFrom).toBe(`${id}:v2`);
  });
});

describe('export, import and tamper rejection', () => {
  it('exports a bundle that imports cleanly, and refuses a tampered one', async () => {
    const run = await call('POST', '/api/runs', { source: examples()[1].source, fixtures: ['rainfall', 'months'] });
    expect(run.status).toBe(201);
    const bundle = (await call('GET', `/api/runs/${run.json.id}/bundle`)).json;
    expect(bundle.manifest.format).toBe('paper-tiger-bundle/0.1');
    const ok = await call('POST', '/api/import', bundle);
    expect(ok.status).toBe(201);
    const bad = structuredClone(bundle);
    bad.bytecode.consts[0] = 4242;
    const rej = await call('POST', '/api/import', bad);
    expect(rej.status).toBe(422);
    expect(rej.json.checks.some((c: { ok: boolean }) => !c.ok)).toBe(true);
    const bad2 = structuredClone(bundle);
    bad2.receipt.source += '\n// edited';
    expect((await call('POST', '/api/import', bad2)).status).toBe(422);
  });
});

describe('red-team: the server stays up and answers', () => {
  it('refuses requests another site or another local port makes, before doing any work', async () => {
    expect((await call('GET', '/api/projects', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call('GET', '/api/runs/0123456789abcdef/bundle', undefined, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await call('POST', '/api/projects', { name: 'x', source: 'scene "s" {}' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/projects', { name: 'x', source: 'scene "s" {}' }, { origin: 'http://127.0.0.1:5594' })).status).toBe(403);
    expect((await call('GET', '/health', undefined, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await call('GET', '/health', undefined, { 'sec-fetch-site': 'none' })).status).toBe(200);
    expect((await call('POST', '/api/projects', { name: 'mine', source: 'scene "s" {}' }, { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' })).status).toBe(201);
  });

  it('a hostile program records quickly and the server answers /health meanwhile (was: 17 s stall)', async () => {
    const fns = Array.from({ length: 30 }, (_, i) => `fn f${i}(x: Number) -> Number { return ${i < 29 ? `f${i + 1}(x) + f${i + 1}(x + 1)` : 'x'}; }`).join('\n');
    const t0 = Date.now();
    const [run, health] = await Promise.all([call('POST', '/api/runs', { source: `${fns}\nscene "s" { circle(x: f0(1) % 100, y: 1, radius: 1); }` }), call('GET', '/health')]);
    expect(health.status).toBe(200);
    expect(run.status).toBe(201);
    expect(run.json.receipt.fault.code).toBe('R013');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('reproduce rejects a receipt with 20,000 passes at once (was: 25 s stall)', async () => {
    const r = await call('POST', '/api/runs', { source: 'scene "p" { circle(x: 1, y: 1, radius: 1); }' });
    const t0 = Date.now();
    const rep = await call('POST', '/api/reproduce', { receipt: { ...r.json.receipt, optimizations: Array(20_000).fill('cse') } });
    expect(rep.json.reproduced).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('fixture names cannot reach Object.prototype (was: "constructor" recorded a run its own import rejected)', async () => {
    expect((await call('POST', '/api/runs', { source: 'scene "s" {}', fixtures: ['constructor'] })).status).toBe(404);
  });

  it('keeps at most the configured number of runs', async () => {
    for (let i = 0; i < 8; i++) await call('POST', '/api/runs', { source: `scene "cap${i}" { circle(x: ${i}, y: 1, radius: 1); }` });
    expect((await call('GET', '/runs?limit=200')).json.runs.length).toBeLessThanOrEqual(5);
  });

  it('the job runner stops a run past its time limit and keeps working', async () => {
    const jobs = new JobRunner({ timeoutMs: 300 });
    try {
      await expect(jobs.run({ kind: 'sleep', ms: 5_000 })).rejects.toMatchObject({ reason: 'timeout' });
      expect(await jobs.run({ kind: 'sleep', ms: 1 })).toBe('slept');
    } finally { await jobs.close(); }
  });

  it('a run that exhausts its heap kills only its worker', async () => {
    const jobs = new JobRunner({ timeoutMs: 20_000, heapMb: 32 });
    try {
      const err = await jobs.run({ kind: 'grow' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).reason).toBe('crashed');
      expect(await jobs.run({ kind: 'sleep', ms: 1 })).toBe('slept');
    } finally { await jobs.close(); }
  }, 30_000);

  it('a full queue answers busy instead of growing', async () => {
    const jobs = new JobRunner({ timeoutMs: 2_000, maxQueue: 1 });
    try {
      const a = jobs.run({ kind: 'sleep', ms: 200 });
      const b = jobs.run({ kind: 'sleep', ms: 1 });
      await expect(jobs.run({ kind: 'sleep', ms: 1 })).rejects.toMatchObject({ reason: 'busy' });
      await a; await b;
    } finally { await jobs.close(); }
  });
});
