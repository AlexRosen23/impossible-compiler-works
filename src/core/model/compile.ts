// Name resolution, type checking and instantiation: AST -> CompiledModel.
// Errors are collected as diagnostics; a model with any error does not compile.
import type { Expr, ModelAst, Span, TypeExpr, VarDecl } from '../syntax/ast.ts';
import { parseModel } from '../syntax/parser.ts';
import { DiagnosticError, type Diagnostic } from '../diagnostics.ts';
import type { ActionInfo, CompiledModel, FairnessInfo, IrExpr, VarInfo, VarType } from './ir.ts';

export const LIMITS = {
  maxVars: 64,
  maxRangeWidth: 1_000_000,
  maxActionInstances: 2_000,
  maxInitCombos: 100_000,
  maxProcesses: 16,
  maxEnumLiterals: 256,
  maxProperties: 64,
  maxIntMagnitude: 1_000_000_000,
};

const TLA_RESERVED = new Set([
  'ASSUME', 'ASSUMPTION', 'AXIOM', 'CASE', 'CHOOSE', 'CONSTANT', 'CONSTANTS', 'DOMAIN', 'ELSE', 'ENABLED',
  'EXCEPT', 'EXTENDS', 'IF', 'IN', 'INSTANCE', 'LET', 'LOCAL', 'MODULE', 'OTHER', 'SF_', 'SUBSET', 'THEN',
  'THEOREM', 'UNCHANGED', 'UNION', 'VARIABLE', 'VARIABLES', 'WF_', 'WITH', 'TRUE', 'FALSE', 'BOOLEAN',
  'Nat', 'Int', 'Init', 'Next', 'Spec', 'vars', 'TypeOK', 'Terminated', 'Seq', 'Len',
]);

export interface CompileResult {
  ok: boolean;
  model?: CompiledModel;
  diagnostics: Diagnostic[];
  ast?: ModelAst;
}

type ETy = { kind: 'int' } | { kind: 'bool' } | { kind: 'enum'; lits: Set<string> };

interface Scope {
  process: string | null; // process instance whose locals are visible unqualified
  params: Map<string, { value: number; ty: ETy }>;
}

/** Compile WML source. Never throws for user errors; returns diagnostics. */
export function compileSource(source: string): CompileResult {
  let ast: ModelAst;
  try {
    ast = parseModel(source);
  } catch (e) {
    if (e instanceof DiagnosticError) return { ok: false, diagnostics: [e.toDiagnostic()] };
    throw e;
  }
  return compileAst(ast, source);
}

export function compileAst(ast: ModelAst, source: string): CompileResult {
  const c = new Compiler(ast, source);
  try {
    c.run();
  } catch (e) {
    if (e instanceof DiagnosticError) c.diags.push(e.toDiagnostic());
    else throw e;
  }
  const errors = c.diags.filter((d) => d.severity === 'error');
  if (errors.length) return { ok: false, diagnostics: c.diags, ast };
  return { ok: true, model: c.result(), diagnostics: c.diags, ast };
}

class Compiler {
  diags: Diagnostic[] = [];
  private ast: ModelAst;
  private src: string;
  private literals: string[] = [];
  private litIndex = new Map<string, number>();
  private consts = new Map<string, { value: number; ty: ETy }>();
  private enumTypes = new Map<string, string[]>();
  private vars: VarInfo[] = [];
  private globalVars = new Map<string, number>();
  private localVars = new Map<string, Map<string, number>>(); // process -> local -> var index
  private processNames: string[] = [];
  private actions: ActionInfo[] = [];
  private processes: { name: string; actions: number[]; locals: number[] }[] = [];
  private terminal: IrExpr | null = null;
  private terminalText = '';
  private invariants: CompiledModel['invariants'] = [];
  private liveness: CompiledModel['liveness'] = [];
  private fairness: FairnessInfo[] = [];
  private names = new Map<string, string>(); // global namespace: name -> what

  constructor(ast: ModelAst, src: string) {
    this.ast = ast;
    this.src = src;
  }

