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
  limits: Pick<Limits, 'fuelPerFrame' | 'maxIterationsPerFrame' | 'maxDrawsPerFrame' | 'maxStack' | 'maxCallDepth'>;
  bytecodeHash: string;
  traceHash: string;
  sceneHash: string;
  fault: { code: string; frame: number; line: number | null } | null;
  oracle: { engine: 'reference-interpreter'; sceneHash: string; agrees: boolean };
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
  const faultsAgree = (vm.fault?.code ?? null) === (ref.fault?.code ?? null) && (vm.fault?.span?.start ?? null) === (ref.fault?.span?.start ?? null);
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
    limits: { fuelPerFrame: limits.fuelPerFrame, maxIterationsPerFrame: limits.maxIterationsPerFrame, maxDrawsPerFrame: limits.maxDrawsPerFrame, maxStack: limits.maxStack, maxCallDepth: limits.maxCallDepth },
    bytecodeHash: c.bytecode!.hash,
    traceHash: vm.traceHash,
    sceneHash: vmHash,
    fault: vm.fault ? { code: vm.fault.code, frame: vm.fault.frame, line: vm.fault.span?.line ?? null } : null,
    oracle: { engine: 'reference-interpreter', sceneHash: refHash, agrees: vmHash === refHash && faultsAgree },
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
  const add = (name: string, expected: unknown, actual: unknown) => checks.push({ name, ok: canonicalJson(expected) === canonicalJson(actual), expected: String(expected), actual: String(actual) });
  add('receipt format', RECEIPT_FORMAT, r.format);
  add('receipt digest (no field edited)', r.digest, receiptDigest(r));
  add('compiler version', COMPILER_VERSION, r.versions?.compiler);
  add('bytecode version', BYTECODE_VERSION, r.versions?.bytecode);
  add('source hash', r.sourceHash, sha256(r.source ?? ''));
  add('fixture hash', r.fixtureHash, sha256(canonicalJson(r.fixtures ?? {})));
  const limits: Limits = { ...DEFAULT_LIMITS, ...(r.limits ?? {}) };
  const c = compile(r.source ?? '', { passes: r.optimizations ?? [], fixtures: r.fixtures ?? {}, limits });
  if (!c.ok) { checks.push({ name: 'recompile', ok: false, actual: c.diagnostics.map((d) => d.code).join(',') }); return checks; }
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
  add('VM and reference agree', true, sceneHash(ref.scene) === sceneHash(vm.scene) && (ref.fault?.code ?? null) === (vm.fault?.code ?? null));
  return checks;
}
