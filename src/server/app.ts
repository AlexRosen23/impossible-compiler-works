// HTTP API (node:http, no framework). Loopback only. See docs/ARCHITECTURE.md and docs/SECURITY.md.
import http from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { Store, HttpError, type RunRow, type RunKind } from './db.ts';
import { compileSource } from '../core/model/compile.ts';
import { clampBounds, ENGINE_NAME, ENGINE_VERSION } from '../core/engine/explore.ts';
import { verifyReceipt, MAX_RECEIPT_BYTES, gitInfo } from '../core/receipt/receipt.ts';
import { exportTla } from '../core/tla/export.ts';
import { tlcAvailability, TLC_PIN } from '../core/tla/tlc.ts';
import { lineDiff } from './diff.ts';
import { createHandler as createCompilerHandler } from '../../wings/compiler/server/app.ts';
import { openDb as openCompilerDb } from '../../wings/compiler/server/db.ts';
import { CSP as COMPILER_CSP } from '../../wings/compiler/server/static.ts';
import { COMPILER_VERSION } from '../../wings/compiler/core/version.ts';
import { checkPassOrders, SAFE_ALPHABET, MUTANT_ALPHABET } from '../../bridge/pass-orders.ts';
import { renderReport } from './report.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const SERVICE = 'impossible-witness';
export const VERSION = '0.2.0';
export const NAME = 'THE IMPOSSIBLE COMPILER WORKS';
export const FORMERLY = ['Paper Tiger Compiler Works', 'The Impossible Witness'];
/** The Compiler wing's API (formerly the PAPER TIGER server on 5580) is mounted unchanged under this prefix. */
export const COMPILER_MOUNT = '/engine/compiler';
export const COMPILER_ROOT = path.join(ROOT, 'wings', 'compiler');
const MAX_BODY = 512 * 1024;
const JOB_WALL_MS = 10 * 60_000;

export interface AppOptions {
  dbFile: string;
  concurrency?: number;
  staticDir?: string | null;
  seedExamples?: boolean;
  /** SQLite file for the Compiler wing (projects, versions, runs). Default: next to dbFile. */
  compilerDbFile?: string;
  /** Commit recorded in Compiler wing receipts; default: `git rev-parse HEAD` (null outside a checkout). */
  commit?: string | null;
}

