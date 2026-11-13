// Independent witness replay.
//
// This evaluator re-checks a counterexample trace against the model's transition semantics
// WITHOUT using the explorer's code path: it does not use the compiled IR, the integer value
// encoding or the closure compiler. It walks the parsed AST directly with its own name
// resolution over named JavaScript values (numbers, booleans, literal strings). It shares
// only the lexer/parser with the explorer (see docs/TRANSITION_SEMANTICS.md §Independence).
import type { ActionDecl, Expr, ModelAst, ProcessDecl, TypeExpr, VarDecl } from '../syntax/ast.ts';
import { parseModel } from '../syntax/parser.ts';

export const REPLAY_NAME = 'witness-replay';
export const REPLAY_VERSION = '0.1.0';

type V = number | boolean | string;
type St = Map<string, V>;

export interface ReplayStep {
  action: string | null;
  state: Record<string, V>;
  stutter?: boolean;
}

export interface ReplayClaim {
  kind: 'invariant' | 'deadlock' | 'domain' | 'liveness' | 'none';
  property: string;
  loopStart?: number;
  stutterForever?: boolean;
  badWrite?: { variable: string; value: number };
}

export interface ReplayResult {
  ok: boolean;
  evaluator: string;
  version: string;
  checkedSteps: number;
  reason: string;
  failedAt?: number;
}

class ReplayError extends Error {}

interface Inst {
  proc: string;
  decl: ProcessDecl;
}

interface Domain {
  kind: 'int' | 'bool' | 'enum';
  values: V[];
  min?: number;
  max?: number;
}

class Interp {
  ast: ModelAst;
  consts = new Map<string, V>();
  enums = new Map<string, string[]>();
  allLiterals = new Set<string>();
  insts: Inst[] = [];
  varDomains = new Map<string, Domain>();
  varOrder: string[] = [];

  constructor(ast: ModelAst) {
    this.ast = ast;
    for (const k of ast.consts) this.consts.set(k.name, this.ev(k.value, new Map(), null, new Map()));
    for (const t of ast.types) {
      this.enums.set(t.name, t.literals);
      t.literals.forEach((l) => this.allLiterals.add(l));
    }
    for (const p of ast.processes) for (const n of p.names) this.insts.push({ proc: n, decl: p });
    for (const v of ast.vars) this.addVar(v.name, v);
    for (const i of this.insts) for (const l of i.decl.locals) this.addVar(`${i.proc}.${l.name}`, l);
  }

  private addVar(name: string, v: VarDecl): void {
    this.varDomains.set(name, this.domain(v.type));
    this.varOrder.push(name);
  }

  domain(t: TypeExpr): Domain {
    if (t.kind === 'bool') return { kind: 'bool', values: [false, true] };
    if (t.kind === 'enum') { t.literals.forEach((l) => this.allLiterals.add(l)); return { kind: 'enum', values: [...t.literals] }; }
    if (t.kind === 'named') {
      const lits = this.enums.get(t.name);
      if (!lits) throw new ReplayError(`unknown type ${t.name}`);
      return { kind: 'enum', values: [...lits] };
    }
    const min = this.ev(t.min, new Map(), null, new Map());
    const max = this.ev(t.max, new Map(), null, new Map());
    if (typeof min !== 'number' || typeof max !== 'number') throw new ReplayError('range bounds must be numbers');
    const values: V[] = [];
    if (max - min > 1_000_000) throw new ReplayError('domain too large to replay');
    for (let x = min; x <= max; x++) values.push(x);
    return { kind: 'int', values, min, max };
  }

  inDomain(name: string, v: V): boolean {
    const d = this.varDomains.get(name)!;
    if (d.kind === 'int') return typeof v === 'number' && Number.isInteger(v) && v >= d.min! && v <= d.max!;
    if (d.kind === 'bool') return typeof v === 'boolean';
    return typeof v === 'string' && d.values.includes(v);
  }

  /** Name resolution: process local, parameter, global variable, constant, literal / process name. */
  private resolve(name: string, st: St, proc: string | null, params: Map<string, V>): V {
    if (proc && st.has(`${proc}.${name}`)) return st.get(`${proc}.${name}`)!;
    if (params.has(name)) return params.get(name)!;
    if (st.has(name)) return st.get(name)!;
    if (this.consts.has(name)) return this.consts.get(name)!;
    if (this.allLiterals.has(name) || this.insts.some((i) => i.proc === name)) return name;
    throw new ReplayError(`cannot resolve name '${name}'`);
  }

