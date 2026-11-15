// The Witness wing's API, in the browser. Same shape as the server client in ../api.ts, backed by the shipped
// example models, an in-memory store and the pure-TypeScript checker (run in a Web Worker). Nothing is sent anywhere.
import catalog from '../../../examples/catalog.json';
import { compileSource } from '../../../src/core/model/compile.ts';
import { clampBounds } from '../../../src/core/engine/explore.ts';
import { verifyReceipt } from '../../../src/core/receipt/receipt.ts';
import { exportTla } from '../../../src/core/tla/export.ts';
import { renderReport } from '../../../src/server/report.ts';
import { lineDiff } from '../../../src/server/diff.ts';
import { sha256Hex } from '../../../src/core/hash.ts';
import type { ServerApi } from '../api';
import type { ModelRow, Revision, RunView } from '../types';
import type { Job, WorkerMsg } from './checker.worker.ts';

const sources = import.meta.glob('../../../examples/*.witness', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

interface RevRec extends Revision { source: string }
interface ModelRec { id: number; slug: string; title: string; origin: 'example' | 'user'; revs: RevRec[] }
interface RunRec { view: RunView; receipt: Record<string, unknown> | null; worker: Worker | null; timer: ReturnType<typeof setTimeout> | null }

const JOB_WALL_MS = 120_000;
const now = () => new Date().toISOString();
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status, body: { error: message } }); };

const models: ModelRec[] = [];
const runs = new Map<string, RunRec>();
let revSeq = 0, runSeq = 0;

