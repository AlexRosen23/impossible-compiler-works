// Fairness-aware liveness checking on a COMPLETE explicit state graph.
// Semantics follow TLA+: behaviours may stutter; WF/SF constrain <<A>>_vars steps (steps
// that change the state). See docs/LIVENESS_AND_FAIRNESS.md.
//
// A counterexample to `eventually Q` is a fair behaviour from an initial state that stays in
// not-Q forever. A counterexample to `P leadsto Q` is a reachable P /\ not-Q state followed by a
// fair behaviour staying in not-Q forever. On a finite graph such a behaviour is a lasso whose
// loop lies in one strongly connected component (SCC) of the not-Q subgraph, or a single state
// where the behaviour stutters forever. Fair SCCs are found with the Emerson–Lei refinement for
// strong fairness.
import type { CompiledModel, FairnessInfo } from '../model/ir.ts';
import { compileExpr, EvalError } from './evaluate.ts';
import type { Exploration } from './explore.ts';

export interface Lasso {
  stem: number[]; // state ids, stem[0] initial; last element = loop[0]
  stemActions: number[]; // action ids, length stem.length - 1
  loop: number[]; // state ids of the loop; loop[0] repeated after the last step
  loopActions: number[]; // action ids, same length as loop; -1 = stutter
  stutter: boolean; // loop is a single state that stutters forever
  /** For every fairness constraint, why the loop respects it. */
  fairnessWitness: { label: string; how: 'taken' | 'disabled-somewhere' | 'disabled-everywhere' }[];
}

export interface LivenessResult {
  name: string;
  status: 'VERIFIED_BOUNDED' | 'VIOLATED' | 'INCOMPLETE' | 'ERROR';
  lasso?: Lasso;
  note: string;
  sccCount?: number;
  candidateStates?: number;
}

interface Ctx {
  ex: Exploration;
  fair: FairnessInfo[];
  /** enabled[f][s] = some <<A>>_vars step of constraint f leaves s */
  enabled: Uint8Array[];
  actionInFair: Uint8Array[]; // [f][actionIndex]
}

function buildCtx(ex: Exploration): Ctx {
  const fair = ex.model.fairness;
  const n = ex.states.length;
  const actionInFair = fair.map((f) => {
    const a = new Uint8Array(ex.model.actions.length);
    for (const i of f.actions) a[i] = 1;
    return a;
  });
  const enabled = fair.map(() => new Uint8Array(n));
  for (let s = 0; s < n; s++) {
    for (let e = ex.outStart[s]; e < ex.outEnd[s]; e++) {
      if (ex.edgeTo[e] === s) continue; // a self-loop is not a <<A>>_vars step
      const a = ex.edgeAction[e];
      for (let f = 0; f < fair.length; f++) if (actionInFair[f][a]) enabled[f][s] = 1;
    }
  }
  return { ex, fair, enabled, actionInFair };
}

/** Iterative Tarjan over the subgraph induced by `inSet`. Returns component id per state (-1 if not in set). */
function sccs(ex: Exploration, inSet: Uint8Array): { comp: Int32Array; count: number } {
  const n = ex.states.length;
  const comp = new Int32Array(n).fill(-1);
  const idx = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  let counter = 0;
  let count = 0;
  const work: { v: number; e: number }[] = [];
  for (let root = 0; root < n; root++) {
    if (!inSet[root] || idx[root] !== -1) continue;
    work.push({ v: root, e: ex.outStart[root] });
    idx[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const v = top.v;
      if (top.e >= 0 && top.e < ex.outEnd[v]) {
        const w = ex.edgeTo[top.e++];
        if (!inSet[w]) continue;
        if (idx[w] === -1) {
          idx[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push({ v: w, e: ex.outStart[w] });
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], idx[w]);
        }
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1].v;
          low[p] = Math.min(low[p], low[v]);
        }
        if (low[v] === idx[v]) {
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp[w] = count;
          } while (w !== v);
          count++;
        }
      }
    }
  }
  return { comp, count };
}