  ev(e: Expr, st: St, proc: string | null, params: Map<string, V>): V {
    const num = (x: V): number => {
      if (typeof x !== 'number') throw new ReplayError('expected a number');
      return x;
    };
    const bool = (x: V): boolean => {
      if (typeof x !== 'boolean') throw new ReplayError('expected a boolean');
      return x;
    };
    const lim = (x: number): number => {
      if (Math.abs(x) > 2_147_483_647) throw new ReplayError('integer overflow');
      return x;
    };
    switch (e.kind) {
      case 'int': return e.value;
      case 'bool': return e.value;
      case 'self':
        if (!proc) throw new ReplayError('self outside a process');
        return proc;
      case 'name': return this.resolve(e.name, st, proc, params);
      case 'qualified': {
        const k = `${e.process}.${e.name}`;
        if (!st.has(k)) throw new ReplayError(`unknown variable ${k}`);
        return st.get(k)!;
      }
      case 'unary': {
        const a = this.ev(e.arg, st, proc, params);
        return e.op === 'not' ? !bool(a) : lim(-num(a));
      }
      case 'ite': return bool(this.ev(e.cond, st, proc, params)) ? this.ev(e.then, st, proc, params) : this.ev(e.else, st, proc, params);
      case 'binary': {
        if (e.op === 'and') return bool(this.ev(e.left, st, proc, params)) ? bool(this.ev(e.right, st, proc, params)) : false;
        if (e.op === 'or') return bool(this.ev(e.left, st, proc, params)) ? true : bool(this.ev(e.right, st, proc, params));
        if (e.op === 'implies') return bool(this.ev(e.left, st, proc, params)) ? bool(this.ev(e.right, st, proc, params)) : true;
        const a = this.ev(e.left, st, proc, params);
        const b = this.ev(e.right, st, proc, params);
        switch (e.op) {
          case '=': return a === b;
          case '!=': return a !== b;
          case '<': return num(a) < num(b);
          case '<=': return num(a) <= num(b);
          case '>': return num(a) > num(b);
          case '>=': return num(a) >= num(b);
          case '+': return lim(num(a) + num(b));
          case '-': return lim(num(a) - num(b));
          case '*': return lim(num(a) * num(b));
          case '%': {
            const y = num(b);
            if (y <= 0) throw new ReplayError('modulo by non-positive value');
            const r = num(a) % y;
            return r < 0 ? r + y : r;
          }
        }
      }
    }
    throw new ReplayError('unknown expression');
  }

  /** Every concrete (process, action, params) instance, in no particular order. */
  instances(): { proc: string; act: ActionDecl; params: Map<string, V>; label: string }[] {
    const out: { proc: string; act: ActionDecl; params: Map<string, V>; label: string }[] = [];
    for (const i of this.insts) {
      for (const act of i.decl.actions) {
        let combos: [string, V][][] = [[]];
        for (const p of act.params) {
          const d = this.domain(p.domain);
          const nx: [string, V][][] = [];
          for (const c of combos) for (const v of d.values) nx.push([...c, [p.name, v]]);
          combos = nx;
        }
        for (const c of combos) {
          const label = c.length ? `${i.proc}.${act.name}(${c.map(([k, v]) => `${k}=${String(v)}`).join(',')})` : `${i.proc}.${act.name}`;
          out.push({ proc: i.proc, act, params: new Map(c), label });
        }
      }
    }
    return out;
  }

  enabled(inst: { proc: string; act: ActionDecl; params: Map<string, V> }, st: St): boolean {
    return inst.act.guard ? this.ev(inst.act.guard, st, inst.proc, inst.params) === true : true;
  }

  /** Apply an action: all right-hand sides read the pre-state (simultaneous assignment). */
  apply(inst: { proc: string; act: ActionDecl; params: Map<string, V> }, st: St): { next: St; writes: { name: string; value: V }[] } {
    const writes = inst.act.body.map((a) => {
      const target = a.targetProcess ? `${a.targetProcess}.${a.target}` : st.has(`${inst.proc}.${a.target}`) ? `${inst.proc}.${a.target}` : a.target;
      if (!st.has(target)) throw new ReplayError(`assignment to unknown variable ${target}`);
      return { name: target, value: this.ev(a.value, st, inst.proc, inst.params) };
    });
    const next = new Map(st);
    for (const w of writes) next.set(w.name, w.value);
    return { next, writes };
  }

