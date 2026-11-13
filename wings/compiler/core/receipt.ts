// Run receipts: everything needed to reproduce a run, plus the hashes it must reproduce to. A receipt is
// self-contained (source and fixtures are embedded) so `npm run reproduce receipt.json` needs nothing else.
import { type FixtureTable } from './fixtures.ts';
import { interpret } from './interpreter.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import type { PassName } from './optimize.ts';
import { type CompileResult, compile } from './pipeline.ts';
import { sceneHash } from './scene.ts';
import { canonicalJson, sha256 } from './sha256.ts';
import { loadBytecode } from './bytecode.ts';
import { runVM } from './vm.ts';
import { BYTECODE_VERSION, COMPILER_VERSION, GRAMMAR_VERSION, IR_VERSION, RECEIPT_FORMAT, SCENE_FORMAT } from './version.ts';

export interface Receipt {
  format: string;
  versions: { compiler: string; grammar: string; ir: string; bytecode: string; scene: string };
  project: string;
  files: { name: string; sha256: string }[];
  source: string;
  sourceHash: string;
  fixtures: FixtureTable;
  fixtureHash: string;
  optimizations: PassName[];
  /** FOLIO has no randomness; recorded so the receipt format can carry one if that ever changes. */
  seed: null;
  limits: Pick<Limits, RunLimitName>;
  bytecodeHash: string;
  traceHash: string;
  sceneHash: string;
  fault: { code: string; frame: number; line: number | null } | null;
  /** status: agree (identical scene and fault), diverge, vm-resource-limit (the VM stopped on its own fuel or
   * stack, a machine limit the interpreter does not share) or reference-resource-limit (the interpreter stopped on
   * its own evaluation budget). After a resource limit only the prefix before it is comparable. */
  oracle: { engine: 'reference-interpreter'; sceneHash: string; agrees: boolean; status: OracleStatus };
  warnings: string[];
  timingMs: { compile: number; vm: number; reference: number };
  commit: string | null;
  createdAt: string;
  /** sha256 over every field above except timingMs and createdAt (which legitimately vary). */
  digest: string;
}

export function receiptDigest(r: Omit<Receipt, 'digest'> | Receipt): string {
  const { timingMs: _t, createdAt: _c, digest: _d, ...rest } = r as Receipt;
  return sha256(canonicalJson(rest));
}

/** The run-time limits a receipt pins (compile-time limits are fixed by the compiler version). */
export const RUN_LIMITS = ['fuelPerFrame', 'fuelPerRun', 'refFuelPerFrame', 'refFuelPerRun', 'maxIterationsPerFrame', 'maxCallsPerFrame', 'maxDrawsPerFrame', 'maxSceneUnitsPerFrame', 'maxSceneUnits', 'maxStack', 'maxCallDepth'] as const;
export type RunLimitName = (typeof RUN_LIMITS)[number];
const pinLimits = (l: Limits): Pick<Limits, RunLimitName> => Object.fromEntries(RUN_LIMITS.map((k) => [k, l[k]])) as Pick<Limits, RunLimitName>;

