// Optimization passes over the IR. Legality rules (docs/OPTIMIZATION_CORRECTNESS.md):
//   * FOLIO arithmetic faults (R001) on any non-finite result, and evaluation order is left to right.
//   * constfold folds an operation only when every operand is constant AND evaluating it succeeds; an
//     operation that would fault is left in place so the fault still happens, at the same point, with the
//     same span. `-0` is preserved (folding computes with the same JS operations the VM uses).
//   * dce removes unreachable blocks, unused results of operations that can neither fault nor have effects,
//     and stores to slots that are never loaded. It never removes a faulting or effectful instruction.
//   * cse (local value numbering) reuses an earlier identical pure computation in the same block, and
//     propagates register copies (`mov %a`) everywhere (single-assignment registers make that global). Reusing a
//     result of a faulting op is safe: if the first copy faulted, execution never reached the second.
//     Operands of commutative ops (add, mul, eq, ne) are put in a canonical order first.
//   * BAD_cse_commute_all is the deliberately wrong variant for the fault lab: it also treats sub, div, mod
//     and the ordered comparisons as commutative. It exists only behind an explicit flag.
import type { Value } from './values.ts';
import { encodeValue } from './values.ts';
import { canonicalJson } from './sha256.ts';
import {
  type BasicBlock, COMMUTATIVE, type IRFunction, type IRModule, type Instr, type Op, type Operand, PURE_OPS,
  canFault, cloneModule, successors,
} from './ir.ts';
import { dominators, reachable, verifyIR } from './irverify.ts';
import { evalPure } from './ops.ts';
import { FaultSignal } from './values.ts';

export type PassName = 'constfold' | 'cse' | 'dce' | 'BAD_cse_commute_all';
export const SAFE_PASSES: PassName[] = ['constfold', 'dce', 'cse'];

export interface Change { pass: PassName; fn: string; kind: 'folded' | 'propagated' | 'removed' | 'reused' | 'branch-folded' | 'block-removed' | 'block-merged' | 'store-removed' | 'assert-removed'; instr: number | null; detail: string }
export interface PassReport { pass: PassName; before: number; after: number; changes: Change[]; verified: string[] }
export interface OptimizeResult { module: IRModule; reports: PassReport[] }

const FOLDABLE = new Set<Op>([...PURE_OPS].filter((o) => o !== 'global'));

export function instrCount(m: IRModule): number {
  return m.functions.reduce((n, f) => n + f.blocks.reduce((k, b) => k + b.instrs.length + 1, 0), 0);
}

export function optimize(input: IRModule, passes: PassName[], maxStr: number): OptimizeResult {
  let m = cloneModule(input);
  const reports: PassReport[] = [];
  for (const p of passes) {
    const before = instrCount(m);
    const changes: Change[] = [];
    m = cloneModule(m);
    for (const f of m.functions) {
      if (p === 'constfold') constFold(f, changes, maxStr);
      else if (p === 'dce') dce(f, changes);
      else if (p === 'cse') cse(f, changes, false);
      else if (p === 'BAD_cse_commute_all') cse(f, changes, true);
    }
    const verified = verifyIR(m);
    reports.push({ pass: p, before, after: instrCount(m), changes, verified });
    if (verified.length) throw new Error(`IR verification failed after ${p}: ${verified.slice(0, 3).join('; ')}`);
  }
  return { module: m, reports };
}

/** Blocks in reverse post-order from the entry (definitions are visited before the uses they dominate). */
export function rpo(f: IRFunction): BasicBlock[] {
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const seen = new Set<number>();
  const out: BasicBlock[] = [];
  const visit = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const b = byId.get(id)!;
    for (const s of successors(b.term)) visit(s);
    out.push(b);
  };
  visit(f.blocks[0].id);
  return out.reverse();
}

function substitute(f: IRFunction, from: number, to: Operand) {
  const sub = (o: Operand) => (o.k === 'r' && o.id === from ? to : o);
  for (const b of f.blocks) {
    for (const i of b.instrs) i.args = i.args.map(sub);
    if (b.term.op === 'br') b.term.cond = sub(b.term.cond);
    if (b.term.op === 'ret') b.term.value = sub(b.term.value);
  }
}

