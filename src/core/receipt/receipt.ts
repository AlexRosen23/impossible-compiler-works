// Evidence receipts: a self-describing, content-addressed record of one bounded check.
// A receipt is verified by (1) schema checks, (2) its digest, (3) the source hash,
// (4) re-running the checker from the embedded source with the recorded bounds and
// (5) replaying every witness with the independent evaluator. See docs/REPRODUCIBILITY.md.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { compileSource } from '../model/compile.ts';
import { check, type CheckResult, type Trace } from '../engine/check.ts';
import { ENGINE_NAME, ENGINE_VERSION, type Bounds } from '../engine/explore.ts';
import { replayTrace, REPLAY_NAME, REPLAY_VERSION, type ReplayResult } from '../replay/replay.ts';

export const RECEIPT_SCHEMA = 'impossible-witness/receipt';
export const RECEIPT_SCHEMA_VERSION = 1;
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number in canonical JSON');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof v}`);
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface WitnessRecord {
  property: string;
  kind: Trace['kind'];
  steps: { action: string | null; state: Record<string, number | boolean | string>; stutter?: boolean }[];
  loopStart?: number;
  stutterForever?: boolean;
  badWrite?: { variable: string; value: number };
  length: number;
  traceHash: string;
}

export interface TlcRecord {
  available: boolean;
  version?: string;
  jarSha256?: string;
  runtime?: string;
  results?: { property: string; status: string; distinctStates?: number; traceLength?: number }[];
  comparison?: { property: string; internal: string; tlc: string; agree: boolean; note: string }[];
  note: string;
}

export interface Receipt {
  schema: string;
  schemaVersion: number;
  createdAt: string;
  model: {
    name: string;
    title: string;
    language: string;
    source: string;
    sourceSha256: string;
    variables: { name: string; type: string }[];
    properties: { name: string; kind: string; text: string }[];
    fairness: string[];
  };
  checker: { engine: string; version: string; order: string; replay: string; node: string };
  bounds: Bounds;
  result: {
    verdict: CheckResult['verdict'];
    complete: boolean;
    capReason: string | null;
    states: number;
    edges: number;
    maxDepth: number;
    deadlocks: number;
    properties: { name: string; status: string; violatingStates?: number; traceHash?: string; traceLength?: number }[];
  };
  witnesses: WitnessRecord[];
  replay: { property: string; ok: boolean; reason: string }[];
  tlc?: TlcRecord;
  runtime: { elapsedMs: number; peakHeapMB: number; platform: string; cpu: string };
  git: { commit: string; dirty: boolean | null };
  limitations: string[];
  annotation?: string;
  digest: string;
}

export function gitInfo(cwd = process.cwd()): Receipt['git'] {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: 'unknown', dirty: null };
  }
}

export function witnessFromTrace(t: Trace): WitnessRecord {
  return {
    property: t.property, kind: t.kind,
    steps: t.steps.map((s) => (s.stutter ? { action: null, state: s.state, stutter: true } : { action: s.action, state: s.state })),
    loopStart: t.loopStart, stutterForever: t.stutterForever, badWrite: t.badWrite, length: t.length, traceHash: t.traceHash,
  };
}

export function replayWitness(source: string, w: WitnessRecord): ReplayResult {
  const claimKind = w.kind === 'eval-error' ? 'none' : w.kind;
  return replayTrace(source, w.steps, { kind: claimKind, property: w.property, loopStart: w.loopStart, stutterForever: w.stutterForever, badWrite: w.badWrite });
}

export function digestOf(r: Omit<Receipt, 'digest'> & { digest?: string }): string {
  const { digest: _d, ...rest } = r;
  return sha256(canonicalJson(rest));
}