/** Find a fair "recurrence set" inside `inSet`: either a fair stutter state or a fair SCC. */
function findFairComponent(ctx: Ctx, inSet: Uint8Array): { states: number[]; stutter: boolean } | null {
  const { ex, fair, enabled } = ctx;
  const n = ex.states.length;
  // 1. stuttering forever at a single state is fair iff no fairness constraint is enabled there
  for (let s = 0; s < n; s++) {
    if (!inSet[s]) continue;
    if (fair.every((_, f) => !enabled[f][s])) return { states: [s], stutter: true };
  }
  // 2. non-trivial SCCs with Emerson–Lei refinement for strong fairness
  const stack: Uint8Array[] = [inSet];
  let guard = 0;
  while (stack.length) {
    if (++guard > 100_000) throw new Error('liveness refinement did not converge');
    const set = stack.pop()!;
    const { comp, count } = sccs(ex, set);
    const members: number[][] = Array.from({ length: count }, () => []);
    for (let s = 0; s < n; s++) if (comp[s] >= 0) members[comp[s]].push(s);
    for (let c = 0; c < count; c++) {
      const C = members[c];
      if (C.length < 2) continue; // single states were handled by the stutter rule
      const inC = new Uint8Array(n);
      for (const s of C) inC[s] = 1;
      const taken = fair.map(() => false);
      for (const s of C) {
        for (let e = ex.outStart[s]; e < ex.outEnd[s]; e++) {
          const t = ex.edgeTo[e];
          if (t === s || !inC[t]) continue;
          for (let f = 0; f < fair.length; f++) if (ctx.actionInFair[f][ex.edgeAction[e]]) taken[f] = true;
        }
      }
      let wfFails = false;
      const sfFails: number[] = [];
      for (let f = 0; f < fair.length; f++) {
        if (taken[f]) continue;
        const enabledSomewhere = C.some((s) => enabled[f][s]);
        const enabledEverywhere = C.every((s) => enabled[f][s]);
        if (fair[f].strength === 'weak' && enabledEverywhere) wfFails = true;
        if (fair[f].strength === 'strong' && enabledSomewhere) sfFails.push(f);
      }
      if (wfFails) continue; // every sub-cycle also violates that WF constraint
      if (sfFails.length === 0) return { states: C, stutter: false };
      const sub = new Uint8Array(n);
      for (const s of C) if (!sfFails.some((f) => enabled[f][s])) sub[s] = 1;
      stack.push(sub);
    }
  }
  return null;
}

/** BFS inside `allowed` from `from` (single source) to any state satisfying `isGoal`. */
function bfsPath(ex: Exploration, from: number, allowed: Uint8Array, isGoal: (s: number) => boolean,
  edgeGoal?: (e: number) => boolean): { states: number[]; actions: number[] } | null {
  const n = ex.states.length;
  const prev = new Int32Array(n).fill(-2);
  const prevEdge = new Int32Array(n).fill(-1);
  prev[from] = -1;
  const q = [from];
  let goalEdge = -1;
  let goalState = -1;
  if (!edgeGoal && isGoal(from)) return { states: [from], actions: [] };
  for (let h = 0; h < q.length && goalState < 0; h++) {
    const v = q[h];
    for (let e = ex.outStart[v]; e < ex.outEnd[v]; e++) {
      const w = ex.edgeTo[e];
      if (!allowed[w]) continue;
      if (edgeGoal && edgeGoal(e)) { goalEdge = e; goalState = v; break; }
      if (prev[w] !== -2) continue;
      prev[w] = v;
      prevEdge[w] = e;
      if (!edgeGoal && isGoal(w)) { goalState = w; break; }
      q.push(w);
    }
  }
  if (goalState < 0) return null;
  const states: number[] = [];
  const actions: number[] = [];
  let cur = goalState;
  while (cur !== -1) {
    states.push(cur);
    if (prevEdge[cur] >= 0 && prev[cur] !== -1) actions.push(ex.edgeAction[prevEdge[cur]]);
    else if (prevEdge[cur] >= 0) actions.push(ex.edgeAction[prevEdge[cur]]);
    cur = prev[cur];
  }
  states.reverse();
  actions.reverse();
  if (edgeGoal) {
    states.push(ex.edgeTo[goalEdge]);
    actions.push(ex.edgeAction[goalEdge]);
  }
  return { states, actions: actions.slice(0, states.length - 1) };
}