// --- constant folding + propagation -----------------------------------------------------------
function constFold(f: IRFunction, changes: Change[], maxStr: number) {
  const known = new Map<number, Value>();
  const prop = (o: Operand): Operand => (o.k === 'r' && known.has(o.id) ? { k: 'c', v: known.get(o.id)! } : o);
  for (const b of rpo(f)) {
    const kept: Instr[] = [];
    for (const i of b.instrs) {
      const newArgs = i.args.map(prop);
      if (newArgs.some((a, k) => a !== i.args[k])) changes.push({ pass: 'constfold', fn: f.name, kind: 'propagated', instr: i.id, detail: `constant operand substituted into #${i.id} ${i.op}` });
      i.args = newArgs;
      const allConst = i.args.every((a) => a.k === 'c');
      if (i.dst !== null && FOLDABLE.has(i.op) && allConst) {
        try {
          const v = evalPure(i.op, i.args.map((a) => (a as { v: Value }).v), i.meta, maxStr);
          known.set(i.dst, v);
          changes.push({ pass: 'constfold', fn: f.name, kind: 'folded', instr: i.id, detail: `#${i.id} ${i.op} → ${canonicalJson(encodeValue(v)).slice(0, 40)}` });
          continue;
        } catch (e) {
          if (!(e instanceof FaultSignal)) throw e;
          // Would fault at run time: keep it so the fault still happens there.
        }
      }
      if (i.op === 'assert' && i.args[0].k === 'c' && i.args[0].v === true) {
        changes.push({ pass: 'constfold', fn: f.name, kind: 'assert-removed', instr: i.id, detail: `#${i.id} assert true removed` });
        continue;
      }
      if (i.op === 'rangechk' && allConst && i.args.every((a) => Number.isInteger((a as { v: Value }).v))) {
        changes.push({ pass: 'constfold', fn: f.name, kind: 'folded', instr: i.id, detail: `#${i.id} range bounds are constant whole numbers` });
        continue;
      }
      kept.push(i);
    }
    b.instrs = kept;
    if (b.term.op === 'br') {
      b.term.cond = prop(b.term.cond);
      if (b.term.cond.k === 'c') {
        const target = b.term.cond.v ? b.term.t : b.term.f;
        changes.push({ pass: 'constfold', fn: f.name, kind: 'branch-folded', instr: null, detail: `${b.label}: branch on ${String(b.term.cond.v)} → jmp` });
        b.term = { op: 'jmp', target, span: b.term.span };
      }
    } else if (b.term.op === 'ret') b.term.value = prop(b.term.value);
  }
}

// --- dead code elimination ---------------------------------------------------------------------
function dce(f: IRFunction, changes: Change[]) {
  // 1. unreachable blocks
  const reach = reachable(f);
  for (const b of f.blocks.filter((x) => !reach.has(x.id))) changes.push({ pass: 'dce', fn: f.name, kind: 'block-removed', instr: null, detail: `${b.label} is unreachable (${b.instrs.length} instructions)` });
  f.blocks = f.blocks.filter((b) => reach.has(b.id));
  // 2. dead stores: slots never loaded (parameters and inputs are written by the caller, not stores)
  const loaded = new Set<number>();
  for (const b of f.blocks) for (const i of b.instrs) if (i.op === 'load') loaded.add(i.meta.slot!);
  for (const b of f.blocks) b.instrs = b.instrs.filter((i) => {
    if (i.op === 'store' && !loaded.has(i.meta.slot!)) {
      changes.push({ pass: 'dce', fn: f.name, kind: 'store-removed', instr: i.id, detail: `#${i.id} store to ${f.slots[i.meta.slot!]?.name} is never read` });
      return false;
    }
    return true;
  });
  // 3. unused, removable results, to a fixpoint
  for (;;) {
    const used = new Set<number>();
    for (const b of f.blocks) {
      for (const i of b.instrs) for (const a of i.args) if (a.k === 'r') used.add(a.id);
      const t = b.term;
      if (t.op === 'br' && t.cond.k === 'r') used.add(t.cond.id);
      if (t.op === 'ret' && t.value.k === 'r') used.add(t.value.id);
    }
    let removed = 0;
    for (const b of f.blocks) b.instrs = b.instrs.filter((i) => {
      if (i.dst !== null && !used.has(i.dst) && PURE_OPS.has(i.op) && !canFault(i)) {
        changes.push({ pass: 'dce', fn: f.name, kind: 'removed', instr: i.id, detail: `#${i.id} ${i.op} result %${i.dst} is never used` });
        removed++;
        return false;
      }
      return true;
    });
    if (!removed) break;
  }
  // 4. merge a block into its only predecessor when that predecessor jumps straight to it
  for (;;) {
    const preds = new Map<number, number[]>(f.blocks.map((b) => [b.id, []]));
    for (const b of f.blocks) for (const s of successors(b.term)) preds.get(s)!.push(b.id);
    const a = f.blocks.find((b) => b.term.op === 'jmp' && b.term.target !== f.blocks[0].id && b.term.target !== b.id && preds.get(b.term.target)!.length === 1);
    if (!a) break;
    const target = (a.term as { target: number }).target;
    const b = f.blocks.find((x) => x.id === target)!;
    a.instrs.push(...b.instrs);
    a.term = b.term;
    f.blocks = f.blocks.filter((x) => x.id !== b.id);
    changes.push({ pass: 'dce', fn: f.name, kind: 'block-merged', instr: null, detail: `${b.label} merged into ${a.label}` });
  }
}