  isInitial(st: St): string | null {
    const check = (name: string, v: VarDecl, proc: string | null): string | null => {
      const val = st.get(name);
      if (v.init.kind === 'value') {
        const want = this.ev(v.init.expr, new Map(), proc, new Map());
        return val === want ? null : `${name} is ${String(val)} but its initial value is ${String(want)}`;
      }
      const d = this.domain(v.init.set);
      return d.values.includes(val as V) ? null : `${name}=${String(val)} is not in its initial set`;
    };
    for (const v of this.ast.vars) { const r = check(v.name, v, null); if (r) return r; }
    for (const i of this.insts) for (const l of i.decl.locals) { const r = check(`${i.proc}.${l.name}`, l, i.proc); if (r) return r; }
    return null;
  }

  terminal(st: St): boolean {
    return this.ast.terminals.some((t) => this.ev(t, st, null, new Map()) === true);
  }
}

function toState(interp: Interp, rec: Record<string, V>, i: number): St {
  const keys = Object.keys(rec);
  const want = interp.varOrder;
  if (keys.length !== want.length || !want.every((k) => Object.prototype.hasOwnProperty.call(rec, k))) {
    throw new ReplayError(`step ${i}: state does not list exactly the model's variables`);
  }
  const st: St = new Map();
  for (const k of want) {
    const v = rec[k];
    if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string') throw new ReplayError(`step ${i}: ${k} has an invalid value`);
    st.set(k, v);
  }
  return st;
}

function same(a: St, b: St): boolean {
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return a.size === b.size;
}

/**
 * Replay a trace and confirm the claim it makes. `steps[0]` must be an initial state; each later
 * step must be produced by its named action from the previous state (or be a declared stutter).
 */