export type OracleStatus = 'agree' | 'diverge' | 'vm-resource-limit' | 'reference-resource-limit';
export function oracleStatus(vm: { fault: { code: string; span: { start: number } | null } | null }, vmHash: string, ref: { fault: { code: string; span: { start: number } | null } | null }, refHash: string): OracleStatus {
  if (vm.fault && (vm.fault.code === 'R006' || vm.fault.code === 'R007')) return 'vm-resource-limit';
  if (ref.fault && ref.fault.code === 'R014') return 'reference-resource-limit';
  const faultsAgree = (vm.fault?.code ?? null) === (ref.fault?.code ?? null) && (vm.fault?.span?.start ?? null) === (ref.fault?.span?.start ?? null);
  return vmHash === refHash && faultsAgree ? 'agree' : 'diverge';
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface MakeReceiptInput { project: string; source: string; fixtures: FixtureTable; passes: PassName[]; commit?: string | null; limits?: Limits }
export function makeReceipt(inp: MakeReceiptInput): { receipt: Receipt | null; compiled: CompileResult } {
  const limits = inp.limits ?? DEFAULT_LIMITS;
  const t0 = now();
  const c = compile(inp.source, { passes: inp.passes, fixtures: inp.fixtures, limits });
  const t1 = now();
  if (!c.ok) return { receipt: null, compiled: c };
  const vm = runVM(c.bytecode!, c.data, limits);
  const t2 = now();
  const ref = interpret(c.program!, c.check!, c.data, limits);
  const t3 = now();
  const vmHash = sceneHash(vm.scene), refHash = sceneHash(ref.scene);
  const status = oracleStatus(vm, vmHash, ref, refHash);
  const body: Omit<Receipt, 'digest'> = {
    format: RECEIPT_FORMAT,
    versions: { compiler: COMPILER_VERSION, grammar: GRAMMAR_VERSION, ir: IR_VERSION, bytecode: BYTECODE_VERSION, scene: SCENE_FORMAT },
    project: inp.project,
    files: [{ name: 'main.folio', sha256: c.sourceHash }],
    source: inp.source,
    sourceHash: c.sourceHash,
    fixtures: inp.fixtures,
    fixtureHash: sha256(canonicalJson(inp.fixtures)),
    optimizations: inp.passes,
    seed: null,
    limits: pinLimits(limits),
    bytecodeHash: c.bytecode!.hash,
    traceHash: vm.traceHash,
    sceneHash: vmHash,
    fault: vm.fault ? { code: vm.fault.code, frame: vm.fault.frame, line: vm.fault.span?.line ?? null } : null,
    oracle: { engine: 'reference-interpreter', sceneHash: refHash, agrees: status === 'agree', status },
    warnings: c.diagnostics.filter((d) => d.severity === 'warning').map((d) => `${d.code}@${d.span.line}:${d.span.col}`),
    timingMs: { compile: round(t1 - t0), vm: round(t2 - t1), reference: round(t3 - t2) },
    commit: inp.commit ?? null,
    createdAt: new Date().toISOString(),
  };
  return { receipt: { ...body, digest: receiptDigest(body) }, compiled: c };
}
const round = (x: number) => Math.round(x * 1000) / 1000;

export interface ReproduceCheck { name: string; ok: boolean; expected?: string; actual?: string }
/** Independently recompile and re-run a receipt; every field that can be recomputed is compared. */
export function reproduce(r: Receipt, bytecodeArtifact?: unknown): ReproduceCheck[] {
  const checks: ReproduceCheck[] = [];
  // Receipts are untrusted input: their shape is checked before anything is hashed, compiled or run, and any
  // failure past that point is reported as a failed check, never thrown.
  const shape = receiptShape(r);
  if (shape) return [{ name: 'receipt is well formed', ok: false, actual: shape }];
  try {
    reproduceChecked(r, bytecodeArtifact, checks);
  } catch (e) {
    checks.push({ name: 'reproduction completed', ok: false, actual: String((e as Error)?.message ?? e).slice(0, 200) });
  }
  return checks;
}

const PASS_NAMES = new Set<string>(['constfold', 'dce', 'cse', 'BAD_cse_commute_all']);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Why a receipt cannot be reproduced at all, or null. Bounds mirror what the server and compiler accept. */
export function receiptShape(r: unknown): string | null {
  if (!plain(r)) return 'not an object';
  if (typeof r.source !== 'string' || r.source.length > DEFAULT_LIMITS.maxSourceChars) return 'source must be a string within the source-size limit';
  if (!plain(r.fixtures) || Object.keys(r.fixtures).length > 16) return 'fixtures must be an object of at most 16 tables';
  for (const v of Object.values(r.fixtures)) if (!Array.isArray(v) || v.length > DEFAULT_LIMITS.maxFixtureLength || !v.every((x) => typeof x !== 'object' || (Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === 'number')))) return 'each fixture must be a flat list (points as [x, y])';
  if (!Array.isArray(r.optimizations) || r.optimizations.length > 8 || !r.optimizations.every((p) => typeof p === 'string' && PASS_NAMES.has(p))) return 'optimizations must be at most 8 known pass names';
  if (!plain(r.limits) || Object.keys(r.limits).length > RUN_LIMITS.length) return 'limits must be an object';
  if (!plain(r.oracle) || !plain(r.versions)) return 'oracle and versions must be objects';
  for (const k of ['digest', 'sourceHash', 'fixtureHash', 'bytecodeHash', 'traceHash', 'sceneHash', 'format', 'project']) if (typeof r[k] !== 'string' || (r[k] as string).length > 200) return `${k} must be a short string`;
  return null;
}

function reproduceChecked(r: Receipt, bytecodeArtifact: unknown, checks: ReproduceCheck[]): void {
  const add = (name: string, expected: unknown, actual: unknown) => checks.push({ name, ok: canonicalJson(expected) === canonicalJson(actual), expected: String(expected), actual: String(actual) });
  add('receipt format', RECEIPT_FORMAT, r.format);
  add('receipt digest (no field edited)', r.digest, receiptDigest(r));
  add('compiler version', COMPILER_VERSION, r.versions?.compiler);
  add('bytecode version', BYTECODE_VERSION, r.versions?.bytecode);
  add('source hash', r.sourceHash, sha256(r.source ?? ''));
  add('fixture hash', r.fixtureHash, sha256(canonicalJson(r.fixtures ?? {})));
  // A receipt may lower limits but never raise them past this host's defaults (imported receipts are untrusted).
  const limits: Limits = { ...DEFAULT_LIMITS };
  let within = true;
  for (const [k, v] of Object.entries(r.limits ?? {})) {
    const cap = (RUN_LIMITS as readonly string[]).includes(k) ? (DEFAULT_LIMITS as unknown as Record<string, number>)[k] : undefined;
    if (cap === undefined || typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > cap) { within = false; continue; }
    (limits as unknown as Record<string, number>)[k] = v;
  }
  checks.push({ name: "receipt limits within this host's caps", ok: within, actual: within ? 'ok' : 'a limit is missing, invalid or above the host default' });
  if (!within) return;
  const c = compile(r.source ?? '', { passes: r.optimizations ?? [], fixtures: r.fixtures ?? {}, limits });
  if (!c.ok) { checks.push({ name: 'recompile', ok: false, actual: c.diagnostics.map((d) => d.code).join(',') }); return; }
  add('bytecode hash', r.bytecodeHash, c.bytecode!.hash);
  if (bytecodeArtifact !== undefined) {
    const loaded = loadBytecode(bytecodeArtifact, limits);
    checks.push({ name: 'exported bytecode artifact loads and verifies', ok: loaded.errors.length === 0, actual: loaded.errors.join('; ') || 'ok' });
    if (loaded.module) add('exported bytecode artifact hash', r.bytecodeHash, (bytecodeArtifact as { hash: string }).hash);
  }
  const vm = runVM(c.bytecode!, c.data, limits);
  add('trace hash', r.traceHash, vm.traceHash);
  add('scene hash (VM)', r.sceneHash, sceneHash(vm.scene));
  const ref = interpret(c.program!, c.check!, c.data, limits);
  add('scene hash (independent reference interpreter)', r.oracle?.sceneHash, sceneHash(ref.scene));
  add('oracle verdict reproduces', r.oracle?.status, oracleStatus(vm, sceneHash(vm.scene), ref, sceneHash(ref.scene)));
}