// --- common subexpression elimination (local value numbering) ---------------------------------
const ALWAYS_COMMUTE_BAD = new Set<Op>(['sub', 'div', 'mod', 'lt', 'le', 'gt', 'ge']);

function cse(f: IRFunction, changes: Change[], bad: boolean) {
  const pass: PassName = bad ? 'BAD_cse_commute_all' : 'cse';
  const okKind = (o: Op) => FOLDABLE.has(o) && o !== 'mov' && o !== 'list' && o !== 'global';
  const key = (o: Operand) => (o.k === 'r' ? `%${o.id}` : `c:${canonicalJson(encodeValue(o.v))}`);
  // Dominance is only needed to justify the global substitution; computing it documents the invariant.
  void dominators;
  for (const b of f.blocks) {
    const table = new Map<string, number>();
    const loads = new Map<number, number>();
    const kept: Instr[] = [];
    for (const i of b.instrs) {
      if (i.op === 'store') { loads.delete(i.meta.slot!); kept.push(i); continue; }
      if (i.op === 'load') {
        const prev = loads.get(i.meta.slot!);
        if (prev !== undefined) {
          substitute(f, i.dst!, { k: 'r', id: prev });
          changes.push({ pass, fn: f.name, kind: 'reused', instr: i.id, detail: `#${i.id} load ${f.slots[i.meta.slot!]?.name} reuses %${prev}` });
          continue;
        }
        loads.set(i.meta.slot!, i.dst!);
        kept.push(i);
        continue;
      }
      // Copy propagation: registers are single-assignment and `mov` cannot fault, so every use of a copy can
      // read the original register instead.
      if (i.op === 'mov' && i.args[0].k === 'r' && i.dst !== null) {
        substitute(f, i.dst, i.args[0]);
        changes.push({ pass, fn: f.name, kind: 'reused', instr: i.id, detail: `#${i.id} copy %${i.dst} → %${i.args[0].id}${i.meta.binding ? ` (let ${i.meta.binding})` : ''}` });
        continue;
      }
      if (i.dst === null || !okKind(i.op)) { kept.push(i); continue; }
      let ks = i.args.map(key);
      if (COMMUTATIVE.has(i.op) || (bad && ALWAYS_COMMUTE_BAD.has(i.op))) ks = [...ks].sort();
      const k = `${i.op}|${i.meta.name ?? ''}|${i.meta.field ?? ''}|${ks.join(',')}`;
      const prev = table.get(k);
      if (prev !== undefined) {
        substitute(f, i.dst, { k: 'r', id: prev });
        changes.push({ pass, fn: f.name, kind: 'reused', instr: i.id, detail: `#${i.id} ${i.op} reuses %${prev}` });
        continue;
      }
      table.set(k, i.dst);
      kept.push(i);
    }
    b.instrs = kept;
  }
}
