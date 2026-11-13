// Runs exploration + property analysis and produces a serialisable, typed result.
import type { CompiledModel } from '../model/ir.ts';
import { explore, pathTo, ENGINE_NAME, ENGINE_VERSION, type Bounds, type Exploration, type ExploreOptions } from './explore.ts';
import { checkLiveness, graphSccs, type LivenessResult } from './liveness.ts';
import { renderState, stateDigest, type Value } from './state.ts';
import { createHash } from 'node:crypto';

export type PropertyStatus = 'VERIFIED_BOUNDED' | 'VIOLATED' | 'INCOMPLETE' | 'UNSUPPORTED' | 'NOT_RUN' | 'ERROR';
export type RunVerdict = 'VIOLATION_FOUND' | 'NO_VIOLATION_IN_BOUNDED_MODEL' | 'INCOMPLETE' | 'ERROR';

export interface TraceStep {
  step: number; // logical step number (0 = initial state)
  stateId: number;
  state: Record<string, Value>;
  action: string | null; // label of the action that produced this state
  actionIndex: number | null;
  process: string | null;
  guard: string | null;
  changes: { variable: string; from: Value; to: Value }[];
  stutter?: boolean;
}

export interface Trace {
  kind: 'invariant' | 'deadlock' | 'domain' | 'liveness' | 'eval-error';
  property: string;
  steps: TraceStep[];
  /** For liveness lassos: index into steps where the loop starts; the last step returns there. */
  loopStart?: number;
  stutterForever?: boolean;
  /** Domain violations: the out-of-domain value that the last step tried to write. */
  badWrite?: { variable: string; value: number };
  length: number; // number of transitions
  traceHash: string;
}

export interface PropertyResult {
  name: string;
  kind: 'invariant' | 'deadlock-freedom' | 'domain' | 'eventually' | 'leadsto';
  text: string;
  status: PropertyStatus;
  violatingStates?: number;
  trace?: Trace;
  note: string;
  checkedBy: 'internal';
}

export interface GraphPayload {
  nodes: { id: number; depth: number; key: string; flags: number; scc: number; viol?: string[] }[];
  edges: { from: number; to: number; action: number }[];
  truncated: boolean;
}
// node flags
export const F_INITIAL = 1, F_VIOLATION = 2, F_DEADLOCK = 4, F_TERMINAL = 8, F_FRONTIER = 16, F_WITNESS = 32, F_DOMAIN = 64;

export interface CheckResult {
  engine: { name: string; version: string; order: string };
  model: { name: string; title: string; description: string; vars: { name: string; type: string; process: string | null }[]; actions: { label: string; family: string; process: string; guard: string; assigns: string[]; reads: string[]; writes: string[] }[]; liveness: { name: string; kind: string; text: string }[]; invariants: { name: string; text: string }[]; processes: string[]; fairness: string[]; declaredStateSpace: number };
  bounds: Bounds;
  verdict: RunVerdict;
  complete: boolean;
  capReason: string | null;
  stats: { states: number; edges: number; generated: number; initialStates: number; maxDepth: number; deadlocks: number; terminals: number; elapsedMs: number; peakHeapMB: number; sccs?: number; nontrivialSccs?: number };
  properties: PropertyResult[];
  evalFailures: { state: number; where: string; message: string }[];
  graph?: GraphPayload;
  states?: Record<string, Value>[]; // rendered states for the graph payload (same ids)
  limitations: string[];
}

function typeText(m: CompiledModel, i: number): string {
  const t = m.vars[i].type;
  if (t.kind === 'int') return `${t.min}..${t.max}`;
  if (t.kind === 'bool') return 'bool';
  return `{${t.literals.join(', ')}}`;
}

export function traceHash(steps: TraceStep[], extra: object = {}): string {
  const body = JSON.stringify({ steps: steps.map((s) => ({ a: s.action, s: s.state, st: !!s.stutter })), ...extra });
  return createHash('sha256').update(body).digest('hex');
}

export function buildSteps(ex: Exploration, ids: number[], actions: (number | null)[]): TraceStep[] {
  const m = ex.model;
  return ids.map((id, i) => {
    const a = actions[i];
    const state = renderState(m, ex.states[id]);
    const prev = i > 0 ? ex.states[ids[i - 1]] : null;
    const changes: TraceStep['changes'] = [];
    if (prev) {
      for (const v of m.vars) {
        if (prev[v.index] !== ex.states[id][v.index]) {
          changes.push({ variable: v.name, from: renderState(m, prev)[v.name], to: state[v.name] });
        }
      }
    }
    const act = a !== null && a >= 0 ? m.actions[a] : null;
    return {
      step: i, stateId: id, state, action: act ? act.label : null, actionIndex: act ? act.index : null,
      process: act ? act.process : null, guard: act ? act.guardText : null, changes,
      stutter: a === -1 ? true : undefined,
    };
  });
}

