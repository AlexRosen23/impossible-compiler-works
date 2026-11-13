// THE IMPOSSIBLE COMPILER WORKS bridge: the Witness wing model-checks the Compiler wing's optimizer.
//
// Question: if the optimizer's passes run in ANY order, ANY number of times (not just the fixed pipeline order),
// can the optimized program ever draw something different from the independent reference interpreter?
//
// How (honest scope, see docs/CROSS_FEATURE_PASS_ORDERS.md):
//   1. Compile a FOLIO seed program to IR with no passes (real lexer, parser, checker, lowering).
//   2. Breadth-first, apply each pass of an alphabet to each IR module (the real `optimize()`, with the IR verifier
//      after every pass). Every distinct IR module is one abstract state. The graph is finite because passes only
//      shrink or rewrite the IR; a cap stops runaway growth and turns the result into INCOMPLETE, never "safe".
//   3. Label every state: generate bytecode (real codegen + bytecode verifier), run the real VM, and compare its scene
//      hash with the reference interpreter's scene hash for the original program (same fixtures, same limits).
//   4. Emit that finite transition system as a WML model (one process, one action per pass) and let the Witness
//      engine search it: invariant OptimizedMatchesReference. A violation comes back as the SHORTEST pass sequence.
//
// The checker does not re-derive FOLIO semantics: edges and labels come from running the real compiler. What the
// Witness engine adds is the exhaustive, order-independent search over the pass-order graph, a shortest
// counterexample, a replayable trace and a tamper-evident receipt. Verdicts cover one seed, its fixtures and limits.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPILER_VERSION, DEFAULT_LIMITS, codegen, compile, encodeModule, interpret, optimize, runVM, sceneHash, serialize,
  sha256, canonicalJson as ptCanonicalJson, verifyBytecode,
  type FixtureTable, type IRModule, type PassName,
} from '../wings/compiler/core/index.ts';
import { loadFixtureLibrary } from '../wings/compiler/server/app.ts';
import { compileSource } from '../src/core/model/compile.ts';
import { check, type CheckResult } from '../src/core/engine/check.ts';
import { buildReceipt, type Receipt } from '../src/core/receipt/receipt.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const COMPILER_ROOT = path.join(REPO, 'wings', 'compiler');
export const BRIDGE_VERSION = '0.1.0';
/** Distinct IR modules explored per seed before the abstraction is declared INCOMPLETE. */
export const MAX_PROGRAMS = 48;

export const SAFE_ALPHABET: PassName[] = ['constfold', 'cse', 'dce'];
/** Negative control: the deliberately wrong pass shipped with the Compiler wing's fault lab. */
export const MUTANT_ALPHABET: PassName[] = ['constfold', 'cse', 'dce', 'BAD_cse_commute_all'];

export interface ProgramState { id: number; irHash: string; label: 'agree' | 'diverge' | 'vm-fault' | 'invalid'; vmSceneHash: string | null; bytecodeHash: string | null; via: string }
export interface Abstraction {
  seed: string; sourceHash: string; alphabet: PassName[]; compilerVersion: string; referenceSceneHash: string;
  complete: boolean; states: ProgramState[]; edges: Record<string, number[]>; // pass -> successor id for each state id
}

const slugOf = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();

export function readSeed(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`bad seed name ${JSON.stringify(name)}`);
  return readFileSync(path.join(COMPILER_ROOT, 'examples', `${name}.folio`), 'utf8');
}