export function buildReceipt(source: string, result: CheckResult, opts: { tlc?: TlcRecord; annotation?: string; createdAt?: string } = {}): Receipt {
  const witnesses = result.properties.filter((p) => p.trace).map((p) => witnessFromTrace(p.trace!));
  const replay = witnesses.map((w) => {
    const r = replayWitness(source, w);
    return { property: w.property, ok: r.ok, reason: r.reason };
  });
  const body: Omit<Receipt, 'digest'> = {
    schema: RECEIPT_SCHEMA,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    model: {
      name: result.model.name, title: result.model.title, language: 'WML/1', source, sourceSha256: sha256(source),
      variables: result.model.vars.map((v) => ({ name: v.name, type: v.type })),
      properties: result.properties.map((p) => ({ name: p.name, kind: p.kind, text: p.text })),
      fairness: result.model.fairness,
    },
    checker: { engine: ENGINE_NAME, version: ENGINE_VERSION, order: result.engine.order, replay: `${REPLAY_NAME}@${REPLAY_VERSION}`, node: process.version },
    bounds: result.bounds,
    result: {
      verdict: result.verdict, complete: result.complete, capReason: result.capReason, states: result.stats.states, edges: result.stats.edges,
      maxDepth: result.stats.maxDepth, deadlocks: result.stats.deadlocks,
      properties: result.properties.map((p) => ({ name: p.name, status: p.status, violatingStates: p.violatingStates, traceHash: p.trace?.traceHash, traceLength: p.trace?.length })),
    },
    witnesses,
    replay,
    tlc: opts.tlc,
    runtime: { elapsedMs: result.stats.elapsedMs, peakHeapMB: result.stats.peakHeapMB, platform: `${os.platform()}-${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown' },
    git: gitInfo(),
    limitations: result.limitations,
    annotation: opts.annotation,
  };
  return { ...body, digest: digestOf(body) };
}

export interface VerifyCheck { name: string; ok: boolean; detail: string }
export interface VerifyReport { ok: boolean; verdict: 'VALID' | 'REJECTED'; checks: VerifyCheck[] }

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Verify a receipt. Never trusts any field it can recompute. */
export function verifyReceipt(input: unknown, opts: { rerun?: boolean } = {}): VerifyReport {
  const checks: VerifyCheck[] = [];
  const done = (): VerifyReport => {
    const ok = checks.every((c) => c.ok);
    return { ok, verdict: ok ? 'VALID' : 'REJECTED', checks };
  };
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok; };

  if (!isObj(input)) { add('schema', false, 'receipt is not a JSON object'); return done(); }
  const r = input as unknown as Receipt;
  if (!add('schema', r.schema === RECEIPT_SCHEMA && r.schemaVersion === RECEIPT_SCHEMA_VERSION,
    r.schema === RECEIPT_SCHEMA ? `schema version ${String(r.schemaVersion)} (supported: ${RECEIPT_SCHEMA_VERSION})` : `unknown schema '${String(r.schema).slice(0, 60)}'`)) return done();
  const shapeOk = isObj(r.model) && typeof r.model.source === 'string' && typeof r.digest === 'string' && isObj(r.result) && Array.isArray(r.witnesses) && isObj(r.bounds);
  if (!add('structure', shapeOk, shapeOk ? 'required fields present' : 'missing or mistyped required fields')) return done();
  let canon: string;
  try { canon = canonicalJson(r); } catch (e) { add('structure', false, (e as Error).message); return done(); }
  if (canon.length > MAX_RECEIPT_BYTES) { add('size', false, 'receipt too large'); return done(); }

  const d = digestOf(r);
  add('digest', d === r.digest, d === r.digest ? `sha256 ${d.slice(0, 16)}… matches` : `recorded ${String(r.digest).slice(0, 16)}… but content hashes to ${d.slice(0, 16)}… — the receipt was modified after it was issued`);
  const sh = sha256(r.model.source);
  add('source-hash', sh === r.model.sourceSha256, sh === r.model.sourceSha256 ? 'embedded model source matches its recorded hash' : 'embedded model source does not match sourceSha256');

  const comp = compileSource(r.model.source);
  if (!add('compiles', comp.ok, comp.ok ? 'model source compiles' : `model does not compile: ${comp.diagnostics[0]?.message ?? ''}`)) return done();

  // Independent replay of every witness.
  for (const w of r.witnesses) {
    const rr = replayWitness(r.model.source, w);
    add(`replay:${w.property}`, rr.ok, rr.reason);
    const th = w.steps ? recomputeTraceHash(w) : '';
    add(`trace-hash:${w.property}`, th === w.traceHash, th === w.traceHash ? 'trace hash matches its steps' : 'trace steps do not match the recorded trace hash');
  }

  if (opts.rerun !== false) {
    let bounds: Bounds;
    try {
      bounds = r.bounds;
      const { result } = check(comp.model!, { bounds, includeGraph: false });
      const same = (a: unknown, b: unknown) => a === b;
      add('rerun:verdict', same(result.verdict, r.result.verdict), `re-run verdict ${result.verdict}; receipt says ${r.result.verdict}`);
      add('rerun:completeness', same(result.complete, r.result.complete) && same(result.capReason, r.result.capReason), `re-run complete=${result.complete} cap=${result.capReason}; receipt says complete=${r.result.complete} cap=${r.result.capReason}`);
      add('rerun:counts', same(result.stats.states, r.result.states) && same(result.stats.edges, r.result.edges), `re-run ${result.stats.states} states / ${result.stats.edges} edges; receipt says ${r.result.states} / ${r.result.edges}`);
      const capIsTime = result.capReason === 'timeLimitMs' || r.result.capReason === 'timeLimitMs';
      if (capIsTime) add('rerun:note', true, 'time-capped runs are not exactly reproducible; counts may differ');
      for (const p of result.properties) {
        const rec = r.result.properties.find((x) => x.name === p.name);
        add(`rerun:${p.name}`, !!rec && rec.status === p.status && (rec.traceHash ?? null) === (p.trace?.traceHash ?? null),
          rec ? `re-run ${p.status}${p.trace ? ` (trace ${p.trace.traceHash.slice(0, 12)}…)` : ''}; receipt says ${rec.status}${rec.traceHash ? ` (trace ${rec.traceHash.slice(0, 12)}…)` : ''}` : 'property missing from receipt');
      }
      if (r.result.properties.length !== result.properties.length) add('rerun:property-set', false, 'receipt lists a different set of properties');
    } catch (e) {
      add('rerun', false, `re-run failed: ${(e as Error).message}`);
    }
  }
  return done();
}

function recomputeTraceHash(w: WitnessRecord): string {
  const steps = w.steps.map((s) => ({ a: s.action, s: s.state, st: !!s.stutter }));
  const extra = w.kind === 'liveness' ? { loopStart: w.loopStart, stutter: w.stutterForever } : {};
  return sha256(JSON.stringify({ steps, ...extra }));
}