function shortestTrace(ex: Exploration, id: number, kind: Trace['kind'], property: string): Trace {
  const ids = pathTo(ex, id);
  const acts = ids.map((s, i) => (i === 0 ? null : ex.parentAction[s]));
  const steps = buildSteps(ex, ids, acts);
  return { kind, property, steps, length: steps.length - 1, traceHash: traceHash(steps) };
}

export interface CheckOptions extends ExploreOptions {
  includeGraph?: boolean;
  graphLimit?: number;
}

export function check(model: CompiledModel, opts: CheckOptions = {}): { result: CheckResult; exploration: Exploration } {
  const ex = explore(model, opts);
  const props: PropertyResult[] = [];
  const witnessIds = new Set<number>();

  // invariants
  model.invariants.forEach((inv, k) => {
    const v = ex.invariantViolations[k];
    if (v.length) {
      // BFS discovery order: the first violating state has minimal depth.
      const tr = shortestTrace(ex, v[0], 'invariant', inv.name);
      tr.steps.forEach((s) => witnessIds.add(s.stateId));
      props.push({
        name: inv.name, kind: 'invariant', text: inv.text, status: 'VIOLATED', violatingStates: v.length, trace: tr, checkedBy: 'internal',
        note: `Violated in ${v.length}${v.length >= 5000 ? '+' : ''} reachable state(s); shortest witness has ${tr.length} step(s) (breadth-first search).`,
      });
    } else if (ex.complete) {
      props.push({
        name: inv.name, kind: 'invariant', text: inv.text, status: 'VERIFIED_BOUNDED', violatingStates: 0, checkedBy: 'internal',
        note: `Holds in all ${ex.states.length} reachable states of this finite model (exhaustive BFS, no cap hit). Not a proof about any real system.`,
      });
    } else {
      props.push({
        name: inv.name, kind: 'invariant', text: inv.text, status: 'INCOMPLETE', violatingStates: 0, checkedBy: 'internal',
        note: `No violation among the ${ex.states.length} states explored before the ${ex.capReason} cap. This is NOT evidence of safety.`,
      });
    }
  });

  // deadlock freedom (always checked)
  if (ex.deadlocks.length) {
    const tr = shortestTrace(ex, ex.deadlocks[0], 'deadlock', 'DeadlockFreedom');
    tr.steps.forEach((s) => witnessIds.add(s.stateId));
    props.push({
      name: 'DeadlockFreedom', kind: 'deadlock-freedom', text: model.terminal ? `no reachable state without enabled actions unless ${model.terminalText}` : 'no reachable state without enabled actions',
      status: 'VIOLATED', violatingStates: ex.deadlocks.length, trace: tr, checkedBy: 'internal',
      note: `${ex.deadlocks.length} reachable state(s) have no enabled action and are not declared terminal.`,
    });
  } else {
    props.push({
      name: 'DeadlockFreedom', kind: 'deadlock-freedom', text: model.terminal ? `no stuck state except intended terminal states (${model.terminalText})` : 'no reachable state without enabled actions',
      status: ex.complete ? 'VERIFIED_BOUNDED' : 'INCOMPLETE', violatingStates: 0, checkedBy: 'internal',
      note: ex.complete ? `No deadlock in the complete reachable graph (${ex.terminals.length} intended terminal state(s)).` : 'No deadlock among expanded states; frontier states were never expanded, so this is not a verdict.',
    });
  }

  // domain (type) safety: assignments must stay inside declared domains
  if (ex.domainViolations.length) {
    const dv = ex.domainViolations[0];
    // BFS order of `from` + action order => first recorded is a shortest one
    const ids = pathTo(ex, dv.from);
    const acts = ids.map((s, i) => (i === 0 ? null : ex.parentAction[s]));
    const steps = buildSteps(ex, ids, acts);
    const v = model.vars[dv.variable];
    const badState = renderState(model, Int32Array.from(dv.badState));
    const prevState = steps[steps.length - 1].state;
    const act = model.actions[dv.action];
    steps.push({
      step: steps.length, stateId: -1, state: badState, action: act.label, actionIndex: dv.action,
      process: act.process, guard: act.guardText,
      changes: model.vars.filter((x) => dv.badState[x.index] !== ex.states[dv.from][x.index]).map((x) => ({ variable: x.name, from: prevState[x.name], to: badState[x.name] })),
    });
    steps.forEach((s) => s.stateId >= 0 && witnessIds.add(s.stateId));
    const tr: Trace = { kind: 'domain', property: 'TypeOK', steps, length: steps.length - 1, badWrite: { variable: v.name, value: dv.value }, traceHash: traceHash(steps) };
    props.push({
      name: 'TypeOK', kind: 'domain', text: 'every variable stays inside its declared domain', status: 'VIOLATED', violatingStates: ex.domainViolations.length, trace: tr, checkedBy: 'internal',
      note: `Action ${model.actions[dv.action].label} writes ${dv.value} to ${v.name}, outside ${typeText(model, dv.variable)}.`,
    });
  } else {
    props.push({
      name: 'TypeOK', kind: 'domain', text: 'every variable stays inside its declared domain',
      status: ex.complete ? 'VERIFIED_BOUNDED' : 'INCOMPLETE', violatingStates: 0, checkedBy: 'internal',
      note: ex.complete ? 'No assignment leaves its declared domain in the reachable graph.' : 'No domain violation seen before the cap.',
    });
  }

  // liveness
  const live: LivenessResult[] = checkLiveness(ex);
  for (const l of live) {
    const info = model.liveness.find((x) => x.name === l.name)!;
    let trace: Trace | undefined;
    if (l.lasso) {
      const ids = [...l.lasso.stem, ...l.lasso.loop.slice(1)];
      const acts: (number | null)[] = [null, ...l.lasso.stemActions, ...l.lasso.loopActions.slice(0, l.lasso.loop.length - 1)];
      const steps = buildSteps(ex, ids, acts);
      const loopStart = l.lasso.stem.length - 1;
      if (l.lasso.stutter) {
        const last = steps[steps.length - 1];
        steps.push({ ...last, step: steps.length, action: null, actionIndex: null, process: null, guard: null, changes: [], stutter: true });
      } else {
        // closing step back to the loop start
        const lastId = ids[ids.length - 1];
        const closeAct = l.lasso.loopActions[l.lasso.loop.length - 1];
        const closing = buildSteps(ex, [lastId, l.lasso.loop[0]], [null, closeAct])[1];
        steps.push({ ...closing, step: steps.length });
      }
      steps.forEach((s) => witnessIds.add(s.stateId));
      trace = {
        kind: 'liveness', property: l.name, steps, loopStart, stutterForever: l.lasso.stutter, length: steps.length - 1,
        traceHash: traceHash(steps, { loopStart, stutter: l.lasso.stutter }),
      };
    }
    props.push({
      name: l.name, kind: info.kind, text: info.text, status: l.status, trace, checkedBy: 'internal',
      note: `${l.note}${l.lasso ? ` Fairness respected by the loop: ${l.lasso.fairnessWitness.map((w) => `${w.label} ${w.how}`).join('; ') || 'no fairness declared'}.` : ''}`,
    });
  }

  const anyViolation = props.some((p) => p.status === 'VIOLATED');
  const anyError = props.some((p) => p.status === 'ERROR') || ex.evalFailures.length > 0;
  const verdict: RunVerdict = anyError ? 'ERROR' : anyViolation ? 'VIOLATION_FOUND' : ex.complete ? 'NO_VIOLATION_IN_BOUNDED_MODEL' : 'INCOMPLETE';

  const scc = ex.complete && ex.states.length <= 200_000 ? graphSccs(ex) : null;
  const result: CheckResult = {
    engine: { name: ENGINE_NAME, version: ENGINE_VERSION, order: 'breadth-first; initial states in declaration order; actions in declaration order, then parameter order' },
    model: {
      name: model.name, title: model.title, description: model.description,
      vars: model.vars.map((v) => ({ name: v.name, type: typeText(model, v.index), process: v.process })),
      actions: model.actions.map((a) => {
        const reads = new Set<number>();
        if (a.guard) varsOf(a.guard, reads);
        for (const x of a.assigns) varsOf(x.e, reads);
        return {
          label: a.label, family: a.family, process: a.process, guard: a.guardText, assigns: a.assigns.map((x) => x.text),
          reads: [...reads].sort((p, q) => p - q).map((i) => model.vars[i].name), writes: a.assigns.map((x) => model.vars[x.v].name),
        };
      }),
      liveness: model.liveness.map((l) => ({ name: l.name, kind: l.kind, text: l.text })),
      invariants: model.invariants.map((i) => ({ name: i.name, text: i.text })),
      processes: model.processes.map((p) => p.name),
      fairness: model.fairness.map((f) => f.label),
      declaredStateSpace: model.declaredStateSpace,
    },
    bounds: ex.bounds,
    verdict,
    complete: ex.complete,
    capReason: ex.capReason,
    stats: {
      states: ex.states.length, edges: ex.edgeFrom.length, generated: ex.generated, initialStates: ex.initial.length,
      maxDepth: ex.maxDepthSeen, deadlocks: ex.deadlocks.length, terminals: ex.terminals.length,
      elapsedMs: Math.round(ex.elapsedMs * 10) / 10, peakHeapMB: Math.round(ex.peakHeapMB),
      sccs: scc?.count, nontrivialSccs: scc?.nontrivial.length,
    },
    properties: props,
    evalFailures: ex.evalFailures.slice(0, 50).map((f) => ({ state: f.state, where: f.where, message: f.message })),
    limitations: limitationsFor(ex),
  };

  if (opts.includeGraph !== false) {
    const limit = opts.graphLimit ?? 5_000;
    const n = Math.min(ex.states.length, limit);
    const flags = new Uint8Array(ex.states.length);
    for (const s of ex.initial) flags[s] |= F_INITIAL;
    ex.invariantViolations.forEach((v) => v.forEach((s) => (flags[s] |= F_VIOLATION)));
    ex.deadlocks.forEach((s) => (flags[s] |= F_DEADLOCK));
    ex.terminals.forEach((s) => (flags[s] |= F_TERMINAL));
    ex.domainViolations.forEach((d) => (flags[d.from] |= F_DOMAIN));
    for (let s = 0; s < ex.states.length; s++) if (!ex.expanded[s]) flags[s] |= F_FRONTIER;
    witnessIds.forEach((s) => (flags[s] |= F_WITNESS));
    const viol = new Map<number, string[]>();
    ex.invariantViolations.forEach((v, k) => v.forEach((s) => viol.set(s, [...(viol.get(s) ?? []), model.invariants[k].name])));
    const nodes: GraphPayload['nodes'] = [];
    for (let s = 0; s < n; s++) {
      const node: GraphPayload['nodes'][number] = { id: s, depth: ex.depth[s], key: stateDigest(model, ex.states[s]).slice(0, 12), flags: flags[s], scc: scc ? scc.comp[s] : -1 };
      if (viol.has(s)) node.viol = viol.get(s);
      nodes.push(node);
    }
    const edges: GraphPayload['edges'] = [];
    for (let e = 0; e < ex.edgeFrom.length && edges.length < limit * 8; e++) {
      if (ex.edgeFrom[e] < n && ex.edgeTo[e] < n) edges.push({ from: ex.edgeFrom[e], to: ex.edgeTo[e], action: ex.edgeAction[e] });
    }
    result.graph = { nodes, edges, truncated: n < ex.states.length };
    result.states = [];
    for (let s = 0; s < n; s++) result.states.push(renderState(model, ex.states[s]));
  }
  return { result, exploration: ex };
}

function varsOf(e: import('../model/ir.ts').IrExpr, out: Set<number>): void {
  switch (e.k) {
    case 'var': out.add(e.i); return;
    case 'const': return;
    case 'un': varsOf(e.a, out); return;
    case 'bin': varsOf(e.a, out); varsOf(e.b, out); return;
    case 'ite': varsOf(e.c, out); varsOf(e.t, out); varsOf(e.e, out); return;
  }
}

function limitationsFor(ex: Exploration): string[] {
  const out = [
    'Evidence covers only this finite model: its declared variable domains, initial states, actions and fairness assumptions.',
    'Logical steps are interleaved atomic actions; no wall-clock time, latency or real scheduler is modelled unless the model encodes it.',
    'A model that verifies does not show that any implementation matches the model.',
  ];
  if (!ex.complete) out.unshift(`INCOMPLETE: exploration stopped at the ${ex.capReason} cap after ${ex.states.length} states; absence of violations means nothing beyond the explored part.`);
  if (ex.model.liveness.length && !ex.model.fairness.length) out.push('Liveness was checked with no fairness: TLA+ semantics allow a behaviour to stutter forever, so most liveness claims fail without fairness.');
  return out;
}