/** Steps 1–3: the finite abstraction, built only from real compiler runs. */
export function abstractPassOrders(seed: string, source: string, alphabet: PassName[], fixtures: FixtureTable = loadFixtureLibrary(COMPILER_ROOT)): Abstraction {
  const limits = DEFAULT_LIMITS;
  const c = compile(source, { passes: [], fixtures, limits });
  if (!c.ok || !c.ir || !c.program || !c.check) throw new Error(`seed ${seed} does not compile: ${c.diagnostics.map((d) => d.message).join('; ')}`);
  const ref = interpret(c.program, c.check, c.data, limits);
  if (ref.fault) throw new Error(`seed ${seed}: the reference interpreter faults (${ref.fault.code}); pick a seed that runs cleanly`);
  const referenceSceneHash = sceneHash(ref.scene);

  const states: ProgramState[] = [];
  const modules: (IRModule | null)[] = [];
  const index = new Map<string, number>();
  const edges: Record<string, number[]> = Object.fromEntries(alphabet.map((p) => [p, [] as number[]]));
  let complete = true;

  const label = (m: IRModule): Pick<ProgramState, 'label' | 'vmSceneHash' | 'bytecodeHash'> => {
    const bc = codegen(m);
    if (verifyBytecode(bc, limits).length) return { label: 'invalid', vmSceneHash: null, bytecodeHash: null };
    const ser = serialize(bc);
    const vm = runVM(ser, c.data, limits);
    if (vm.fault) return { label: 'vm-fault', vmSceneHash: null, bytecodeHash: ser.hash };
    const h = sceneHash(vm.scene);
    return { label: h === referenceSceneHash ? 'agree' : 'diverge', vmSceneHash: h, bytecodeHash: ser.hash };
  };
  const intern = (m: IRModule | null, via: string): number => {
    const key = m ? sha256(ptCanonicalJson(encodeModule(m))) : 'invalid-ir';
    const seen = index.get(key);
    if (seen !== undefined) return seen;
    if (states.length >= MAX_PROGRAMS) { complete = false; return -1; }
    const id = states.length;
    index.set(key, id);
    modules.push(m);
    states.push({ id, irHash: key, via, ...(m ? label(m) : { label: 'invalid', vmSceneHash: null, bytecodeHash: null }) });
    return id;
  };

  intern(c.ir, 'unoptimized');
  for (let i = 0; i < states.length; i++) {
    const m = modules[i];
    for (const p of alphabet) {
      let next: IRModule | null = null;
      if (m) { try { next = optimize(m, [p], limits.maxStringLength).module; } catch { next = null; } } // IR verifier rejected
      const j = m ? intern(next, `${states[i].via} → ${p}`) : i; // the invalid sink stays put
      edges[p][i] = j < 0 ? i : j; // over the cap: no new state (the result is marked INCOMPLETE)
    }
  }
  return { seed, sourceHash: c.sourceHash, alphabet, compilerVersion: COMPILER_VERSION, referenceSceneHash, complete, states, edges };
}

/** Step 4: the abstraction as a WML model. Deterministic: same abstraction, same bytes. */
export function toWml(a: Abstraction): string {
  const n = a.states.length;
  const table = (f: (i: number) => string) => {
    if (n === 1) return f(0);
    let e = f(n - 1);
    for (let i = n - 2; i >= 0; i--) e = `if prog = ${i} then ${f(i)} else (${e})`;
    return e;
  };
  const ok = (i: number) => (a.states[i].label === 'agree' ? 'true' : 'false');
  const lines = [
    `model pass_orders_${slugOf(a.seed)}_${a.alphabet.length === SAFE_ALPHABET.length ? 'safe' : 'mutant'} "Optimizer pass orders: ${a.seed} (${a.alphabet.join(', ')})"`,
    `description "Generated by bridge/pass-orders.ts ${BRIDGE_VERSION} from FOLIO seed ${a.seed} (source sha256 ${a.sourceHash.slice(0, 16)}, compiler ${a.compilerVersion}). Each value of prog is one distinct IR module reachable by applying the passes in any order, any number of times; agree records whether the real VM's scene hash for that module equals the reference interpreter's (${a.referenceSceneHash.slice(0, 16)}). ${a.complete ? 'All reachable modules are included.' : `CAPPED at ${MAX_PROGRAMS} modules: the abstraction is INCOMPLETE.`}"`,
    '',
    `var prog : 0..${Math.max(n - 1, 0)} = 0`,
    'var agree : bool = true',
    '',
    'process Optimizer {',
  ];
  for (const p of a.alphabet) {
    const succ = a.edges[p];
    lines.push(`  action ${p} {`, `    prog := ${table((i) => String(succ[i]))}`, `    agree := ${table((i) => ok(succ[i]))}`, '  }');
  }
  lines.push('}', '', 'invariant OptimizedMatchesReference: agree', '');
  return lines.join('\n');
}

