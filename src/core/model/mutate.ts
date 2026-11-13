// Spec mutation testing: deliberately weaken a model (remove a guard, drop an assignment,
// negate a guard, weaken fairness) and check whether the declared properties notice.
// A mutant is KILLED when the checker reports a real violation; SURVIVED mutants show
// properties that are too weak (or mutations that are semantically harmless).
import type { ModelAst } from '../syntax/ast.ts';
import { parseModel } from '../syntax/parser.ts';
import { printModel } from '../syntax/print.ts';
import { compileSource } from './compile.ts';
import { check } from '../engine/check.ts';

export interface Mutant {
  id: string;
  operator: 'drop-guard' | 'negate-guard' | 'drop-assignment' | 'drop-fairness' | 'weaken-fairness';
  description: string;
  source: string;
}

export interface MutantResult extends Mutant {
  outcome: 'KILLED' | 'SURVIVED' | 'INVALID' | 'INCOMPLETE';
  killedBy?: string;
  witnessLength?: number;
  states?: number;
}

const clone = <T>(x: T): T => structuredClone(x);

export function generateMutants(source: string, limit = 60): Mutant[] {
  const ast = parseModel(source);
  const out: Mutant[] = [];
  const push = (operator: Mutant['operator'], description: string, mutate: (m: ModelAst) => void) => {
    if (out.length >= limit) return;
    const m = clone(ast);
    mutate(m);
    out.push({ id: `m${out.length + 1}`, operator, description, source: printModel(m) });
  };
  ast.processes.forEach((p, pi) => {
    p.actions.forEach((a, ai) => {
      const who = `${p.names.join('/')}.${a.name}`;
      if (a.guard) {
        push('drop-guard', `remove the guard of ${who} (it may fire in any state)`, (m) => { m.processes[pi].actions[ai].guard = null; });
        push('negate-guard', `negate the guard of ${who}`, (m) => {
          const g = m.processes[pi].actions[ai].guard!;
          m.processes[pi].actions[ai].guard = { kind: 'unary', op: 'not', arg: g, span: g.span };
        });
      }
      a.body.forEach((b, bi) => {
        if (a.body.length < 2) return; // dropping the only assignment just makes a stutter
        push('drop-assignment', `drop '${b.target} := …' from ${who}`, (m) => { m.processes[pi].actions[ai].body.splice(bi, 1); });
      });
    });
  });
  ast.fairness.forEach((f, fi) => {
    const label = `${f.strength} fairness on ${f.process}${f.action ? '.' + f.action : ''}`;
    push('drop-fairness', `remove ${label}`, (m) => { m.fairness.splice(fi, 1); });
    if (f.strength === 'strong') push('weaken-fairness', `weaken ${label} to weak`, (m) => { m.fairness[fi].strength = 'weak'; });
  });
  return out;
}

export function runMutants(source: string, opts: { maxStates?: number; limit?: number } = {}): { baseline: string; results: MutantResult[]; score: string } {
  const base = compileSource(source);
  if (!base.ok) throw new Error('baseline model does not compile');
  const baseRes = check(base.model!, { includeGraph: false, bounds: { maxStates: opts.maxStates ?? 50_000, timeLimitMs: 10_000 } }).result;
  const baseViolated = new Set(baseRes.properties.filter((p) => p.status === 'VIOLATED').map((p) => p.name));
  const results: MutantResult[] = generateMutants(source, opts.limit).map((mu) => {
    const c = compileSource(mu.source);
    if (!c.ok) return { ...mu, outcome: 'INVALID', killedBy: c.diagnostics[0]?.message };
    const { result } = check(c.model!, { includeGraph: false, bounds: { maxStates: opts.maxStates ?? 50_000, timeLimitMs: 10_000 } });
    // a mutant is killed by a property that the baseline does NOT already violate
    const kill = result.properties.find((p) => p.status === 'VIOLATED' && !baseViolated.has(p.name));
    if (kill) return { ...mu, outcome: 'KILLED', killedBy: kill.name, witnessLength: kill.trace?.length, states: result.stats.states };
    if (!result.complete) return { ...mu, outcome: 'INCOMPLETE', states: result.stats.states };
    return { ...mu, outcome: 'SURVIVED', states: result.stats.states };
  });
  const valid = results.filter((r) => r.outcome === 'KILLED' || r.outcome === 'SURVIVED');
  const killed = results.filter((r) => r.outcome === 'KILLED').length;
  return { baseline: baseRes.verdict, results, score: `${killed}/${valid.length} mutants killed` };
}