export function replayTrace(source: string, steps: ReplayStep[], claim: ReplayClaim): ReplayResult {
  const base = { evaluator: REPLAY_NAME, version: REPLAY_VERSION };
  let at = 0;
  try {
    if (!Array.isArray(steps) || steps.length === 0) throw new ReplayError('empty trace');
    if (steps.length > 100_000) throw new ReplayError('trace too long');
    const ast = parseModel(source);
    const interp = new Interp(ast);
    const insts = interp.instances();
    const byLabel = new Map(insts.map((x) => [x.label, x]));
    const states: St[] = [];
    const isDomainClaim = claim.kind === 'domain';
    for (let i = 0; i < steps.length; i++) {
      at = i;
      const st = toState(interp, steps[i].state, i);
      const last = i === steps.length - 1;
      for (const [k, v] of st) {
        if (!interp.inDomain(k, v) && !(isDomainClaim && last)) throw new ReplayError(`step ${i}: ${k}=${String(v)} is outside its declared domain`);
      }
      if (i === 0) {
        if (steps[0].action !== null) throw new ReplayError('step 0 must be an initial state (no action)');
        const why = interp.isInitial(st);
        if (why) throw new ReplayError(`step 0 is not an initial state: ${why}`);
      } else if (steps[i].stutter) {
        if (!same(states[i - 1], st)) throw new ReplayError(`step ${i}: a stutter step must leave the state unchanged`);
      } else {
        const label = steps[i].action;
        const inst = label ? byLabel.get(label) : undefined;
        if (!inst) throw new ReplayError(`step ${i}: unknown action '${String(label)}'`);
        if (!interp.enabled(inst, states[i - 1])) throw new ReplayError(`step ${i}: ${label} is not enabled in the previous state`);
        const { next } = interp.apply(inst, states[i - 1]);
        if (!same(next, st)) {
          const diff = [...next].filter(([k, v]) => st.get(k) !== v).map(([k, v]) => `${k}: expected ${String(v)}, trace says ${String(st.get(k))}`);
          throw new ReplayError(`step ${i}: ${label} does not produce the recorded state (${diff.join('; ')})`);
        }
      }
      states.push(st);
    }
    at = steps.length - 1;
    const final = states[states.length - 1];
    const prop = ast.properties.find((p) => p.name === claim.property);
    switch (claim.kind) {
      case 'none':
        return { ok: true, ...base, checkedSteps: steps.length, reason: 'every step is a valid transition' };
      case 'invariant': {
        if (!prop || prop.kind !== 'invariant') throw new ReplayError(`model has no invariant '${claim.property}'`);
        for (let i = 0; i < states.length - 1; i++) {
          if (interp.ev(prop.expr, states[i], null, new Map()) !== true) { at = i; throw new ReplayError(`invariant already fails at step ${i}; the trace is not minimal-by-construction`); }
        }
        if (interp.ev(prop.expr, final, null, new Map()) !== false) throw new ReplayError(`invariant ${claim.property} holds in the final state`);
        return { ok: true, ...base, checkedSteps: steps.length, reason: `all ${steps.length - 1} transitions re-derived; ${claim.property} is false in the final state` };
      }
      case 'deadlock': {
        const en = insts.filter((x) => interp.enabled(x, final));
        if (en.length) throw new ReplayError(`final state is not deadlocked: ${en[0].label} is enabled`);
        if (interp.terminal(final)) throw new ReplayError('final state satisfies the terminal condition (intended termination, not deadlock)');
        return { ok: true, ...base, checkedSteps: steps.length, reason: 'final state has no enabled action and is not an intended terminal state' };
      }
      case 'domain': {
        const bw = claim.badWrite;
        if (!bw) throw new ReplayError('domain claim without the offending write');
        if (final.get(bw.variable) !== bw.value) throw new ReplayError('final state does not contain the claimed out-of-domain value');
        if (interp.inDomain(bw.variable, bw.value)) throw new ReplayError(`${bw.variable}=${bw.value} is inside its domain`);
        return { ok: true, ...base, checkedSteps: steps.length, reason: `${steps[steps.length - 1].action} writes ${bw.value} to ${bw.variable}, outside its declared domain` };
      }
      case 'liveness': {
        if (!prop || (prop.kind !== 'eventually' && prop.kind !== 'leadsto')) throw new ReplayError(`model has no liveness property '${claim.property}'`);
        const ls = claim.loopStart;
        if (ls === undefined || ls < 0 || ls >= states.length - 1) throw new ReplayError('lasso has no valid loop start');
        if (!same(final, states[ls])) throw new ReplayError('the last step does not return to the loop start');
        const goal = prop.kind === 'eventually' ? prop.expr : prop.target!;
        const q = states.map((s) => interp.ev(goal, s, null, new Map()) === true);
        let from: number;
        if (prop.kind === 'eventually') from = 0;
        else {
          // the latest P-state from which not-Q holds through the end of the lasso
          from = -1;
          for (let j = ls; j >= 0; j--) {
            if (q[j]) break;
            if (interp.ev(prop.expr, states[j], null, new Map()) === true) { from = j; }
          }
          if (from < 0) throw new ReplayError('no state satisfies the leadsto premise before the loop with the goal false since');
        }
        for (let j = from; j < states.length; j++) if (q[j]) { at = j; throw new ReplayError(`goal holds at step ${j}`); }
        // fairness on the loop (steps ls .. end): taken = some loop step of the constraint changes the state
        const loopStates = states.slice(ls, states.length - 1);
        const loopSteps = steps.slice(ls + 1);
        const fairOut: string[] = [];
        for (const f of ast.fairness) {
          const member = insts.filter((x) => x.proc === f.process && (!f.action || x.act.name === f.action));
          const memberLabels = new Set(member.map((x) => x.label));
          const taken = loopSteps.some((s, k) => !s.stutter && s.action !== null && memberLabels.has(s.action) && !same(states[ls + k], states[ls + k + 1]));
          const en = loopStates.map((s) => member.some((x) => interp.enabled(x, s) && !same(interp.apply(x, s).next, s)));
          const label = `${f.strength === 'weak' ? 'WF' : 'SF'}(${f.process}${f.action ? '.' + f.action : ''})`;
          if (taken) { fairOut.push(`${label} taken`); continue; }
          if (f.strength === 'weak' && en.every(Boolean)) throw new ReplayError(`loop violates ${label}: continuously enabled but never taken`);
          if (f.strength === 'strong' && en.some(Boolean)) throw new ReplayError(`loop violates ${label}: enabled infinitely often but never taken`);
          fairOut.push(`${label} ${f.strength === 'weak' ? 'disabled somewhere' : 'disabled everywhere'} on the loop`);
        }
        return {
          ok: true, ...base, checkedSteps: steps.length,
          reason: `lasso re-derived: goal false from step ${from} forever; loop of ${states.length - 1 - ls} step(s) is fair (${fairOut.join(', ') || 'no fairness declared'})`,
        };
      }
    }
  } catch (e) {
    if (e instanceof ReplayError) return { ok: false, ...base, checkedSteps: at, failedAt: at, reason: e.message };
    if (e instanceof Error && 'code' in e) return { ok: false, ...base, checkedSteps: 0, reason: `model does not parse: ${e.message}` };
    throw e;
  }
}
