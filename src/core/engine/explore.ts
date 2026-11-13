// Explicit-state breadth-first exploration of a finite transition system (S, S0, A, T).
// See docs/SEARCH_ALGORITHMS.md. BFS guarantees that the first state discovered that
// violates an invariant is at minimal depth, so parent pointers give a shortest witness.
import type { CompiledModel } from '../model/ir.ts';
import { compileExpr, EvalError, type Fn } from './evaluate.ts';
import { stateKey, type StateVec } from './state.ts';

export const ENGINE_NAME = 'witness-bfs';
export const ENGINE_VERSION = '0.1.0';

export interface Bounds {
  maxStates: number;
  maxEdges: number;
  maxDepth: number;
  timeLimitMs: number;
  maxHeapMB: number;
}

export const DEFAULT_BOUNDS: Bounds = {
  maxStates: 200_000,
  maxEdges: 2_000_000,
  maxDepth: 5_000,
  timeLimitMs: 30_000,
  maxHeapMB: 1_536,
};

export const HARD_BOUNDS: Bounds = {
  maxStates: 2_000_000,
  maxEdges: 20_000_000,
  maxDepth: 100_000,
  timeLimitMs: 300_000,
  maxHeapMB: 3_072,
};

export function clampBounds(b: Partial<Bounds> | undefined): Bounds {
  const out = { ...DEFAULT_BOUNDS };
  for (const k of Object.keys(DEFAULT_BOUNDS) as (keyof Bounds)[]) {
    const v = b?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) throw new Error(`bound ${k} must be a positive number`);
    out[k] = Math.min(Math.floor(v), HARD_BOUNDS[k]);
  }
  return out;
}

export type CapReason = 'maxStates' | 'maxEdges' | 'maxDepth' | 'timeLimitMs' | 'maxHeapMB' | 'cancelled';

export interface DomainViolation {
  from: number; // state id
  action: number;
  variable: number;
  value: number;
  badState: number[]; // successor vector containing the out-of-domain value
}

export interface EvalFailure {
  state: number;
  action: number | null; // null: while evaluating a property / terminal predicate
  where: string;
  message: string;
}

export interface Exploration {
  model: CompiledModel;
  bounds: Bounds;
  complete: boolean;
  capReason: CapReason | null;
  states: StateVec[];
  depth: number[];
  parent: number[]; // -1 for initial states
  parentAction: number[]; // -1 for initial states
  initial: number[];
  expanded: Uint8Array; // 1 when all successors were generated
  edgeFrom: number[];
  edgeTo: number[];
  edgeAction: number[];
  outStart: number[]; // edges of state i are [outStart[i], outEnd[i]) when expanded
  outEnd: number[];
  /** For each invariant: ids of reachable violating states (BFS order, capped list). */
  invariantViolations: number[][];
  deadlocks: number[]; // expanded, no successors, not terminal
  terminals: number[]; // expanded, no successors, terminal predicate holds
  domainViolations: DomainViolation[];
  evalFailures: EvalFailure[];
  maxDepthSeen: number;
  elapsedMs: number;
  peakHeapMB: number;
  generated: number; // successor computations, including duplicates (like TLC's "states generated")
}

export interface ExploreOptions {
  bounds?: Partial<Bounds>;
  onProgress?: (p: { states: number; edges: number; depth: number; elapsedMs: number }) => void;
  shouldCancel?: () => boolean;
  progressEvery?: number;
  maxRecordedViolations?: number;
}

function heapMB(): number {
  const mu = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process?.memoryUsage?.();
  return mu ? mu.heapUsed / (1024 * 1024) : 0;
}

