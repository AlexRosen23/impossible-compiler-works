// HTTP API. Loopback only; JSON in and out; every body size-capped; untrusted FOLIO source is only ever parsed
// and executed by the core (never by JavaScript eval). The Constellation contract is the read-only quartet
// GET /health, /capabilities, /runs, /runs/{id}; everything under /api is for the IDE.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BYTECODE_VERSION, COMPILER_VERSION, DEFAULT_LIMITS, DIAGNOSTIC_CODES, FAULT_CODES, FIXTURE_NAME, GRAMMAR_VERSION, IR_VERSION,
  type FixtureTable, type PassName, RECEIPT_FORMAT, type Receipt, SAFE_PASSES, SCENE_FORMAT, canonicalJson, compile, interpret,
  makeReceipt, printModule, reproduce, sha256,
} from '../core/index.ts';

export interface AppConfig { db: DatabaseSync; root: string; commit: string | null; startedAt: number; maxBody?: number }
const PASSES = new Set<PassName>([...SAFE_PASSES, 'BAD_cse_commute_all']);

export class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export function loadFixtureLibrary(root: string): FixtureTable {
  const dir = join(root, 'examples', 'fixtures');
  const out: FixtureTable = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && FIXTURE_NAME.test(f.slice(0, -5))) out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
}

export function loadExamples(root: string) {
  const dir = join(root, 'examples');
  const read = (d: string, f: string) => readFileSync(join(d, f), 'utf8');
  const title = (src: string) => /scene\s+"([^"]*)"/.exec(src)?.[1] ?? '';
  const blurb = (src: string) => /^\/\/ (.*)$/m.exec(src)?.[1] ?? '';
  return {
    examples: readdirSync(dir).filter((f) => /^\d\d-.*\.folio$/.test(f)).sort().map((f) => { const s = read(dir, f); return { id: f.replace('.folio', ''), title: title(s), blurb: blurb(s), source: s }; }),
    failures: readdirSync(join(dir, 'failures')).filter((f) => f.endsWith('.folio')).sort().map((f) => {
      const s = read(join(dir, 'failures'), f);
      const m = /^\/\/ expect(-fault)?: ([A-Z]\d{3}) @ (\d+):(\d+)/.exec(s);
      return { id: f.replace('.folio', ''), title: title(s), source: s, expect: m ? { kind: m[1] ? 'fault' : 'compile', code: m[2], line: Number(m[3]), col: Number(m[4]) } : null };
    }),
    faultLab: { id: 'fault-lab-commute', title: title(read(dir, 'fault-lab-commute.folio')), source: read(dir, 'fault-lab-commute.folio') },
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 413 ? { connection: 'close' } : {}) });
  res.end(s);
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'send application/json');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    // Over the cap: stop keeping data but keep draining (bounded) so the client sees a clean 413 instead of a
    // connection reset mid-upload; past 16x the cap, drop the connection.
    if (n > max) { if (n > max * 16) { req.destroy(); break; } continue; }
    chunks.push(c as Buffer);
  }
  if (n > max) throw new HttpError(413, `body over ${max} bytes`);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

const str = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  if (v.length > max) throw new HttpError(413, `${name} is over ${max} characters`);
  return v;
};
const passesOf = (v: unknown): PassName[] => {
  if (v === undefined) return SAFE_PASSES;
  if (!Array.isArray(v) || v.length > 8 || !v.every((p) => PASSES.has(p))) throw new HttpError(400, `passes must be a list drawn from ${[...PASSES].join(', ')}`);
  return v as PassName[];
};
/** A project's fixture table: names only from the server's library, or inline tables that pass validation. */
function fixturesOf(v: unknown, library: FixtureTable): FixtureTable {
  if (v === undefined) return {};
  if (Array.isArray(v)) {
    const out: FixtureTable = {};
    for (const n of v) {
      if (typeof n !== 'string' || !FIXTURE_NAME.test(n)) throw new HttpError(400, `"${String(n).slice(0, 40)}" is not a fixture name`);
      if (!(n in library)) throw new HttpError(404, `no fixture "${n}" in the library`);
      out[n] = library[n];
    }
    return out;
  }
  if (typeof v !== 'object' || v === null) throw new HttpError(400, 'fixtures must be a list of names or a table');
  const t = v as Record<string, unknown>;
  if (Object.keys(t).length > 16) throw new HttpError(413, 'at most 16 fixtures');
  for (const [k, x] of Object.entries(t)) {
    if (!FIXTURE_NAME.test(k)) throw new HttpError(400, `"${k.slice(0, 40)}" is not a fixture name`);
    if (!Array.isArray(x) || x.length > DEFAULT_LIMITS.maxFixtureLength) throw new HttpError(400, `fixture "${k}" must be a list of at most ${DEFAULT_LIMITS.maxFixtureLength} items`);
  }
  return t;
}