  private err(code: string, message: string, span?: Span): never {
    throw new DiagnosticError(code, message, span);
  }
  private soft(code: string, message: string, span?: Span): void {
    this.diags.push({ code, severity: 'error', message, span });
  }
  private warn(code: string, message: string, span?: Span): void {
    this.diags.push({ code, severity: 'warning', message, span });
  }
  private text(span: Span): string {
    return this.src.slice(span.offset, span.end).replace(/\s+/g, ' ').trim();
  }
  private lit(name: string): number {
    let i = this.litIndex.get(name);
    if (i === undefined) {
      i = this.literals.length;
      this.literals.push(name);
      this.litIndex.set(name, i);
    }
    return i;
  }
  private claim(name: string, what: string, span: Span): void {
    const prev = this.names.get(name);
    if (prev) this.err('E201', `'${name}' is already declared as ${prev}; names must be unique.`, span);
    if (what !== 'a process' && what !== 'a type' && this.litIndex.has(name)) this.err('E201', `'${name}' is already used as an enumeration literal; names must be unique.`, span);
    this.names.set(name, what);
  }

  run(): void {
    const a = this.ast;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(a.name)) this.err('E200', 'Model name must start with a letter.', a.span);

    // processes first (their names are values for `self`)
    for (const p of a.processes) {
      for (const n of p.names) {
        this.claim(n, 'a process', p.span);
        this.processNames.push(n);
      }
    }
    if (this.processNames.length > LIMITS.maxProcesses) this.err('E202', `At most ${LIMITS.maxProcesses} processes are supported.`, a.span);

    for (const k of a.consts) {
      this.claim(k.name, 'a constant', k.span);
      const ty = this.typeOf(k.value, { process: null, params: new Map() }, true);
      if (ty.kind === 'enum') this.err('E203', 'Constants must be integers or booleans.', k.span);
      const v = this.constEval(this.lower(k.value, { process: null, params: new Map() }), k.value.span);
      this.consts.set(k.name, { value: v, ty });
    }

    for (const t of a.types) {
      this.claim(t.name, 'a type', t.span);
      if (t.literals.length === 0) this.err('E204', `Enumeration '${t.name}' is empty.`, t.span);
      this.checkLiterals(t.literals, t.span);
      this.enumTypes.set(t.name, t.literals);
    }

    // global variables
    for (const v of a.vars) {
      this.claim(v.name, 'a variable', v.span);
      this.globalVars.set(v.name, this.declareVar(v, null, null));
    }

    // process locals: one VarInfo per instance
    a.processes.forEach((p, pi) => {
      const seen = new Set<string>();
      for (const l of p.locals) {
        if (seen.has(l.name)) this.err('E205', `Local variable '${l.name}' is declared twice in this process.`, l.span);
        seen.add(l.name);
        if (this.globalVars.has(l.name)) this.err('E206', `Local '${l.name}' would shadow the global variable of the same name; rename one of them.`, l.span);
        const prev = this.names.get(l.name);
        if (prev && prev !== 'a process-local variable') this.err('E206', `Local '${l.name}' clashes with ${prev} of the same name.`, l.span);
        this.names.set(l.name, 'a process-local variable');
      }
      for (const n of p.names) {
        const m = new Map<string, number>();
        const locals: number[] = [];
        for (const l of p.locals) {
          const idx = this.declareVar(l, n, `template${pi}.${l.name}`);
          m.set(l.name, idx);
          locals.push(idx);
        }
        this.localVars.set(n, m);
        this.processes.push({ name: n, actions: [], locals });
      }
    });
    if (this.vars.length > LIMITS.maxVars) this.err('E207', `At most ${LIMITS.maxVars} state variables are supported (found ${this.vars.length}).`, a.span);

    // actions (instantiated per process instance and per parameter combination)
    for (const p of a.processes) {
      const actionNames = new Set<string>();
      for (const act of p.actions) {
        if (actionNames.has(act.name)) this.err('E208', `Action '${act.name}' is declared twice in this process.`, act.span);
        actionNames.add(act.name);
        for (const pn of p.names) this.instantiateAction(pn, act);
      }
    }
    if (this.actions.length > LIMITS.maxActionInstances) this.err('E209', `Too many action instances (${this.actions.length} > ${LIMITS.maxActionInstances}); shrink parameter domains.`, a.span);
    if (this.actions.length === 0) this.warn('W201', 'The model declares no actions; only initial states exist.', a.span);