function buildLoop(ctx: Ctx, comp: { states: number[]; stutter: boolean }): Pick<Lasso, 'loop' | 'loopActions' | 'stutter' | 'fairnessWitness'> {
  const { ex, fair, enabled } = ctx;
  const s0 = comp.states[0];
  if (comp.stutter) {
    return {
      loop: [s0], loopActions: [-1], stutter: true,
      fairnessWitness: fair.map((f) => ({ label: f.label, how: f.strength === 'weak' ? 'disabled-somewhere' : 'disabled-everywhere' })),
    };
  }
  const n = ex.states.length;
  const inC = new Uint8Array(n);
  for (const s of comp.states) inC[s] = 1;
  // required waypoints: an edge for every constraint that is taken, a state where it is disabled otherwise
  const loop: number[] = [s0];
  const acts: number[] = [];
  const witness: Lasso['fairnessWitness'] = [];
  let cur = s0;
  const append = (p: { states: number[]; actions: number[] }) => {
    for (let i = 1; i < p.states.length; i++) { loop.push(p.states[i]); acts.push(p.actions[i - 1]); }
    cur = p.states[p.states.length - 1];
  };
  for (let f = 0; f < fair.length; f++) {
    const takenPath = bfsPath(ex, cur, inC, () => false, (e) => ctx.actionInFair[f][ex.edgeAction[e]] === 1 && ex.edgeTo[e] !== ex.edgeFrom[e] && inC[ex.edgeTo[e]] === 1);
    if (takenPath) {
      append(takenPath);
      witness.push({ label: fair[f].label, how: 'taken' });
      continue;
    }
    if (fair[f].strength === 'weak') {
      const p = bfsPath(ex, cur, inC, (s) => !enabled[f][s]);
      if (!p) throw new Error('internal: fair component without a disabling state');
      append(p);
      witness.push({ label: fair[f].label, how: 'disabled-somewhere' });
    } else {
      witness.push({ label: fair[f].label, how: 'disabled-everywhere' });
    }
  }
  // make sure the loop is a real cycle (at least one step) and close it back to s0
  if (loop.length === 1) {
    const p = bfsPath(ex, cur, inC, () => false, (e) => ex.edgeTo[e] !== ex.edgeFrom[e] && inC[ex.edgeTo[e]] === 1);
    if (!p) throw new Error('internal: SCC without an edge');
    append(p);
  }
  if (cur !== s0) {
    const back = bfsPath(ex, cur, inC, (s) => s === s0);
    if (!back) throw new Error('internal: SCC not strongly connected');
    append(back);
  } else if (loop.length > 1) {
    // we are already back at s0: the final state duplicates loop[0]
  }
  // loop currently ends at s0 again (last element === s0) unless it never left; drop the duplicate
  if (loop.length > 1 && loop[loop.length - 1] === s0) loop.pop();
  return { loop, loopActions: acts, stutter: false, fairnessWitness: witness };
}