/** Public-safe text: printable, no markup characters, bounded length. */
export function publicText(s: unknown, max = 80): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>"'`&\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function createApp(opts: AppOptions) {
  const store = new Store(opts.dbFile);
  const recovered = store.recover();
  const started = Date.now();
  const active = new Map<string, Worker>();
  const progress = new Map<string, unknown>();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 4));
  const catalog = JSON.parse(readFileSync(path.join(ROOT, 'examples/catalog.json'), 'utf8'));
  const compilerDbFile = opts.compilerDbFile ?? path.join(path.dirname(opts.dbFile), path.basename(opts.dbFile).replace(/\.db$/, '') + '-compiler.sqlite');
  const commit = opts.commit !== undefined ? opts.commit : (() => { const c = gitInfo(ROOT).commit; return c === 'unknown' ? null : c; })();
  const compilerSeeds = new Set(readdirSync(path.join(COMPILER_ROOT, 'examples')).filter((f) => f.endsWith('.folio')).map((f) => f.replace(/\.folio$/, '')));
  const compiler = createCompilerHandler({ db: openCompilerDb(compilerDbFile), root: COMPILER_ROOT, commit, startedAt: Date.now() });

  if (opts.seedExamples !== false) {
    for (const f of readdirSync(path.join(ROOT, 'examples')).filter((x) => x.endsWith('.witness')).sort()) {
      const slug = f.replace(/\.witness$/, '');
      const src = readFileSync(path.join(ROOT, 'examples', f), 'utf8');
      const c = compileSource(src);
      const title = c.ok ? c.model!.title : slug;
      const m = store.modelBySlug(slug) ?? store.createModel(slug, title, 'example');
      store.addRevision(m.id, src, 'example as shipped');
    }
  }

  // ---- job queue ----------------------------------------------------------------------------
  let closed = false;
  const pump = () => {
    while (!closed && active.size < concurrency) {
      const next = store.nextQueued();
      if (!next) return;
      startJob(next);
    }
  };

  const startJob = (run: RunRow) => {
    const rev = store.revision(run.revision_id)!;
    store.markRunning(run.id);
    const bounds = JSON.parse(run.bounds);
    const w = new Worker(path.join(HERE, 'worker.ts'), {
      workerData: { kind: run.kind, source: rev.source, bounds, graphLimit: 5_000 },
      resourceLimits: { maxOldGenerationSizeMb: 2_048 },
      env: process.env,
    });
    active.set(run.id, w);
    let settled = false;
    const wall = setTimeout(() => {
      if (settled) return;
      settled = true;
      store.finish(run.id, 'failed', { error: 'job exceeded its wall-clock budget' });
      void w.terminate();
    }, JOB_WALL_MS);
    const end = () => { clearTimeout(wall); active.delete(run.id); progress.delete(run.id); if (!closed) setImmediate(pump); };
    w.on('message', (m: { type: string; progress?: unknown; result?: unknown; receipt?: unknown; error?: string }) => {
      if (closed) return;
      if (m.type === 'progress') { progress.set(run.id, m.progress); store.setProgress(run.id, m.progress as object); return; }
      if (settled) return;
      settled = true;
      if (m.type === 'done') store.finish(run.id, 'done', { result: JSON.stringify(m.result), receipt: m.receipt ? JSON.stringify(m.receipt) : undefined });
      else store.finish(run.id, 'failed', { error: String(m.error ?? 'unknown error').slice(0, 2000) });
      void w.terminate();
    });
    w.on('error', (e) => {
      if (closed) { end(); return; }
      if (!settled) { settled = true; store.finish(run.id, 'failed', { error: `worker error: ${e.message}`.slice(0, 2000) }); }
      end();
    });
    w.on('exit', (code) => {
      if (closed) { end(); return; }
      const row = store.run(run.id)!;
      if (!settled && row.status === 'running') {
        settled = true;
        // the worker died without reporting: treat as a crash and re-queue once
        if (row.attempts < 2) {
          store.db.prepare(`UPDATE runs SET status = 'queued', error = ? WHERE id = ? AND status = 'running'`).run(`worker exited with code ${code}; re-queued`, run.id);
        } else store.finish(run.id, 'failed', { error: `worker crashed (exit ${code}) twice` });
      }
      end();
    });
  };

  const cancel = (id: string): boolean => {
    const row = store.run(id);
    if (!row) throw new HttpError(404, 'no such run');
    if (row.status === 'queued') { store.finish(id, 'cancelled', { error: 'cancelled before start' }); return true; }
    if (row.status === 'running') {
      const w = active.get(id);
      store.finish(id, 'cancelled', { error: 'cancelled by user' });
      if (w) void w.terminate();
      if (row.kind === 'tlc') {
        // our TLC containers are named witness-tlc-*; stop only those
        const ps = spawnSync('docker', ['ps', '-q', '--filter', 'name=^witness-tlc-'], { encoding: 'utf8', timeout: 5000 });
        for (const cid of (ps.stdout ?? '').split('\n').filter(Boolean)) spawnSync('docker', ['kill', cid], { timeout: 10_000 });
      }
      return true;
    }
    return false;
  };

  // ---- helpers ------------------------------------------------------------------------------
  const readBody = (req: http.IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, `request body larger than ${MAX_BODY} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'body is not valid JSON')); }
    });
    req.on('error', reject);
  });

  const str = (v: unknown, name: string, max: number, required = true): string => {
    if (v === undefined || v === null) { if (required) throw new HttpError(400, `${name} is required`); return ''; }
    if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
    if (v.length > max) throw new HttpError(413, `${name} longer than ${max} characters`);
    return v;
  };

  const runView = (row: RunRow) => {
    const rev = store.revision(row.revision_id)!;
    const model = store.model(rev.model_id)!;
    return {
      id: row.id, kind: row.kind, status: row.status, error: row.error, attempts: row.attempts,
      created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at,
      bounds: JSON.parse(row.bounds),
      progress: progress.get(row.id) ?? (row.progress ? JSON.parse(row.progress) : null),
      model: { id: model.id, slug: model.slug, title: model.title, origin: model.origin },
      revision: { id: rev.id, rev: rev.rev, source_sha256: rev.source_sha256, note: rev.note },
      result: row.result ? JSON.parse(row.result) : null,
      receipt_digest: row.receipt ? JSON.parse(row.receipt).digest : null,
      annotations: store.annotations(row.id),
    };
  };

  /** Constellation contract: public-safe run summary (no model source, no paths). */
  const STATUS_WORD: Record<string, string> = { queued: 'queued', running: 'running', done: 'completed', failed: 'failed', cancelled: 'cancelled' };
  const publicRun = (r: ReturnType<Store['runs']>[number]) => {
    const model = SLUG_RE.test(r.slug) ? r.slug : 'user-model';
    const kind = r.kind === 'check' ? 'model-check' : r.kind === 'tlc' ? 'tlc-cross-check' : 'mutation-test';
    const verdict = r.verdict ?? null;
    const headline = r.status === 'done'
      ? (r.kind === 'mutation' ? `mutation testing of ${model} r${r.rev}` : `${model} r${r.rev}: ${verdict ?? 'no verdict'}${r.states !== null ? `, ${r.states} states${r.complete ? '' : ' (incomplete)'}` : ''}`)
      : `${model} r${r.rev}: ${r.status}`;
    return {
      run_id: r.id,
      project_id: SERVICE,
      kind,
      status: STATUS_WORD[r.status] ?? r.status,
      mode: 'bounded-model',
      verdict,
      complete: r.complete === null ? null : !!r.complete,
      states: r.states ?? null,
      edges: r.edges ?? null,
      model,
      title: publicText(r.title),
      revision: r.rev,
      headline,
      started_at: r.started_at,
      ended_at: r.finished_at,
      created_at: r.created_at,
      finished_at: r.finished_at,
      provenance: {
        synthetic: true,
        label: r.origin === 'example' ? 'fixture' : 'synthetic',
        source: r.origin === 'example' ? 'a shipped example model (hand-written, finite)' : 'a user-written finite model',
      },
      links: { self: `/runs/${r.id}` },
    };
  };

  const capabilities = async () => {
    const t = await tlcAvailability();
    return {
      schema_version: 1,
      project_id: SERVICE,
      service: SERVICE,
      version: VERSION,
      summary: 'Explicit-state model checker for finite concurrent models: shortest counterexamples, fairness-aware liveness, independent trace replay, TLC cross-checks and tamper-evident receipts.',
      engine: { name: ENGINE_NAME, version: ENGINE_VERSION, search: 'breadth-first, exact canonical state keys' },
      checkers: [
        { id: 'internal', status: 'available', properties: ['invariant', 'deadlock', 'domain', 'eventually', 'leadsto'] },
        { id: 'tlc', status: t.available ? 'available' : 'INTERNAL_ONLY', version: TLC_PIN.release, note: t.available ? 'sandboxed, pinned tla2tools.jar' : 'TLC not available on this machine' },
      ],
      examples: catalog.scenarios.length,
      features: ['possibility-chamber', 'specification-desk', 'interleaving-theater', 'invariant-hall', 'temporal-observatory', 'witness-archive', 'model-bazaar', 'proof-observatory'],
      read_only_endpoints: ['/health', '/capabilities', '/runs', '/runs/{id}'],
      active_mode: 'bounded-model',
      dataset: { name: `${catalog.scenarios.length} teaching scenarios (hand-written finite models)`, origin: 'hand-written', synthetic: true },
      implemented: ['bfs-model-checking', 'shortest-counterexamples', 'deadlock-detection', 'fairness-aware-liveness', 'independent-trace-replay', 'mutation-testing', 'tla-export', t.available ? 'tlc-cross-check' : 'tlc-cross-check (INTERNAL_ONLY here)', 'tamper-evident-receipts', 'html-report-export', 'model-revisions-and-diffs', 'state-graph-visualisation'],
      not_implemented: ['symbolic-model-checking', 'partial-order-reduction', 'symmetry-reduction', 'alloy', 'code-to-model-extraction'],
      disabled_by_design: ['arbitrary-code-execution-from-models', 'network-access-from-checks', 'connecting-to-live-systems', 'proof-claims-about-production-software'],
      limits: { bounds_default: clampBounds({}), body_bytes: MAX_BODY },
      provenance_labels: { fixture: 'run of a shipped example model', synthetic: 'run of a user-authored model' },
      disclaimer: 'Verdicts cover only the finite model and its stated assumptions; they are not proofs about production systems.',
    };
  };

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'string' && headers['content-type'] ? headers['content-type'] : 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(json);
  };

  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean => {
    const dir = opts.staticDir;
    if (!dir || !existsSync(dir)) return false;
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { return false; }
    if (rel.includes('\0')) return false;
    const compilerPage = rel === '/compiler' || rel.startsWith('/compiler/');
    if (rel === '/' || !path.extname(rel)) rel = compilerPage ? '/compiler/index.html' : '/index.html';
    const file = path.resolve(dir, '.' + rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) || !existsSync(file) || !statSync(file).isFile()) return false;
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
    res.writeHead(200, {
      'content-type': types[path.extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': compilerPage ? COMPILER_CSP : "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    createReadStream(file).pipe(res);
    void req;
    return true;
  };

  // ---- routes -------------------------------------------------------------------------------
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // DNS-rebinding guard: only loopback Host headers are served
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 421, { error: 'loopback hosts only' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const m = req.method ?? 'GET';
    let match: RegExpExecArray | null;

    // read-only contract
    if (m === 'GET' && p === '/health') {
      const last = store.runs(1)[0];
      return send(res, 200, {
        status: 'ok', ok: true, project_id: SERVICE, service: SERVICE, name: NAME, formerly: FORMERLY, version: VERSION, mode: 'bounded-model',
        wings: {
          witness: { status: 'ok', engine: ENGINE_NAME, engine_version: ENGINE_VERSION, ui: '/' },
          compiler: { status: 'ok', compiler_version: COMPILER_VERSION, api: COMPILER_MOUNT, ui: '/compiler/' },
        },
        uptime_s: Math.round((Date.now() - started) / 1000), queue: { active: active.size }, recovered, problems: [],
        last_run: last ? { run_id: last.id, kind: last.kind, status: STATUS_WORD[last.status] ?? last.status } : null,
      });
    }
    if (m === 'GET' && p === '/capabilities') return send(res, 200, await capabilities());
    if (m === 'GET' && p === '/runs') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200));
      const runs = store.runs(limit).map(publicRun);
      const total = (store.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
      return send(res, 200, { schema_version: 1, project_id: SERVICE, generated_at: new Date().toISOString(), total, runs });
    }
    if (m === 'GET' && (match = /^\/runs\/(run_[a-z0-9_]+)$/.exec(p))) {
      const r = store.runs(5_000).find((x) => x.id === match![1]);
      if (!r) return send(res, 404, { error: 'no such run' });
      return send(res, 200, { schema_version: 1, project_id: SERVICE, run: publicRun(r) });
    }

    // Compiler wing: the former PAPER TIGER API, unchanged, behind one prefix
    if (p === COMPILER_MOUNT || p.startsWith(COMPILER_MOUNT + '/')) {
      req.url = (req.url ?? '/').slice(COMPILER_MOUNT.length) || '/';
      return compiler(req, res);
    }

    if (!p.startsWith('/api/')) {
      if (m === 'GET' && serveStatic(req, res, p)) return;
      return send(res, 404, { error: 'not found' });
    }

    // cross-feature: model-check every optimizer pass order of a shipped FOLIO example (bridge/pass-orders.ts)
    if (m === 'POST' && p === '/api/bridge/pass-orders') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const seed = String(body.seed ?? '');
      const alphabet = body.alphabet === 'mutant' ? 'mutant' : body.alphabet === 'safe' ? 'safe' : null;
      if (!alphabet || !SLUG_RE.test(seed) || !compilerSeeds.has(seed)) return send(res, 400, { error: 'seed must be a shipped Compiler wing example and alphabet safe|mutant' });
      const r = checkPassOrders(seed, alphabet === 'mutant' ? MUTANT_ALPHABET : SAFE_ALPHABET);
      const slug = `pass-orders-${seed}-${alphabet}`.slice(0, 63);
      const model = store.modelBySlug(slug) ?? store.createModel(slug, `Pass orders: ${seed} (${alphabet})`, 'user');
      store.addRevision(model.id, r.wml, `generated by bridge/pass-orders.ts from ${seed}`);
      return send(res, 200, {
        seed, alphabet, slug, verdict: r.verdict, complete: r.abstraction.complete, programs: r.abstraction.states.length,
        diverging: r.abstraction.states.filter((s) => s.label === 'diverge').length, shortestPassSequence: r.shortestPassSequence, receipt: r.receipt,
      });
    }

    // app API
    if (m === 'GET' && p === '/api/catalog') return send(res, 200, catalog);
    if (m === 'GET' && p === '/api/models') return send(res, 200, { models: store.models() });
    if (m === 'GET' && (match = /^\/api\/models\/(\d+)$/.exec(p))) {
      const model = store.model(Number(match[1]));
      if (!model) return send(res, 404, { error: 'no such model' });
      const latest = store.latestRevision(model.id);
      return send(res, 200, { model, revisions: store.revisions(model.id), latest });
    }
    if (m === 'GET' && (match = /^\/api\/models\/by-slug\/([a-z0-9-]+)$/.exec(p))) {
      const model = store.modelBySlug(match[1]);
      if (!model) return send(res, 404, { error: 'no such model' });
      return send(res, 200, { model, revisions: store.revisions(model.id), latest: store.latestRevision(model.id) });
    }
    if (m === 'GET' && (match = /^\/api\/revisions\/(\d+)$/.exec(p))) {
      const r = store.revision(Number(match[1]));
      return r ? send(res, 200, r) : send(res, 404, { error: 'no such revision' });
    }
    if (m === 'GET' && p === '/api/diff') {
      const a = store.revision(Number(url.searchParams.get('a')));
      const b = store.revision(Number(url.searchParams.get('b')));
      if (!a || !b) return send(res, 404, { error: 'no such revision' });
      return send(res, 200, { a: { id: a.id, rev: a.rev }, b: { id: b.id, rev: b.rev }, diff: lineDiff(a.source, b.source) });
    }
    if (m === 'POST' && p === '/api/models') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const source = str(body.source, 'source', 64 * 1024);
      const c = compileSource(source);
      const base = (c.ast?.name ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
      let slug = `my-${base}`;
      for (let k = 2; store.modelBySlug(slug); k++) slug = `my-${base}-${k}`;
      const model = store.createModel(slug, publicText(c.ast?.title ?? base, 120) || base, 'user');
      const rev = store.addRevision(model.id, source, str(body.note, 'note', 300, false));
      return send(res, 201, { model, revision: { id: rev.id, rev: rev.rev }, diagnostics: c.diagnostics });
    }
    if (m === 'POST' && (match = /^\/api\/models\/(\d+)\/revisions$/.exec(p))) {
      const model = store.model(Number(match[1]));
      if (!model) return send(res, 404, { error: 'no such model' });
      const body = (await readBody(req)) as Record<string, unknown>;
      const rev = store.addRevision(model.id, str(body.source, 'source', 64 * 1024), str(body.note, 'note', 300, false));
      return send(res, 201, { revision: { id: rev.id, rev: rev.rev, source_sha256: rev.source_sha256 } });
    }
    if (m === 'POST' && p === '/api/compile') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const c = compileSource(str(body.source, 'source', 64 * 1024));
      const summary = c.ok ? {
        title: c.model!.title, vars: c.model!.vars.length, actions: c.model!.actions.length, processes: c.model!.processes.map((x) => x.name),
        invariants: c.model!.invariants.map((i) => i.name), liveness: c.model!.liveness.map((l) => l.name), fairness: c.model!.fairness.map((f) => f.label),
        declaredStateSpace: c.model!.declaredStateSpace,
      } : null;
      return send(res, 200, { ok: c.ok, diagnostics: c.diagnostics, summary });
    }
    if (m === 'POST' && p === '/api/runs') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const kind = (body.kind ?? 'check') as RunKind;
      if (!['check', 'tlc', 'mutation'].includes(kind)) throw new HttpError(400, 'kind must be check, tlc or mutation');
      let bounds;
      try { bounds = clampBounds((body.bounds ?? {}) as Record<string, number>); } catch (e) { throw new HttpError(400, (e as Error).message); }
      let revisionId: number;
      if (typeof body.revisionId === 'number') {
        if (!store.revision(body.revisionId)) throw new HttpError(404, 'no such revision');
        revisionId = body.revisionId;
      } else {
        const model = store.model(Number(body.modelId));
        if (!model) throw new HttpError(404, 'no such model');
        const source = str(body.source, 'source', 64 * 1024);
        // editing an example creates a new revision of that example in the local database only
        revisionId = store.addRevision(model.id, source, str(body.note, 'note', 300, false)).id;
      }
      const c = compileSource(store.revision(revisionId)!.source);
      if (!c.ok) return send(res, 422, { error: 'model does not compile', diagnostics: c.diagnostics });
      const row = store.createRun(revisionId, kind, bounds);
      setImmediate(pump);
      return send(res, 202, { id: row.id, status: row.status, revisionId });
    }
    if (m === 'GET' && p === '/api/runs') {
      return send(res, 200, { runs: store.runs(Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500)) });
    }
    if ((match = /^\/api\/runs\/(run_[a-z0-9_]+)(\/[a-z.]+)?$/.exec(p))) {
      const row = store.run(match[1]);
      if (!row) return send(res, 404, { error: 'no such run' });
      const sub = match[2] ?? '';
      if (m === 'GET' && sub === '') return send(res, 200, runView(row));
      if (m === 'POST' && sub === '/cancel') return send(res, 200, { cancelled: cancel(row.id), status: store.run(row.id)!.status });
      if (m === 'GET' && sub === '/receipt') {
        if (!row.receipt) return send(res, 404, { error: 'run has no receipt (yet)' });
        return send(res, 200, row.receipt, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="witness-receipt-${row.id}.json"` });
      }
      if (m === 'GET' && sub === '/report.html') {
        if (!row.result) return send(res, 404, { error: 'run has no result (yet)' });
        const html = renderReport(runView(row) as never, row.receipt ? JSON.parse(row.receipt) : null);
        return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:", 'content-disposition': `attachment; filename="witness-report-${row.id}.html"` });
      }
      if (m === 'GET' && sub === '/tla') {
        const c = compileSource(store.revision(row.revision_id)!.source);
        if (!c.ok) return send(res, 422, { error: 'model does not compile' });
        const ex = exportTla(c.model!);
        return send(res, 200, { moduleName: ex.moduleName, tla: ex.tla, cfg: ex.cfgAll, configs: ex.configs, opToLabel: ex.opToLabel });
      }
      if (m === 'POST' && sub === '/annotations') {
        const body = (await readBody(req)) as Record<string, unknown>;
        store.annotate(row.id, str(body.property, 'property', 64), str(body.text, 'text', 2000));
        return send(res, 201, { annotations: store.annotations(row.id) });
      }
    }
    if (m === 'POST' && p === '/api/receipts/verify') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const receipt = body.receipt;
      if (JSON.stringify(receipt ?? null).length > MAX_RECEIPT_BYTES) throw new HttpError(413, 'receipt too large');
      return send(res, 200, verifyReceipt(receipt, { rerun: body.rerun !== false }));
    }
    if (m === 'GET' && p === '/api/tlc') {
      const t = await tlcAvailability();
      return send(res, 200, { ...t, pin: TLC_PIN, status: t.available ? 'AVAILABLE' : 'INTERNAL_ONLY' });
    }
    return send(res, 404, { error: 'not found' });
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  setImmediate(pump);
  return {
    server, store, pump, cancel,
    close: async () => {
      closed = true;
      for (const w of active.values()) await w.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      store.db.close();
      await compiler.close();
    },
  };
}