    const top: Scope = { process: null, params: new Map() };
    if (a.terminals.length) {
      const parts = a.terminals.map((t) => {
        this.expectTy(t, top, 'bool', 'A terminal condition must be boolean.');
        return this.lower(t, top);
      });
      this.terminal = parts.reduce((x, y) => ({ k: 'bin', op: 'or', a: x, b: y }));
      this.terminalText = a.terminals.map((t) => this.text(t.span)).join(' or ');
    }

    const propNames = new Set<string>();
    if (a.properties.length > LIMITS.maxProperties) this.err('E210', `At most ${LIMITS.maxProperties} properties.`, a.span);
    for (const pr of a.properties) {
      if (propNames.has(pr.name)) this.err('E211', `Property '${pr.name}' is declared twice.`, pr.span);
      propNames.add(pr.name);
      if (this.names.has(pr.name)) this.err('E212', `Property name '${pr.name}' clashes with ${this.names.get(pr.name)}.`, pr.span);
      this.expectTy(pr.expr, top, 'bool', `Property '${pr.name}' must be a boolean expression.`);
      if (pr.kind === 'invariant') {
        this.invariants.push({ name: pr.name, expr: this.lower(pr.expr, top), text: this.text(pr.expr.span), span: pr.span });
      } else if (pr.kind === 'eventually') {
        this.liveness.push({ name: pr.name, kind: 'eventually', p: null, q: this.lower(pr.expr, top), text: `eventually ${this.text(pr.expr.span)}`, span: pr.span });
      } else {
        const tgt = pr.target!;
        this.expectTy(tgt, top, 'bool', `Property '${pr.name}': the right side of leadsto must be boolean.`);
        this.liveness.push({
          name: pr.name, kind: 'leadsto', p: this.lower(pr.expr, top), q: this.lower(tgt, top),
          text: `${this.text(pr.expr.span)} leadsto ${this.text(tgt.span)}`, span: pr.span,
        });
      }
    }