type Row = Record<string, unknown>;
function runSummary(r: Row) {
  return { id: r.id, project: r.project_id, version: r.version_id, createdAt: r.created_at, sourceHash: r.source_hash, bytecodeHash: r.bytecode_hash, sceneHash: r.scene_hash, traceHash: r.trace_hash, oracleAgrees: r.agrees === 1, fault: r.fault ? JSON.parse(String(r.fault)) : null, passes: JSON.parse(String(r.passes)), timingMs: JSON.parse(String(r.timing)) };
}

export function createHandler(cfg: AppConfig) {
  const { db } = cfg;
  const maxBody = cfg.maxBody ?? 512 * 1024;
  const library = loadFixtureLibrary(cfg.root);
  const corpus = loadExamples(cfg.root);

  const headVersion = (projectId: string) => db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as Row | undefined;
  const project = (id: string) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    if (!p) throw new HttpError(404, 'no such project');
    return p;
  };
  const addVersion = (projectId: string, parent: string | null, source: string, fixtures: FixtureTable, message: string) => {
    const head = headVersion(projectId);
    const seq = head ? Number(head.seq) + 1 : 1;
    const id = `${projectId}:v${seq}`;
    db.prepare('INSERT INTO versions (id, project_id, parent_id, seq, source, source_hash, fixtures, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, parent, seq, source, sha256(source), JSON.stringify(fixtures), message.slice(0, 200), new Date().toISOString());
    return id;
  };
  const projectView = (id: string) => {
    const p = project(id);
    const versions = db.prepare('SELECT id, seq, parent_id, source_hash, message, created_at FROM versions WHERE project_id = ? ORDER BY seq DESC').all(id) as Row[];
    const head = headVersion(id)!;
    return { id: p.id, name: p.name, createdAt: p.created_at, forkedFrom: p.forked_from, head: { id: head.id, seq: head.seq, source: head.source, fixtures: JSON.parse(String(head.fixtures)) }, versions };
  };
  const createProject = (name: string, source: string, fixtures: FixtureTable, forkedFrom: string | null) => {
    const id = randomUUID().slice(0, 8);
    db.prepare('INSERT INTO projects (id, name, created_at, forked_from) VALUES (?, ?, ?, ?)').run(id, name, new Date().toISOString(), forkedFrom);
    addVersion(id, forkedFrom, source, fixtures, forkedFrom ? `forked from ${forkedFrom}` : 'created');
    return projectView(id);
  };

  const record = (projectName: string, projectId: string | null, versionId: string | null, source: string, fixtures: FixtureTable, passes: PassName[]) => {
    const { receipt, compiled } = makeReceipt({ project: projectName, source, fixtures, passes, commit: cfg.commit });
    if (!receipt) return { ok: false, diagnostics: compiled.diagnostics };
    // Content-addressed: identical inputs and results give the same id (timing is not part of the digest).
    const id = receipt.digest.slice(0, 16);
    const existing = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
    if (!existing) {
      db.prepare('INSERT INTO runs (id, project_id, version_id, created_at, source_hash, bytecode_hash, scene_hash, trace_hash, agrees, fault, passes, timing, receipt, bytecode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, versionId, receipt.createdAt, receipt.sourceHash, receipt.bytecodeHash, receipt.sceneHash, receipt.traceHash, receipt.oracle.agrees ? 1 : 0, receipt.fault ? JSON.stringify(receipt.fault) : null, JSON.stringify(passes), JSON.stringify(receipt.timingMs), JSON.stringify(receipt), JSON.stringify(compiled.bytecode));
    }
    return { ok: true, id, deduplicated: !!existing, receipt, diagnostics: compiled.diagnostics };
  };

  const getRun = (id: string) => {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'run ids are 16 hex characters');
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'no such run');
    return r;
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // DNS-rebinding defence: only loopback Host headers are served.
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(421, 'loopback hosts only');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const m = req.method ?? 'GET';
      const seg = path.split('/').filter(Boolean);

      // --- Constellation contract (read-only) ---------------------------------------------------
      if (m === 'GET' && path === '/health') return send(res, 200, { ok: true, service: 'paper-tiger-compiler-works', version: COMPILER_VERSION, commit: cfg.commit, uptimeSeconds: Math.round((Date.now() - cfg.startedAt) / 1000), runs: (db.prepare('SELECT COUNT(*) n FROM runs').get() as Row).n });
      if (m === 'GET' && path === '/capabilities') return send(res, 200, {
        language: 'FOLIO', versions: { compiler: COMPILER_VERSION, grammar: GRAMMAR_VERSION, ir: IR_VERSION, bytecode: BYTECODE_VERSION, scene: SCENE_FORMAT, receipt: RECEIPT_FORMAT },
        stages: ['lex+parse', 'check', 'fixtures', 'lower', 'optimize', 'codegen', 'verify', 'vm', 'reference'], passes: SAFE_PASSES, faultLabPasses: ['BAD_cse_commute_all'],
        limits: DEFAULT_LIMITS, diagnostics: Object.keys(DIAGNOSTIC_CODES).length, faults: Object.keys(FAULT_CODES), examples: corpus.examples.length, failureCases: corpus.failures.length,
        readOnlyContract: ['GET /health', 'GET /capabilities', 'GET /runs', 'GET /runs/{id}'],
      });
      if (m === 'GET' && path === '/runs') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
        return send(res, 200, { runs: (db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(runSummary) });
      }
      if (m === 'GET' && seg[0] === 'runs' && seg.length === 2) { const r = getRun(seg[1]); return send(res, 200, { ...runSummary(r), receipt: JSON.parse(String(r.receipt)) }); }

      // --- IDE API -----------------------------------------------------------------------------
      if (seg[0] !== 'api') throw new HttpError(404, 'not found');
      if (m === 'GET' && path === '/api/corpus') return send(res, 200, corpus);
      if (m === 'GET' && path === '/api/fixtures') return send(res, 200, { fixtures: library });
      if (m === 'GET' && seg[1] === 'runs' && seg.length === 4 && seg[3] === 'bytecode') return send(res, 200, JSON.parse(String(getRun(seg[2]).bytecode)));
      if (m === 'GET' && seg[1] === 'runs' && seg.length === 4 && seg[3] === 'bundle') {
        const r = getRun(seg[2]);
        const receipt = JSON.parse(String(r.receipt)) as Receipt;
        const c = compile(receipt.source, { passes: receipt.optimizations, fixtures: receipt.fixtures });
        const ref = c.ok ? interpret(c.program!, c.check!, c.data, c.limits) : null;
        const bundle = {
          manifest: { format: 'paper-tiger-bundle/0.1', run: r.id, files: ['receipt', 'source', 'fixtures', 'ir', 'bytecode', 'scene'], exportedAt: new Date().toISOString() },
          receipt, source: receipt.source, fixtures: receipt.fixtures, ir: c.ok ? printModule(c.irOptimized!) : null, bytecode: JSON.parse(String(r.bytecode)), scene: ref?.scene ?? null,
        };
        res.setHeader('content-disposition', `attachment; filename="paper-tiger-run-${r.id}.json"`);
        return send(res, 200, bundle);
      }
      if (m === 'POST' && path === '/api/runs') {
        const b = (await readJson(req, maxBody)) as Row;
        const source = str(b.source, 'source', DEFAULT_LIMITS.maxSourceChars);
        const name = b.project === undefined ? 'scratch' : str(b.project, 'project', 80);
        let projectId: string | null = null, versionId: string | null = null;
        if (typeof b.projectId === 'string') { project(b.projectId); projectId = b.projectId; versionId = (headVersion(projectId)?.id as string) ?? null; }
        const out = record(name, projectId, versionId, source, fixturesOf(b.fixtures, library), passesOf(b.passes));
        return send(res, out.ok ? 201 : 422, out);
      }
      if (m === 'POST' && path === '/api/reproduce') {
        const b = (await readJson(req, maxBody * 4)) as Row;
        const checks = reproduce(b.receipt as Receipt, b.bytecode);
        return send(res, 200, { reproduced: checks.every((c) => c.ok), checks });
      }
      if (m === 'GET' && path === '/api/projects') return send(res, 200, { projects: db.prepare('SELECT p.id, p.name, p.created_at, p.forked_from, (SELECT MAX(seq) FROM versions v WHERE v.project_id = p.id) AS head FROM projects p ORDER BY p.created_at DESC').all() });
      if (m === 'POST' && path === '/api/projects') {
        const b = (await readJson(req, maxBody)) as Row;
        return send(res, 201, createProject(str(b.name, 'name', 80) || 'untitled', str(b.source, 'source', DEFAULT_LIMITS.maxSourceChars), fixturesOf(b.fixtures, library), null));
      }
      if (seg[1] === 'projects' && seg[2]) {
        const id = seg[2];
        if (!/^[0-9a-f-]{1,36}$/.test(id)) throw new HttpError(400, 'bad project id');
        if (m === 'GET' && seg.length === 3) return send(res, 200, projectView(id));
        if (m === 'GET' && seg[3] === 'versions' && seg[4]) {
          const v = db.prepare('SELECT * FROM versions WHERE project_id = ? AND seq = ?').get(id, Number(seg[4])) as Row | undefined;
          if (!v) throw new HttpError(404, 'no such version');
          return send(res, 200, { id: v.id, seq: v.seq, source: v.source, fixtures: JSON.parse(String(v.fixtures)), message: v.message, createdAt: v.created_at });
        }
        if (m === 'POST' && seg[3] === 'versions') {
          // Optimistic concurrency: a save names the version it was edited from; if the head moved, refuse.
          const b = (await readJson(req, maxBody)) as Row;
          project(id);
          const head = headVersion(id)!;
          if (b.baseVersion !== head.id) return send(res, 409, { error: 'conflict', message: `this project was saved elsewhere: you edited ${String(b.baseVersion)}, the latest is ${String(head.id)}`, head: { id: head.id, seq: head.seq, source: head.source } });
          const source = str(b.source, 'source', DEFAULT_LIMITS.maxSourceChars);
          if (source === head.source && canonicalJson(JSON.parse(String(head.fixtures))) === canonicalJson(b.fixtures ?? JSON.parse(String(head.fixtures)))) return send(res, 200, { unchanged: true, ...projectView(id) });
          addVersion(id, String(head.id), source, b.fixtures === undefined ? JSON.parse(String(head.fixtures)) : fixturesOf(b.fixtures, library), typeof b.message === 'string' ? b.message : 'saved');
          return send(res, 201, projectView(id));
        }
        if (m === 'POST' && seg[3] === 'restore') {
          const b = (await readJson(req, maxBody)) as Row;
          const v = db.prepare('SELECT * FROM versions WHERE project_id = ? AND seq = ?').get(id, Number(b.seq)) as Row | undefined;
          if (!v) throw new HttpError(404, 'no such version');
          addVersion(id, String(headVersion(id)!.id), String(v.source), JSON.parse(String(v.fixtures)), `restored v${v.seq}`);
          return send(res, 201, projectView(id));
        }
        if (m === 'POST' && seg[3] === 'fork') {
          const b = (await readJson(req, maxBody)) as Row;
          const p = project(id);
          const v = (b.seq !== undefined ? db.prepare('SELECT * FROM versions WHERE project_id = ? AND seq = ?').get(id, Number(b.seq)) : headVersion(id)) as Row | undefined;
          if (!v) throw new HttpError(404, 'no such version');
          return send(res, 201, createProject(typeof b.name === 'string' ? b.name.slice(0, 80) : `${String(p.name)} (fork)`, String(v.source), JSON.parse(String(v.fixtures)), String(v.id)));
        }
      }
      if (m === 'POST' && path === '/api/import') {
        // Imported bundles are untrusted: size-capped, shape-checked, and the receipt must reproduce here.
        const b = (await readJson(req, maxBody * 4)) as Row;
        const receipt = (b.receipt ?? null) as Receipt | null;
        if (!receipt || typeof receipt !== 'object') throw new HttpError(400, 'bundle has no receipt');
        const checks = reproduce(receipt, b.bytecode);
        if (!checks.every((c) => c.ok)) return send(res, 422, { imported: false, checks });
        const p = createProject(`${String(receipt.project).slice(0, 60)} (imported)`, str(receipt.source, 'source', DEFAULT_LIMITS.maxSourceChars), fixturesOf(receipt.fixtures, library), null);
        return send(res, 201, { imported: true, project: p, checks });
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'internal error' });
    }
  };
}
