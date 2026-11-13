// IR verifier: structural and SSA-register invariants. Runs after lowering and after every optimization pass;
// a pass that breaks an invariant is a compiler bug and fails compilation loudly.
import { BUILTINS } from './builtins.ts';
import { type BasicBlock, type IRFunction, type IRModule, type Op, successors } from './ir.ts';
import { GROUP_SIG, PRIMITIVES } from './primitives.ts';

const ARITY: Partial<Record<Op, number>> = {
  mov: 1, add: 2, sub: 2, mul: 2, div: 2, mod: 2, neg: 1, concat: 2, lt: 2, le: 2, gt: 2, ge: 2, eq: 2, ne: 2, not: 1,
  index: 2, field: 1, len: 1, global: 0, load: 0, store: 1, gpush: GROUP_SIG.params.length, gpop: 0, assert: 1, tick: 0, rangechk: 2,
};
const NO_DST = new Set<Op>(['store', 'draw', 'gpush', 'gpop', 'assert', 'tick', 'rangechk']);

export function reachable(f: IRFunction): Set<number> {
  const seen = new Set<number>();
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const stack = [f.blocks[0]?.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === undefined || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const s of successors(byId.get(id)!.term)) stack.push(s);
  }
  return seen;
}

/** Iterative dominator sets over reachable blocks (small functions; clarity over speed). */
export function dominators(f: IRFunction): Map<number, Set<number>> {
  const reach = reachable(f);
  const blocks = f.blocks.filter((b) => reach.has(b.id));
  const preds = new Map<number, number[]>(blocks.map((b) => [b.id, []]));
  for (const b of blocks) for (const s of successors(b.term)) preds.get(s)?.push(b.id);
  const all = new Set(blocks.map((b) => b.id));
  const dom = new Map<number, Set<number>>(blocks.map((b, i) => [b.id, i === 0 ? new Set([b.id]) : new Set(all)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of blocks.slice(1)) {
      const ps = preds.get(b.id)!;
      let inter: number[] | null = null;
      for (const p of ps) {
        const d = dom.get(p)!;
        inter = inter === null ? [...d] : inter.filter((x: number) => d.has(x));
      }
      const next = new Set<number>(inter ?? []);
      next.add(b.id);
      if (next.size !== dom.get(b.id)!.size) { dom.set(b.id, next); changed = true; }
    }
  }
  return dom;
}

export function verifyIR(m: IRModule): string[] {
  const errs: string[] = [];
  if (m.main < 0 || m.main >= m.functions.length) errs.push('main function index out of range');
  const names = new Map(m.functions.map((f, i) => [f.name, i]));
  for (const f of m.functions) errs.push(...verifyFn(f, m, names).map((e) => `${f.name}: ${e}`));
  return errs;
}

function verifyFn(f: IRFunction, m: IRModule, names: Map<string, number>): string[] {
  const errs: string[] = [];
  if (f.blocks.length === 0) return ['no blocks'];
  const ids = new Set(f.blocks.map((b) => b.id));
  if (ids.size !== f.blocks.length) errs.push('duplicate block ids');
  const defBlock = new Map<number, number>();
  const defIndex = new Map<number, number>();
  for (const b of f.blocks) {
    for (const s of successors(b.term)) if (!ids.has(s)) errs.push(`${b.label}: jump to missing block ${s}`);
    b.instrs.forEach((i, k) => {
      if (i.dst !== null) {
        if (i.dst < 0 || i.dst >= f.nregs) errs.push(`#${i.id}: register %${i.dst} out of range`);
        if (defBlock.has(i.dst)) errs.push(`#${i.id}: register %${i.dst} defined twice`);
        defBlock.set(i.dst, b.id); defIndex.set(i.dst, k);
      }
      if (NO_DST.has(i.op) && i.dst !== null) errs.push(`#${i.id}: ${i.op} must not define a register`);
      if (!NO_DST.has(i.op) && i.dst === null) errs.push(`#${i.id}: ${i.op} must define a register`);
      const want = ARITY[i.op];
      if (want !== undefined && i.args.length !== want) errs.push(`#${i.id}: ${i.op} takes ${want} operands, has ${i.args.length}`);
      if ((i.op === 'load' || i.op === 'store') && !(i.meta.slot! >= 0 && i.meta.slot! < f.slots.length)) errs.push(`#${i.id}: slot out of range`);
      if (i.op === 'callb' && (!(i.meta.name! in BUILTINS) || BUILTINS[i.meta.name!].params.length !== i.args.length)) errs.push(`#${i.id}: bad builtin call ${i.meta.name}`);
      if (i.op === 'callf') {
        const t = names.get(i.meta.name!);
        if (t === undefined || t === m.main) errs.push(`#${i.id}: call to unknown function ${i.meta.name}`);
        else if (m.functions[t].nparams !== i.args.length) errs.push(`#${i.id}: ${i.meta.name} takes ${m.functions[t].nparams} arguments`);
      }
      if (i.op === 'draw' && (!(i.meta.kind! in PRIMITIVES) || PRIMITIVES[i.meta.kind!].params.length !== i.args.length)) errs.push(`#${i.id}: bad draw ${i.meta.kind}`);
      if (i.op === 'global' && !(i.meta.global! >= 0 && i.meta.global! < m.data.length)) errs.push(`#${i.id}: bad global`);
    });
    if (b.term.op === 'ret' && f.ret === null) errs.push(`${b.label}: ret in the scene function`);
  }
  // Dominance: every use of a register is dominated by its definition (reachable code only).
  const dom = dominators(f);
  const reach = reachable(f);
  const checkUse = (r: number, b: BasicBlock, k: number, where: string) => {
    const db = defBlock.get(r);
    if (db === undefined) { errs.push(`${where}: use of undefined register %${r}`); return; }
    if (db === b.id) { if (defIndex.get(r)! >= k) errs.push(`${where}: %${r} used before its definition`); return; }
    if (!dom.get(b.id)?.has(db)) errs.push(`${where}: definition of %${r} does not dominate this use`);
  };
  for (const b of f.blocks) {
    if (!reach.has(b.id)) continue;
    b.instrs.forEach((i, k) => { for (const a of i.args) if (a.k === 'r') checkUse(a.id, b, k, `#${i.id}`); });
    const t = b.term;
    const o = t.op === 'br' ? t.cond : t.op === 'ret' ? t.value : null;
    if (o?.k === 'r') checkUse(o.id, b, b.instrs.length, `${b.label} terminator`);
  }
  return errs;
}

/** Call graph over IR functions; used to re-check that no recursion slipped through. */
export function irCallGraphAcyclic(m: IRModule): boolean {
  const edges = new Map<string, Set<string>>();
  for (const f of m.functions) {
    const s = new Set<string>();
    for (const b of f.blocks) for (const i of b.instrs) if (i.op === 'callf') s.add(i.meta.name!);
    edges.set(f.name, s);
  }
  const state = new Map<string, number>();
  const dfs = (n: string): boolean => {
    state.set(n, 1);
    for (const x of edges.get(n) ?? []) {
      if (state.get(x) === 1) return false;
      if (!state.get(x) && !dfs(x)) return false;
    }
    state.set(n, 2);
    return true;
  };
  return [...edges.keys()].every((n) => state.get(n) === 2 || dfs(n));
}