    for (const f of a.fairness) {
      const proc = this.processes.find((p) => p.name === f.process);
      if (!proc) this.err('E213', `Fairness names unknown process '${f.process}'.`, f.span);
      let acts = proc.actions;
      if (f.action) {
        acts = proc.actions.filter((i) => this.actions[i].name === f.action);
        if (!acts.length) this.err('E214', `Process '${f.process}' has no action '${f.action}'.`, f.span);
      }
      const label = `${f.strength === 'weak' ? 'WF' : 'SF'}(${f.process}${f.action ? '.' + f.action : ''})`;
      if (this.fairness.some((x) => x.label === label)) this.warn('W202', `Duplicate fairness constraint ${label}.`, f.span);
      this.fairness.push({ strength: f.strength, process: f.process, action: f.action, label, actions: acts, span: f.span });
    }
    if (this.fairness.length && !this.liveness.length) {
      this.warn('W203', 'Fairness constraints only affect liveness properties; this model declares none.', this.fairness[0].span);
    }
    for (const n of this.literals) {
      if (TLA_RESERVED.has(n)) this.warn('W204', `Literal '${n}' is a TLA+ keyword; the TLA+ export quotes literals as strings, so this is only cosmetic.`);
    }
  }

  private checkLiterals(lits: string[], span: Span): void {
    if (lits.length > LIMITS.maxEnumLiterals) this.err('E215', `Enumerations may have at most ${LIMITS.maxEnumLiterals} literals.`, span);
    const seen = new Set<string>();
    for (const l of lits) {
      if (seen.has(l)) this.err('E216', `Literal '${l}' appears twice in one enumeration.`, span);
      seen.add(l);
      const what = this.names.get(l);
      if (what && what !== 'a process') this.err('E217', `Literal '${l}' clashes with ${what} of the same name.`, span);
      this.lit(l);
    }
  }

  private resolveType(t: TypeExpr, templateKey: string | null): VarType {
    switch (t.kind) {
      case 'bool':
        return { kind: 'bool' };
      case 'named': {
        const lits = this.enumTypes.get(t.name);
        if (!lits) this.err('E218', `Unknown type '${t.name}'. Declare it with \`type ${t.name} = {a, b}\` or use a range like 0..3.`, t.span);
        return { kind: 'enum', name: t.name, literals: lits };
      }
      case 'enum': {
        if (t.literals.length === 0) this.err('E204', 'Enumeration is empty.', t.span);
        this.checkLiterals(t.literals, t.span);
        return { kind: 'enum', name: templateKey ? `{${t.literals.join(',')}}` : `{${t.literals.join(',')}}`, literals: t.literals };
      }
      case 'range': {
        const s: Scope = { process: null, params: new Map() };
        this.expectTy(t.min, s, 'int', 'Range bounds must be integers.');
        this.expectTy(t.max, s, 'int', 'Range bounds must be integers.');
        const min = this.constEval(this.lower(t.min, s), t.min.span);
        const max = this.constEval(this.lower(t.max, s), t.max.span);
        if (min > max) this.err('E219', `Empty range ${min}..${max}.`, t.span);
        if (max - min + 1 > LIMITS.maxRangeWidth) this.err('E220', `Range ${min}..${max} has more than ${LIMITS.maxRangeWidth} values; domains must stay small and finite.`, t.span);
        if (Math.abs(min) > LIMITS.maxIntMagnitude || Math.abs(max) > LIMITS.maxIntMagnitude) this.err('E221', 'Range bounds must stay within ±1,000,000,000.', t.span);
        return { kind: 'int', min, max };
      }
    }
  }

  private domainOf(t: VarType): number[] {
    if (t.kind === 'bool') return [0, 1];
    if (t.kind === 'enum') return t.literals.map((l) => this.lit(l));
    const out: number[] = [];
    for (let v = t.min; v <= t.max; v++) out.push(v);
    return out;
  }

  private declareVar(v: VarDecl, process: string | null, templateKey: string | null): number {
    const type = this.resolveType(v.type, templateKey);
    const domain = this.domainOf(type);
    const index = this.vars.length;
    const name = process ? `${process}.${v.name}` : v.name;
    let init: number[];
    const scope: Scope = { process: null, params: new Map() };
    if (v.init.kind === 'value') {
      const ety = this.typeOf(v.init.expr, { ...scope, process }, true);
      this.assignable(type, ety, v.init.expr.span, `initial value of '${name}'`, v.init.expr, process);
      const val = this.constEval(this.lower(v.init.expr, { ...scope, process }), v.init.expr.span);
      if (!domain.includes(val)) this.err('E222', `Initial value ${this.show(type, val)} of '${name}' is outside its domain.`, v.init.expr.span);
      init = [val];
    } else {
      const st = this.resolveType(v.init.set, templateKey);
      const set = this.domainOf(st);
      if (st.kind !== type.kind) this.err('E223', `Initial set of '${name}' has the wrong type.`, v.init.set.span);
      for (const x of set) if (!domain.includes(x)) this.err('E222', `Initial value ${this.show(type, x)} of '${name}' is outside its domain.`, v.init.set.span);
      init = set;
    }
    this.vars.push({ index, name, process, local: v.name, type, domain, init, span: v.span });
    return index;
  }

  private show(t: VarType, v: number): string {
    if (t.kind === 'bool') return v ? 'true' : 'false';
    if (t.kind === 'enum') return this.literals[v] ?? `#${v}`;
    return String(v);
  }

  private instantiateAction(proc: string, act: import('../syntax/ast.ts').ActionDecl): void {
    // parameter domains
    const pdoms: { name: string; ty: ETy; vals: { value: number; display: string }[] }[] = [];
    const seen = new Set<string>();
    for (const p of act.params) {
      if (seen.has(p.name)) this.err('E224', `Parameter '${p.name}' is declared twice.`, p.span);
      seen.add(p.name);
      if (this.localVars.get(proc)!.has(p.name) || this.globalVars.has(p.name) || this.consts.has(p.name)) {
        this.err('E225', `Parameter '${p.name}' shadows a variable or constant; rename it.`, p.span);
      }
      const t = this.resolveType(p.domain, null);
      const vals = this.domainOf(t).map((value) => ({ value, display: this.show(t, value) }));
      const ty: ETy = t.kind === 'enum' ? { kind: 'enum', lits: new Set(t.literals) } : { kind: t.kind };
      pdoms.push({ name: p.name, ty, vals });
    }
    let combos: { name: string; value: number; display: string; ty: ETy }[][] = [[]];
    for (const d of pdoms) {
      const nextCombos: typeof combos = [];
      for (const c of combos) for (const v of d.vals) nextCombos.push([...c, { name: d.name, value: v.value, display: v.display, ty: d.ty }]);
      combos = nextCombos;
      if (combos.length > LIMITS.maxActionInstances) this.err('E209', `Action '${act.name}' has too many parameter combinations.`, act.span);
    }
    const procEntry = this.processes.find((p) => p.name === proc)!;
    for (const combo of combos) {
      const params = new Map(combo.map((c) => [c.name, { value: c.value, ty: c.ty }]));
      const scope: Scope = { process: proc, params };
      let guard: IrExpr | null = null;
      if (act.guard) {
        this.expectTy(act.guard, scope, 'bool', `The guard of '${proc}.${act.name}' must be boolean.`);
        guard = this.lower(act.guard, scope);
      }
      const targets = new Set<number>();
      const assigns: ActionInfo['assigns'] = [];
      for (const as of act.body) {
        let vi: number | undefined;
        if (as.targetProcess) {
          const m = this.localVars.get(as.targetProcess);
          if (!m) this.err('E226', `Unknown process '${as.targetProcess}' in assignment target.`, as.span);
          vi = m.get(as.target);
          if (vi === undefined) this.err('E227', `Process '${as.targetProcess}' has no local variable '${as.target}'.`, as.span);
        } else {
          vi = this.localVars.get(proc)!.get(as.target) ?? this.globalVars.get(as.target);
          if (vi === undefined) {
            if (params.has(as.target)) this.err('E228', `Cannot assign to parameter '${as.target}'.`, as.span);
            if (this.consts.has(as.target)) this.err('E228', `Cannot assign to constant '${as.target}'.`, as.span);
            this.err('E229', `Unknown variable '${as.target}' in assignment.`, as.span);
          }
        }
        if (targets.has(vi)) this.err('E230', `'${this.vars[vi].name}' is assigned twice in one action; each variable may be assigned at most once per step.`, as.span);
        targets.add(vi);
        const ety = this.typeOf(as.value, scope, false);
        this.assignable(this.vars[vi].type, ety, as.value.span, `assignment to '${this.vars[vi].name}'`, as.value, proc);
        assigns.push({ v: vi, e: this.lower(as.value, scope), text: `${this.vars[vi].name} := ${this.text(as.value.span)}` });
      }
      if (act.body.length === 0) this.warn('W205', `Action '${proc}.${act.name}' assigns nothing: every step it takes is a stutter (state unchanged).`, act.span);
      const label = combo.length ? `${proc}.${act.name}(${combo.map((c) => `${c.name}=${c.display}`).join(',')})` : `${proc}.${act.name}`;
      const index = this.actions.length;
      this.actions.push({
        index, process: proc, name: act.name, family: `${proc}.${act.name}`, label, params: combo.map((c) => ({ name: c.name, value: c.value, display: c.display })),
        guard, guardText: act.guard ? this.text(act.guard.span) : 'true', assigns, span: act.span,
      });
      procEntry.actions.push(index);
    }
  }

  // ---- typing ---------------------------------------------------------------------------
  private assignable(target: VarType, ety: ETy, span: Span, what: string, _e: Expr, _proc: string | null): void {
    if (target.kind === 'int' && ety.kind === 'int') return;
    if (target.kind === 'bool' && ety.kind === 'bool') return;
    if (target.kind === 'enum' && ety.kind === 'enum') {
      for (const l of ety.lits) {
        if (!target.literals.includes(l)) this.err('E231', `In ${what}: '${l}' is not a value of type ${target.name} ({${target.literals.join(', ')}}).`, span);
      }
      return;
    }
    this.err('E232', `In ${what}: expected ${target.kind === 'enum' ? `a value of ${target.name}` : target.kind} but the expression is ${ety.kind}.`, span);
  }

  private expectTy(e: Expr, s: Scope, kind: 'int' | 'bool', msg: string): void {
    const t = this.typeOf(e, s, false);
    if (t.kind !== kind) this.err('E233', `${msg} (found ${t.kind}).`, e.span);
  }

  private lookup(name: string, s: Scope, span: Span, constOnly: boolean):
    | { kind: 'var'; i: number; ty: ETy }
    | { kind: 'const'; value: number; ty: ETy } {
    if (!constOnly) {
      if (s.process) {
        const li = this.localVars.get(s.process)?.get(name);
        if (li !== undefined) return { kind: 'var', i: li, ty: this.ety(this.vars[li].type) };
      }
      const p = s.params.get(name);
      if (p) return { kind: 'const', value: p.value, ty: p.ty };
      const g = this.globalVars.get(name);
      if (g !== undefined) return { kind: 'var', i: g, ty: this.ety(this.vars[g].type) };
    }
    const k = this.consts.get(name);
    if (k) return { kind: 'const', value: k.value, ty: k.ty };
    if (this.litIndex.has(name) || this.processNames.includes(name)) {
      return { kind: 'const', value: this.lit(name), ty: { kind: 'enum', lits: new Set([name]) } };
    }
    if (constOnly && (this.globalVars.has(name) || [...this.localVars.values()].some((m) => m.has(name)))) {
      this.err('E234', `'${name}' is a state variable; only constants and literals are allowed here.`, span);
    }
    if (!s.process && [...this.localVars.values()].some((m) => m.has(name))) {
      this.err('E235', `'${name}' is a process-local variable; qualify it with the process name (e.g. ${this.processNames[0] ?? 'P'}.${name}).`, span);
    }
    this.err('E236', `Unknown name '${name}'.`, span);
  }

  private ety(t: VarType): ETy {
    if (t.kind === 'enum') return { kind: 'enum', lits: new Set(t.literals) };
    return { kind: t.kind };
  }

  private typeOf(e: Expr, s: Scope, constOnly: boolean): ETy {
    switch (e.kind) {
      case 'int': return { kind: 'int' };
      case 'bool': return { kind: 'bool' };
      case 'self':
        if (!s.process) this.err('E237', '`self` is only meaningful inside a process.', e.span);
        this.lit(s.process);
        return { kind: 'enum', lits: new Set([s.process]) };
      case 'name': return this.lookup(e.name, s, e.span, constOnly).ty;
      case 'qualified': {
        if (constOnly) this.err('E234', 'State variables are not allowed here.', e.span);
        const m = this.localVars.get(e.process);
        if (!m) this.err('E238', `Unknown process '${e.process}'.`, e.span);
        const i = m.get(e.name);
        if (i === undefined) this.err('E239', `Process '${e.process}' has no local variable '${e.name}'.`, e.span);
        return this.ety(this.vars[i].type);
      }
      case 'unary': {
        const t = this.typeOf(e.arg, s, constOnly);
        if (e.op === 'not' && t.kind !== 'bool') this.err('E240', '`not` needs a boolean operand.', e.span);
        if (e.op === 'neg' && t.kind !== 'int') this.err('E240', 'Unary minus needs an integer operand.', e.span);
        return t;
      }
      case 'binary': {
        const l = this.typeOf(e.left, s, constOnly);
        const r = this.typeOf(e.right, s, constOnly);
        switch (e.op) {
          case 'and': case 'or': case 'implies':
            if (l.kind !== 'bool' || r.kind !== 'bool') this.err('E241', `'${e.op === 'implies' ? '=>' : e.op}' needs boolean operands (found ${l.kind} and ${r.kind}).`, e.span);
            return { kind: 'bool' };
          case '+': case '-': case '*': case '%':
            if (l.kind !== 'int' || r.kind !== 'int') this.err('E242', `'${e.op}' needs integer operands (found ${l.kind} and ${r.kind}).`, e.span);
            return { kind: 'int' };
          case '<': case '<=': case '>': case '>=':
            if (l.kind !== 'int' || r.kind !== 'int') this.err('E243', `'${e.op}' compares integers only (found ${l.kind} and ${r.kind}).`, e.span);
            return { kind: 'bool' };
          case '=': case '!=':
            if (l.kind !== r.kind) this.err('E244', `Cannot compare ${l.kind} with ${r.kind}.`, e.span);
            if (l.kind === 'enum' && r.kind === 'enum' && ![...l.lits].some((x) => r.lits.has(x))) {
              this.err('E245', `These values can never be equal: {${[...l.lits].join(', ')}} vs {${[...r.lits].join(', ')}}. Is a literal misspelled?`, e.span);
            }
            return { kind: 'bool' };
        }
        return { kind: 'bool' };
      }
      case 'ite': {
        const c = this.typeOf(e.cond, s, constOnly);
        if (c.kind !== 'bool') this.err('E246', 'An if-condition must be boolean.', e.cond.span);
        const a = this.typeOf(e.then, s, constOnly);
        const b = this.typeOf(e.else, s, constOnly);
        if (a.kind !== b.kind) this.err('E247', `Both branches of if-then-else must have the same type (found ${a.kind} and ${b.kind}).`, e.span);
        if (a.kind === 'enum' && b.kind === 'enum') return { kind: 'enum', lits: new Set([...a.lits, ...b.lits]) };
        return a;
      }
    }
  }

  private lower(e: Expr, s: Scope): IrExpr {
    switch (e.kind) {
      case 'int': return { k: 'const', v: e.value, t: 'int' };
      case 'bool': return { k: 'const', v: e.value ? 1 : 0, t: 'bool' };
      case 'self': return { k: 'const', v: this.lit(s.process!), t: 'enum' };
      case 'name': {
        const r = this.lookup(e.name, s, e.span, false);
        return r.kind === 'var' ? { k: 'var', i: r.i } : { k: 'const', v: r.value, t: r.ty.kind };
      }
      case 'qualified': return { k: 'var', i: this.localVars.get(e.process)!.get(e.name)! };
      case 'unary': return { k: 'un', op: e.op, a: this.lower(e.arg, s) };
      case 'binary': return { k: 'bin', op: e.op, a: this.lower(e.left, s), b: this.lower(e.right, s) };
      case 'ite': return { k: 'ite', c: this.lower(e.cond, s), t: this.lower(e.then, s), e: this.lower(e.else, s) };
    }
  }

  private constEval(e: IrExpr, span: Span): number {
    const go = (x: IrExpr): number => {
      switch (x.k) {
        case 'const': return x.v;
        case 'var': this.err('E234', 'State variables are not allowed in a constant expression.', span);
        case 'un': return x.op === 'not' ? (go(x.a) ? 0 : 1) : -go(x.a);
        case 'ite': return go(x.c) ? go(x.t) : go(x.e);
        case 'bin': {
          const a = go(x.a), b = go(x.b);
          switch (x.op) {
            case 'and': return a && b ? 1 : 0;
            case 'or': return a || b ? 1 : 0;
            case 'implies': return !a || b ? 1 : 0;
            case '=': return a === b ? 1 : 0;
            case '!=': return a !== b ? 1 : 0;
            case '<': return a < b ? 1 : 0;
            case '<=': return a <= b ? 1 : 0;
            case '>': return a > b ? 1 : 0;
            case '>=': return a >= b ? 1 : 0;
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '%':
              if (b <= 0) this.err('E248', 'Modulo needs a positive right operand.', span);
              return ((a % b) + b) % b;
          }
        }
      }
    };
    const v = go(e);
    if (Math.abs(v) > LIMITS.maxIntMagnitude) this.err('E221', 'Constant is out of range (±1,000,000,000).', span);
    return v;
  }

  result(): CompiledModel {
    let space = 1;
    for (const v of this.vars) space *= v.domain.length;
    return {
      name: this.ast.name,
      title: this.ast.title,
      description: this.ast.description,
      literals: this.literals,
      vars: this.vars,
      processes: this.processes,
      actions: this.actions,
      terminal: this.terminal,
      terminalText: this.terminalText,
      invariants: this.invariants,
      liveness: this.liveness,
      fairness: this.fairness,
      declaredStateSpace: space,
      ast: this.ast,
    };
  }
}