export interface PassOrderRun { abstraction: Abstraction; wml: string; result: CheckResult; receipt: Receipt; verdict: 'NO_DIVERGENCE_IN_ANY_PASS_ORDER' | 'DIVERGENCE_FOUND' | 'INCOMPLETE'; shortestPassSequence: string[] | null }

/** The whole cross-feature: abstraction → WML → Witness check → receipt. `createdAt` pins the receipt for evidence. */
export function checkPassOrders(seed: string, alphabet: PassName[], opts: { createdAt?: string } = {}): PassOrderRun {
  const abstraction = abstractPassOrders(seed, readSeed(seed), alphabet);
  const wml = toWml(abstraction);
  const compiled = compileSource(wml);
  if (!compiled.ok) throw new Error(`generated WML does not compile: ${compiled.diagnostics.map((d) => d.message).join('; ')}`);
  const { result } = check(compiled.model!, { includeGraph: false });
  const inv = result.properties.find((p) => p.name === 'OptimizedMatchesReference');
  const receipt = buildReceipt(wml, result, {
    annotation: `bridge pass-orders ${BRIDGE_VERSION}: FOLIO seed ${seed}, alphabet ${alphabet.join(',')}, compiler ${abstraction.compilerVersion}`,
    createdAt: opts.createdAt,
  });
  // Trace action labels are `Optimizer.<pass>`; the pass name is what a compiler engineer needs.
  const shortestPassSequence = inv?.status === 'VIOLATED' && inv.trace ? inv.trace.steps.slice(1).map((s) => String(s.action ?? '?').replace(/^Optimizer\./, '')) : null;
  const verdict = !abstraction.complete || !result.complete ? 'INCOMPLETE' : inv?.status === 'VIOLATED' ? 'DIVERGENCE_FOUND' : inv?.status === 'VERIFIED_BOUNDED' ? 'NO_DIVERGENCE_IN_ANY_PASS_ORDER' : 'INCOMPLETE';
  return { abstraction, wml, result, receipt, verdict, shortestPassSequence };
}

// CLI: node bridge/pass-orders.ts [seed ...] [--mutant] [--write <dir>]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mutant = args.includes('--mutant');
  const wi = args.indexOf('--write');
  const outDir = wi >= 0 ? args[wi + 1] : null;
  const seeds = args.filter((a, i) => !a.startsWith('--') && (wi < 0 || i !== wi + 1));
  const { mkdirSync, writeFileSync } = await import('node:fs');
  let bad = 0;
  for (const seed of seeds.length ? seeds : ['13-optimizer-bench', 'fault-lab-commute']) {
    const r = checkPassOrders(seed, mutant ? MUTANT_ALPHABET : SAFE_ALPHABET, { createdAt: outDir ? '2026-11-13T00:00:00.000Z' : undefined });
    const counts = r.abstraction.states.reduce<Record<string, number>>((m, s) => ({ ...m, [s.label]: (m[s.label] ?? 0) + 1 }), {});
    console.log(`${r.verdict.padEnd(32)} ${seed} [${r.abstraction.alphabet.join(',')}] ${r.abstraction.states.length} IR modules ${JSON.stringify(counts)} · witness states ${r.result.stats.states}${r.shortestPassSequence ? ` · shortest: ${r.shortestPassSequence.join(' → ')}` : ''}`);
    if (r.verdict === 'INCOMPLETE') bad = 1;
    if (outDir) {
      const base = `${seed}.${mutant ? 'mutant' : 'safe'}`;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, `${base}.witness`), r.wml);
      writeFileSync(path.join(outDir, `${base}.receipt.json`), JSON.stringify(r.receipt, null, 2) + '\n');
      writeFileSync(path.join(outDir, `${base}.abstraction.json`), JSON.stringify(r.abstraction, null, 2) + '\n');
    }
  }
  process.exit(bad);
}