function addRevision(m: ModelRec, source: string, note: string): RevRec {
  const sha = sha256Hex(source);
  const latest = m.revs[0];
  if (latest && latest.source_sha256 === sha) return latest;
  const existing = m.revs.find((r) => r.source_sha256 === sha);
  if (existing && !note) return existing;
  const rev: RevRec = { id: ++revSeq, model_id: m.id, rev: (latest?.rev ?? 0) + 1, source, source_sha256: sha, note: note.slice(0, 300), created_at: now() };
  m.revs.unshift(rev);
  return rev;
}
function createModel(slug: string, title: string, origin: 'example' | 'user'): ModelRec {
  const m: ModelRec = { id: models.length + 1, slug, title, origin, revs: [] };
  models.push(m);
  return m;
}
for (const [file, src] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
  const slug = file.replace(/^.*\//, '').replace(/\.witness$/, '');
  const c = compileSource(src);
  addRevision(createModel(slug, c.ok ? c.model!.title : slug, 'example'), src, 'example as shipped');
}

const row = (m: ModelRec): ModelRow => ({ id: m.id, slug: m.slug, title: m.title, origin: m.origin, revisions: m.revs.length, latest_rev: m.revs[0]?.rev ?? 0 });
const modelById = (id: number) => models.find((m) => m.id === id) ?? fail(404, 'no such model');
const revisionById = (id: number) => { for (const m of models) { const r = m.revs.find((x) => x.id === id); if (r) return { m, r }; } return fail(404, 'no such revision'); };
const meta = (r: RevRec): Revision => { const { source: _s, ...rest } = r; return rest; };
const detail = (m: ModelRec) => ({ model: row(m), revisions: m.revs.map(meta), latest: m.revs[0] });
const runRec = (id: string) => runs.get(id) ?? fail(404, 'no such run');
const view = (r: RunRec): RunView => JSON.parse(JSON.stringify(r.view));

function finish(r: RunRec, status: 'done' | 'failed' | 'cancelled', fields: { result?: unknown; receipt?: unknown; error?: string }) {
  if (r.view.status !== 'queued' && r.view.status !== 'running') return;
  if (r.timer) clearTimeout(r.timer);
  r.view.status = status;
  r.view.finished_at = now();
  if (fields.result !== undefined) r.view.result = fields.result as RunView['result'];
  if (fields.receipt) { r.receipt = fields.receipt as Record<string, unknown>; r.view.receipt_digest = String((fields.receipt as { digest?: string }).digest ?? ''); }
  if (fields.error) r.view.error = fields.error;
  r.worker?.terminate();
  r.worker = null;
}

function start(r: RunRec, source: string, kind: 'check' | 'mutation', bounds: Record<string, number>) {
  const w = new Worker(new URL('./checker.worker.ts', import.meta.url), { type: 'module' });
  r.worker = w;
  r.view.status = 'running';
  r.view.started_at = now();
  r.view.attempts = 1;
  r.timer = setTimeout(() => finish(r, 'failed', { error: 'job exceeded its wall-clock budget' }), JOB_WALL_MS);
  w.onmessage = (e: MessageEvent<WorkerMsg>) => {
    const m = e.data;
    if (m.type === 'progress') { if (r.view.status === 'running') r.view.progress = m.progress as RunView['progress']; return; }
    if (m.type === 'done') finish(r, 'done', { result: m.result, receipt: m.receipt });
    else finish(r, 'failed', { error: m.error.slice(0, 2000) });
  };
  w.onerror = (e) => finish(r, 'failed', { error: `worker error: ${e.message}`.slice(0, 2000) });
  const job: Job = { kind, source, bounds, graphLimit: 5_000 };
  w.postMessage(job);
}

export const demoApi: ServerApi = {
  catalog: async () => catalog as unknown as Awaited<ReturnType<ServerApi['catalog']>>,
  models: async () => ({ models: [...models].sort((a, b) => (a.origin === b.origin ? a.slug.localeCompare(b.slug) : a.origin.localeCompare(b.origin))).map(row) }),
  modelBySlug: async (slug) => detail(models.find((m) => m.slug === slug) ?? fail(404, 'no such model')),
  model: async (id) => detail(modelById(id)),
  revision: async (id) => revisionById(id).r,
  diff: async (a, b) => ({ diff: lineDiff(revisionById(a).r.source, revisionById(b).r.source) }),
  compile: async (source) => {
    const c = compileSource(source);
    const summary = c.ok ? {
      title: c.model!.title, vars: c.model!.vars.length, actions: c.model!.actions.length, processes: c.model!.processes.map((x) => x.name),
      invariants: c.model!.invariants.map((i) => i.name), liveness: c.model!.liveness.map((l) => l.name), fairness: c.model!.fairness.map((f) => f.label),
      declaredStateSpace: c.model!.declaredStateSpace,
    } : null;
    return { ok: c.ok, diagnostics: c.diagnostics as never, summary };
  },
  createModel: async (source, note) => {
    const c = compileSource(source);
    const base = (c.ast?.name ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
    let slug = `my-${base}`;
    for (let k = 2; models.some((m) => m.slug === slug); k++) slug = `my-${base}-${k}`;
    const title = String(c.ast?.title ?? base).replace(/[\u0000-\u001f\u007f<>"'`&\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || base;
    const m = createModel(slug, title, 'user');
    const rev = addRevision(m, source, note);
    return { model: row(m), revision: { id: rev.id, rev: rev.rev } };
  },
  saveRevision: async (modelId, source, note) => { const rev = addRevision(modelById(modelId), source, note); return { revision: { id: rev.id, rev: rev.rev } }; },
  startRun: async (body) => {
    const kind = body.kind ?? 'check';
    if (kind !== 'check' && kind !== 'mutation') return fail(400, 'the TLC cross-check needs the full app');
    let bounds: Record<string, number>;
    try { bounds = clampBounds((body.bounds ?? {}) as never) as unknown as Record<string, number>; } catch (e) { return fail(400, (e as Error).message); }
    let m: ModelRec, rev: RevRec;
    if (typeof body.revisionId === 'number') { const x = revisionById(body.revisionId); m = x.m; rev = x.r; }
    else { m = modelById(Number(body.modelId)); rev = addRevision(m, String(body.source ?? ''), body.note ?? ''); }
    const c = compileSource(rev.source);
    if (!c.ok) return fail(422, 'model does not compile');
    const id = `run_${Date.now().toString(36)}_${(++runSeq).toString(16).padStart(4, '0')}`;
    const r: RunRec = {
      receipt: null, worker: null, timer: null,
      view: {
        id, kind, status: 'queued', error: null, attempts: 0, created_at: now(), started_at: null, finished_at: null, bounds, progress: null,
        model: { id: m.id, slug: m.slug, title: m.title, origin: m.origin },
        revision: { id: rev.id, rev: rev.rev, source_sha256: rev.source_sha256, note: rev.note },
        result: null, receipt_digest: null, annotations: [],
      },
    };
    runs.set(id, r);
    queueMicrotask(() => start(r, rev.source, kind, bounds));
    return { id, status: 'queued', revisionId: rev.id };
  },
  run: async (id) => view(runRec(id)),
  runs: async (limit = 100) => ({
    runs: [...runs.values()].reverse().slice(0, limit).map(({ view: v }) => {
      const res = v.result as { verdict?: string; complete?: boolean; stats?: { states: number; edges: number } } | null;
      return { id: v.id, kind: v.kind, status: v.status, verdict: res?.verdict ?? null, states: res?.stats?.states ?? null, edges: res?.stats?.edges ?? null, complete: res?.complete === undefined ? null : res.complete ? 1 : 0, slug: v.model.slug, title: v.model.title, origin: v.model.origin, rev: v.revision.rev, created_at: v.created_at, finished_at: v.finished_at };
    }),
  }),
  cancel: async (id) => {
    const r = runRec(id);
    const live = r.view.status === 'queued' || r.view.status === 'running';
    if (live) finish(r, 'cancelled', { error: 'cancelled by user' });
    return { cancelled: live, status: r.view.status };
  },
  receipt: async (id) => runRec(id).receipt ?? fail(404, 'run has no receipt (yet)'),
  verify: async (receipt) => verifyReceipt(receipt, { rerun: true }),
  tla: async (id) => {
    const c = compileSource(revisionById(runRec(id).view.revision.id).r.source);
    if (!c.ok) return fail(422, 'model does not compile');
    const ex = exportTla(c.model!);
    return { moduleName: ex.moduleName, tla: ex.tla, cfg: ex.cfgAll, configs: ex.configs };
  },
  tlc: async () => ({ available: false, status: 'INTERNAL_ONLY', reason: 'The TLC cross-check needs the full app (it runs Java).', pin: { release: '', sha256: '', url: '' } }),
  annotate: async (id, property, text) => {
    const r = runRec(id);
    r.view.annotations.push({ id: r.view.annotations.length + 1, property: property.slice(0, 64), text: text.slice(0, 2000), created_at: now() });
    return { annotations: [...r.view.annotations] };
  },
};

/** The self-contained HTML report (the same renderer the server uses), as a download in the browser. */
export const demoReportHtml = (id: string): string => { const r = runRec(id); return renderReport(view(r) as never, (r.receipt as never) ?? null); };
