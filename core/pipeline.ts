// The compiler phase contract:
//   source → tokens → AST → resolved symbols + typed AST → lowered IR → optimized IR → bytecode → (verified)
// Every stage produces a StageRecord with the compiler version, input/output content hashes, diagnostics and
// measured elapsed time. Execution (VM or reference interpreter) is a separate step on a successful compile.
import type * as A from './ast.ts';
import { type BCModule, type SerializedBC, codegen, serialize, verifyBytecode } from './bytecode.ts';
import { type CheckResult, check } from './checker.ts';
import { type Diagnostic, hasErrors } from './diagnostics.ts';
import { type FixtureTable, loadFixtures } from './fixtures.ts';
import { type IRModule, encodeModule } from './ir.ts';
import { irCallGraphAcyclic, verifyIR } from './irverify.ts';
import type { Token } from './lexer.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { lower } from './lower.ts';
import { type PassName, type PassReport, optimize } from './optimize.ts';
import { parse } from './parser.ts';
import { canonicalJson, sha256 } from './sha256.ts';
import type { Value } from './values.ts';
import { COMPILER_VERSION } from './version.ts';

export type StageName = 'lex+parse' | 'check' | 'fixtures' | 'lower' | 'optimize' | 'codegen' | 'verify';
export interface StageRecord {
  stage: StageName;
  compilerVersion: string;
  inputHash: string;
  outputHash: string | null;
  ok: boolean;
  diagnostics: Diagnostic[];
  ms: number;
  summary: string;
}

export interface CompileOptions { passes?: PassName[]; fixtures?: FixtureTable; limits?: Limits }
export interface CompileResult {
  ok: boolean;
  source: string;
  sourceHash: string;
  passes: PassName[];
  stages: StageRecord[];
  diagnostics: Diagnostic[];
  tokens: Token[];
  program: A.Program | null;
  check: CheckResult | null;
  data: Map<string, Value>;
  ir: IRModule | null;
  irOptimized: IRModule | null;
  passReports: PassReport[];
  bytecode: SerializedBC | null;
  limits: Limits;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function h(v: unknown): string { return sha256(canonicalJson(v)); }

function astForHash(p: A.Program | null): unknown {
  // Spans are part of the AST's identity (source maps), so they stay in the hash.
  return p;
}

export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const passes = opts.passes ?? [];
  const sourceHash = sha256(source);
  const r: CompileResult = {
    ok: false, source, sourceHash, passes, stages: [], diagnostics: [], tokens: [], program: null, check: null, data: new Map(),
    ir: null, irOptimized: null, passReports: [], bytecode: null, limits,
  };
  const stage = (name: StageName, input: string, f: () => { out: unknown; diags: Diagnostic[]; summary: string; ok?: boolean }): boolean => {
    const t0 = now();
    let res: { out: unknown; diags: Diagnostic[]; summary: string; ok?: boolean };
    try {
      res = f();
    } catch (e) {
      // An exception inside the compiler is a compiler bug; record it as a failed stage instead of crashing the host.
      res = { out: null, diags: [{ code: 'ICE', severity: 'error', message: `internal compiler error in ${name}: ${(e as Error).message}`, span: { start: 0, end: 0, line: 1, col: 1 }, stage: 'check' }], summary: 'internal error', ok: false };
    }
    const ok = res.ok ?? !hasErrors(res.diags);
    r.stages.push({ stage: name, compilerVersion: COMPILER_VERSION, inputHash: input, outputHash: res.out === null ? null : h(res.out), ok, diagnostics: res.diags, ms: Math.round((now() - t0) * 1000) / 1000, summary: res.summary });
    r.diagnostics.push(...res.diags);
    return ok;
  };

  if (!stage('lex+parse', sourceHash, () => {
    const p = parse(source, limits);
    r.tokens = p.tokens; r.program = p.program;
    return { out: astForHash(p.program), diags: p.diagnostics, summary: `${p.tokens.length} tokens, ${p.program ? p.program.items.length : 0} top-level items` };
  })) return r;
  const astHash = r.stages[0].outputHash!;

  if (!stage('check', astHash, () => {
    const c = check(r.program!, limits);
    r.check = c;
    return { out: { symbols: c.symbols, types: [...c.types], scene: c.scene }, diags: c.diagnostics, summary: `${c.symbols.length} symbols in ${c.scopes.length} scopes, ${c.types.size} typed expressions` };
  })) return r;
  const checkHash = r.stages[1].outputHash!;

  if (!stage('fixtures', h(opts.fixtures ?? {}), () => {
    const f = loadFixtures(r.check!, opts.fixtures ?? {}, limits);
    r.data = f.values;
    return { out: [...f.values.keys()], diags: f.diagnostics, summary: `${f.values.size} dataset(s) bound` };
  })) return r;

  if (!stage('lower', checkHash, () => {
    const ir = lower(r.program!, r.check!);
    const errs = verifyIR(ir);
    if (!irCallGraphAcyclic(ir)) errs.push('IR call graph has a cycle');
    r.ir = ir;
    return { out: encodeModule(ir), diags: errs.map((e) => ice('lower', e)), summary: `${ir.functions.length} function(s), ${ir.functions.reduce((n, f) => n + f.blocks.length, 0)} blocks` };
  })) return r;
  const irHash = r.stages[r.stages.length - 1].outputHash!;

  if (!stage('optimize', h({ irHash, passes }), () => {
    const o = optimize(r.ir!, passes, limits.maxStringLength);
    r.irOptimized = o.module;
    r.passReports = o.reports;
    return { out: encodeModule(o.module), diags: [], summary: passes.length ? o.reports.map((p) => `${p.pass}: ${p.before}→${p.after}`).join(', ') : 'no passes enabled' };
  })) return r;
  const optHash = r.stages[r.stages.length - 1].outputHash!;

  let bc: BCModule | null = null;
  if (!stage('codegen', optHash, () => {
    bc = codegen(r.irOptimized!);
    return { out: bc, diags: [], summary: `${bc.functions.reduce((n, f) => n + f.code.length / 3, 0)} instructions, ${bc.consts.length} constants` };
  })) return r;

  if (!stage('verify', r.stages[r.stages.length - 1].outputHash!, () => {
    const errs = verifyBytecode(bc!, limits);
    if (!errs.length) r.bytecode = serialize(bc!);
    return { out: r.bytecode ? { hash: r.bytecode.hash } : null, diags: errs.map((e) => ice('verify', e)), summary: errs.length ? `${errs.length} problem(s)` : `bytecode ${r.bytecode!.hash.slice(0, 12)}… verified` };
  })) return r;

  r.ok = true;
  return r;
}

function ice(stage: string, msg: string): Diagnostic {
  return { code: 'ICE', severity: 'error', message: `internal compiler error (${stage}): ${msg}`, span: { start: 0, end: 0, line: 1, col: 1 }, stage: 'check' };
}