export function checkLiveness(ex: Exploration): LivenessResult[] {
  const m: CompiledModel = ex.model;
  if (!m.liveness.length) return [];
  if (!ex.complete) {
    return m.liveness.map((l) => ({
      name: l.name, status: 'INCOMPLETE' as const,
      note: 'Liveness needs the complete reachable graph; exploration stopped at a resource cap, so no verdict is given.',
    }));
  }
  if (ex.domainViolations.length || ex.evalFailures.length) {
    return m.liveness.map((l) => ({
      name: l.name, status: 'ERROR' as const,
      note: 'The model has domain violations or evaluation errors, so its behaviours are not well defined; fix those first.',
    }));
  }
  const ctx = buildCtx(ex);
  const n = ex.states.length;
  const out: LivenessResult[] = [];
  for (const l of m.liveness) {
    const q = compileExpr(l.q);
    const p = l.p ? compileExpr(l.p) : null;
    const notQ = new Uint8Array(n);
    const startSet = new Uint8Array(n);
    try {
      for (let s = 0; s < n; s++) {
        if (!q(ex.states[s])) notQ[s] = 1;
      }
      if (l.kind === 'eventually') {
        for (const s of ex.initial) if (notQ[s]) startSet[s] = 1;
      } else {
        for (let s = 0; s < n; s++) if (notQ[s] && p!(ex.states[s])) startSet[s] = 1;
      }
    } catch (e) {
      if (e instanceof EvalError) { out.push({ name: l.name, status: 'ERROR', note: e.message }); continue; }
      throw e;
    }
    // restrict to not-Q states reachable (inside not-Q) from the start set
    const region = new Uint8Array(n);
    const q2: number[] = [];
    for (let s = 0; s < n; s++) if (startSet[s]) { region[s] = 1; q2.push(s); }
    for (let h = 0; h < q2.length; h++) {
      const v = q2[h];
      for (let e = ex.outStart[v]; e < ex.outEnd[v]; e++) {
        const w = ex.edgeTo[e];
        if (notQ[w] && !region[w]) { region[w] = 1; q2.push(w); }
      }
    }
    const candidates = q2.length;
    const fairComp = candidates ? findFairComponent(ctx, region) : null;
    if (!fairComp) {
      out.push({
        name: l.name, status: 'VERIFIED_BOUNDED', candidateStates: candidates,
        note: `No fair behaviour avoids the goal forever in the complete ${n}-state graph under ${ctx.fair.length ? ctx.fair.map((f) => f.label).join(', ') : 'no fairness (stuttering allowed)'}.`,
      });
      continue;
    }
    const loopPart = buildLoop(ctx, fairComp);
    // stem: choose the start state with the smallest BFS depth that reaches the loop inside not-Q
    const target = new Uint8Array(n);
    for (const s of fairComp.states) target[s] = 1;
    const loopStart = loopPart.loop[0];
    let best: { stem: number[]; acts: number[] } | null = null;
    const starts = q2.filter((s) => startSet[s]).sort((a, b) => ex.depth[a] - ex.depth[b]);
    for (const s of starts) {
      const inner = bfsPath(ex, s, notQ, (x) => x === loopStart);
      if (!inner) continue;
      // prefix: BFS parent path from an initial state to s (unrestricted for leadsto; for eventually s is initial)
      const prefix: number[] = [];
      const prefixActs: number[] = [];
      let cur = s;
      while (cur >= 0) { prefix.push(cur); if (ex.parent[cur] >= 0) prefixActs.push(ex.parentAction[cur]); cur = ex.parent[cur]; }
      prefix.reverse(); prefixActs.reverse();
      const stem = [...prefix, ...inner.states.slice(1)];
      const acts = [...prefixActs, ...inner.actions];
      if (!best || stem.length < best.stem.length) best = { stem, acts };
      if (best.stem.length <= ex.depth[s] + 1) break;
    }
    if (!best) throw new Error('internal: fair component unreachable from start set');
    out.push({
      name: l.name, status: 'VIOLATED', candidateStates: candidates,
      lasso: { stem: best.stem, stemActions: best.acts, ...loopPart },
      note: fairComp.stutter
        ? 'A reachable state where the goal is false and no fairness constraint is enabled: the behaviour may stutter there forever.'
        : `A fair cycle of ${fairComp.states.length} state(s) avoids the goal forever while respecting ${ctx.fair.map((f) => f.label).join(', ') || 'no fairness'}.`,
    });
  }
  return out;
}

/** Strongly connected components of the whole reachable graph (for the Temporal Observatory). */
export function graphSccs(ex: Exploration): { comp: number[]; count: number; nontrivial: number[][] } {
  const all = new Uint8Array(ex.states.length).fill(1);
  const { comp, count } = sccs(ex, all);
  const members: number[][] = Array.from({ length: count }, () => []);
  for (let s = 0; s < comp.length; s++) if (comp[s] >= 0) members[comp[s]].push(s);
  return { comp: Array.from(comp), count, nontrivial: members.filter((c) => c.length > 1) };
}