export function explore(model: CompiledModel, opts: ExploreOptions = {}): Exploration {
  const bounds = clampBounds(opts.bounds);
  const maxRec = opts.maxRecordedViolations ?? 5_000;
  const t0 = performance.now();
  const nv = model.vars.length;
  const guards: (Fn | null)[] = model.actions.map((a) => (a.guard ? compileExpr(a.guard) : null));
  const effects = model.actions.map((a) => a.assigns.map((x) => ({ v: x.v, f: compileExpr(x.e) })));
  const invs = model.invariants.map((p) => compileExpr(p.expr));
  const terminal = model.terminal ? compileExpr(model.terminal) : null;
  const inDomain: ((x: number) => boolean)[] = model.vars.map((v) => {
    if (v.type.kind === 'int') { const lo = v.type.min, hi = v.type.max; return (x: number) => x >= lo && x <= hi; }
    const set = new Set(v.domain);
    return (x: number) => set.has(x);
  });

  const ex: Exploration = {
    model, bounds, complete: false, capReason: null, states: [], depth: [], parent: [], parentAction: [], initial: [],
    expanded: new Uint8Array(0), edgeFrom: [], edgeTo: [], edgeAction: [], outStart: [], outEnd: [],
    invariantViolations: model.invariants.map(() => []), deadlocks: [], terminals: [], domainViolations: [],
    evalFailures: [], maxDepthSeen: 0, elapsedMs: 0, peakHeapMB: 0, generated: 0,
  };
  const index = new Map<string, number>();
  let expandedFlags: number[] = [];
  let cap: CapReason | null = null;

  const addState = (vec: StateVec, depth: number, parent: number, action: number): number => {
    const key = stateKey(vec);
    const hit = index.get(key);
    if (hit !== undefined) return hit;
    const id = ex.states.length;
    index.set(key, id);
    ex.states.push(vec);
    ex.depth.push(depth);
    ex.parent.push(parent);
    ex.parentAction.push(action);
    ex.outStart.push(-1);
    ex.outEnd.push(-1);
    expandedFlags.push(0);
    if (depth > ex.maxDepthSeen) ex.maxDepthSeen = depth;
    // invariants are checked when a state is first discovered (BFS order => shortest witness first)
    for (let k = 0; k < invs.length; k++) {
      let ok: number;
      try {
        ok = invs[k](vec);
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        ex.evalFailures.push({ state: id, action: null, where: `invariant ${model.invariants[k].name}`, message: e.message });
        ok = 1;
      }
      if (!ok && ex.invariantViolations[k].length < maxRec) ex.invariantViolations[k].push(id);
    }
    return id;
  };

  // ---- initial states: cartesian product of each variable's initial set, in declaration order
  let combos: number[][] = [[]];
  for (const v of model.vars) {
    const nxt: number[][] = [];
    for (const c of combos) for (const x of v.init) nxt.push([...c, x]);
    combos = nxt;
    if (combos.length > 100_000) throw new Error('too many initial states');
  }
  for (const c of combos) {
    if (ex.states.length >= bounds.maxStates) { cap = 'maxStates'; break; }
    const id = addState(Int32Array.from(c), 0, -1, -1);
    if (!ex.initial.includes(id)) ex.initial.push(id);
  }

  // ---- BFS
  const progressEvery = opts.progressEvery ?? 2_000;
  let head = 0;
  const next = new Int32Array(nv);
  while (head < ex.states.length && !cap) {
    const id = head;
    const s = ex.states[id];
    const d = ex.depth[id];
    if (d >= bounds.maxDepth) { cap = 'maxDepth'; break; }
    if ((id & 1023) === 0) {
      const el = performance.now() - t0;
      if (el > bounds.timeLimitMs) { cap = 'timeLimitMs'; break; }
      const h = heapMB();
      if (h > ex.peakHeapMB) ex.peakHeapMB = h;
      if (h > bounds.maxHeapMB) { cap = 'maxHeapMB'; break; }
      if (opts.shouldCancel?.()) { cap = 'cancelled'; break; }
      if (opts.onProgress && id % progressEvery === 0) opts.onProgress({ states: ex.states.length, edges: ex.edgeFrom.length, depth: d, elapsedMs: el });
    }
    const start = ex.edgeFrom.length;
    let overflow = false;
    for (let a = 0; a < model.actions.length; a++) {
      const g = guards[a];
      let enabled: number;
      try {
        enabled = g ? g(s) : 1;
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        ex.evalFailures.push({ state: id, action: a, where: `guard of ${model.actions[a].label}`, message: e.message });
        continue;
      }
      if (!enabled) continue;
      next.set(s);
      let bad: { v: number; x: number } | null = null;
      try {
        // simultaneous assignment: every right-hand side reads the pre-state `s`
        const eff = effects[a];
        const vals = eff.map((x) => x.f(s));
        for (let k = 0; k < eff.length; k++) {
          next[eff[k].v] = vals[k];
          if (!bad && !inDomain[eff[k].v](vals[k])) bad = { v: eff[k].v, x: vals[k] };
        }
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        ex.evalFailures.push({ state: id, action: a, where: `effect of ${model.actions[a].label}`, message: e.message });
        continue;
      }
      ex.generated++;
      if (bad) {
        if (ex.domainViolations.length < maxRec) ex.domainViolations.push({ from: id, action: a, variable: bad.v, value: bad.x, badState: Array.from(next) });
        continue;
      }
      if (ex.edgeFrom.length >= bounds.maxEdges) { cap = 'maxEdges'; overflow = true; break; }
      const key = stateKey(next);
      let to = index.get(key);
      if (to === undefined) {
        if (ex.states.length >= bounds.maxStates) { cap = 'maxStates'; overflow = true; break; }
        to = addState(Int32Array.from(next), d + 1, id, a);
      }
      ex.edgeFrom.push(id);
      ex.edgeTo.push(to);
      ex.edgeAction.push(a);
    }
    if (overflow) {
      // this state's successor set is only partially known: roll its edges back so that
      // "expanded" always means "all successors present".
      ex.edgeFrom.length = start; ex.edgeTo.length = start; ex.edgeAction.length = start;
      break;
    }
    ex.outStart[id] = start;
    ex.outEnd[id] = ex.edgeFrom.length;
    expandedFlags[id] = 1;
    if (ex.outEnd[id] === start) {
      let term = 0;
      try {
        term = terminal ? terminal(s) : 0;
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        ex.evalFailures.push({ state: id, action: null, where: 'terminal predicate', message: e.message });
      }
      (term ? ex.terminals : ex.deadlocks).push(id);
    }
    head++;
  }
  ex.expanded = Uint8Array.from(expandedFlags);
  ex.complete = !cap && head >= ex.states.length;
  ex.capReason = cap;
  ex.elapsedMs = performance.now() - t0;
  const h = heapMB();
  if (h > ex.peakHeapMB) ex.peakHeapMB = h;
  expandedFlags = [];
  return ex;
}

/** Shortest path (state ids) from an initial state to `id`, following BFS parent pointers. */
export function pathTo(ex: Exploration, id: number): number[] {
  const out: number[] = [];
  let cur = id;
  while (cur >= 0) {
    out.push(cur);
    cur = ex.parent[cur];
  }
  return out.reverse();
}
