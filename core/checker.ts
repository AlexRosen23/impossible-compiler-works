// FOLIO static semantics: name resolution (lexical scopes), type checking, definite-return and reachability
// analysis, call-graph recursion check and scene options. Produces side tables keyed by AST node id and a
// type-derivation trace the Type Observatory renders. Parsing and checking are separate stages: a program can
// parse and still fail here.
import type * as A from './ast.ts';
import { children, typeNodeText } from './ast.ts';
import { BUILTINS, CONSTANTS } from './builtins.ts';
import type { Diagnostic, Span } from './diagnostics.ts';
import { NO_SPAN } from './diagnostics.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { GROUP_SIG, PRIMITIVES, type PrimSig } from './primitives.ts';

/** Types are canonical strings: Number, Boolean, String, Color, Point, List<T>; plus Void and Error (poison). */
export type Type = string;
export const ERR = 'Error';

export type SymbolKind = 'let' | 'var' | 'param' | 'loop' | 'fn' | 'data' | 'const' | 'scene-input';
export interface SymbolInfo {
  id: number;
  name: string;
  kind: SymbolKind;
  type: Type;
  declSpan: Span;
  scopeId: number;
  /** AST node id of the declaration (Let, Param, Repeat, FnDecl, DataDecl), -1 for predeclared names. */
  declNode: number;
  uses: Span[];
}
export interface ScopeInfo { id: number; parent: number | null; kind: 'global' | 'fn' | 'scene' | 'block' | 'loop'; span: Span; symbols: number[]; label: string }
export interface FnSig { name: string; params: Type[]; paramNames: string[]; ret: Type; node: number }
export interface TraceEntry { node: number; span: Span; type: Type; rule: string }
export interface SceneInfo { title: string; width: number; height: number; frames: number; background: string }

export interface CheckResult {
  diagnostics: Diagnostic[];
  types: Map<number, Type>;
  /** Name/Assign/Call node id → symbol id. */
  resolutions: Map<number, number>;
  symbols: SymbolInfo[];
  scopes: ScopeInfo[];
  fns: Map<string, FnSig>;
  data: { name: string; type: Type; fixture: string; node: number }[];
  callGraph: Record<string, string[]>;
  trace: TraceEntry[];
  scene: SceneInfo | null;
}

const RESERVED = new Set([...Object.keys(BUILTINS), ...Object.keys(PRIMITIVES), ...Object.keys(CONSTANTS), 'WIDTH', 'HEIGHT', 'time', 'frame']);
const EQ_TYPES = new Set(['Number', 'Boolean', 'String', 'Color']);

export function typeOfNode(t: A.TypeNode): Type { return typeNodeText(t); }
export function listElem(t: Type): Type | null { const m = /^List<(.*)>$/.exec(t); return m ? m[1] : null; }

export function check(program: A.Program, limits: Limits = DEFAULT_LIMITS): CheckResult {
  return new Checker(limits).run(program);
}

class Checker {
  diagnostics: Diagnostic[] = [];
  types = new Map<number, Type>();
  resolutions = new Map<number, number>();
  symbols: SymbolInfo[] = [];
  scopes: ScopeInfo[] = [];
  fns = new Map<string, FnSig>();
  data: CheckResult['data'] = [];
  callGraph: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  sceneCalls: string[] = [];
  trace: TraceEntry[] = [];
  scene: SceneInfo | null = null;
  /** Lexical scope chain: each map name → symbol id. */
  chain: { scope: number; names: Map<string, number> }[] = [];
  currentFn: FnSig | null = null;
  inScene = false;
  reads = new Set<number>();
  private limits: Limits;
  constructor(limits: Limits) { this.limits = limits; }

  /** Diagnostics stop at maxErrors (one more says how many were dropped), so output stays proportional to the limit. */
  private dropped = new Set<string>();
  private push(d: Diagnostic) {
    if (this.diagnostics.length < this.limits.maxErrors) { this.diagnostics.push(d); return; }
    // A dropped error must still fail the compile, so each severity gets its own marker.
    if (this.dropped.has(d.severity)) return;
    this.dropped.add(d.severity);
    this.diagnostics.push({ code: 'S006', severity: d.severity, message: `more than ${this.limits.maxErrors} diagnostics; the rest are not shown`, span: d.span, stage: 'check' });
  }
  err(code: string, message: string, span: Span, hint?: string) { this.push({ code, severity: 'error', message, span, hint, stage: 'check' }); }
  warn(code: string, message: string, span: Span, hint?: string) { this.push({ code, severity: 'warning', message, span, hint, stage: 'check' }); }

  pushScope(kind: ScopeInfo['kind'], span: Span, label: string): number {
    const id = this.scopes.length;
    this.scopes.push({ id, parent: this.chain.length ? this.chain[this.chain.length - 1].scope : null, kind, span, symbols: [], label });
    this.chain.push({ scope: id, names: new Map() });
    return id;
  }
  popScope() {
    const s = this.chain.pop()!;
    for (const id of s.names.values()) {
      const sym = this.symbols[id];
      if ((sym.kind === 'let' || sym.kind === 'var') && !this.reads.has(id) && !sym.name.startsWith('_')) {
        this.warn('W003', `"${sym.name}" is never used`, sym.declSpan, 'prefix the name with _ to silence this');
      }
    }
  }
  declare(name: string, kind: SymbolKind, type: Type, span: Span, declNode: number): number {
    const top = this.chain[this.chain.length - 1];
    if (RESERVED.has(name) && kind !== 'const' && kind !== 'scene-input') {
      this.err('C017', `"${name}" is a built-in name and cannot be redeclared`, span);
    }
    if (top.names.has(name)) {
      this.err('C007', `"${name}" is already declared in this scope`, span, `first declared at line ${this.symbols[top.names.get(name)!].declSpan.line}`);
    } else if (kind !== 'const' && kind !== 'scene-input' && kind !== 'fn' && kind !== 'data' && this.lookup(name) !== null) {
      const outer = this.symbols[this.lookup(name)!];
      if (outer.kind !== 'fn' && outer.kind !== 'data' && outer.kind !== 'const') {
        this.warn('W001', `"${name}" shadows the ${outer.kind} declared at line ${outer.declSpan.line}`, span);
      }
    }
    const id = this.symbols.length;
    if (id >= this.limits.maxSymbols) {
      if (id === this.limits.maxSymbols) this.err('S003', `more than ${this.limits.maxSymbols} symbols`, span);
    }
    this.symbols.push({ id, name, kind, type, declSpan: span, scopeId: top.scope, declNode, uses: [] });
    this.scopes[top.scope].symbols.push(id);
    if (!top.names.has(name)) top.names.set(name, id);
    return id;
  }
  lookup(name: string): number | null {
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const s = this.chain[i].names.get(name);
      if (s !== undefined) return s;
    }
    return null;
  }
  private suggestions = 0;
  suggest(name: string): string | undefined {
    // Edit distance against every name in scope is the costliest diagnostic; a pathological program gets a few.
    if (++this.suggestions > 20 || name.length > 64) return undefined;
    const candidates = new Set<string>();
    for (const c of this.chain) for (const n of c.names.keys()) candidates.add(n);
    for (const n of Object.keys(BUILTINS)) candidates.add(n);
    let best: string | undefined, bestD = 3;
    for (const c of candidates) { const d = editDistance(name, c); if (d < bestD) { bestD = d; best = c; } }
    return best ? `did you mean "${best}"?` : undefined;
  }

  run(p: A.Program): CheckResult {
    this.pushScope('global', p.span, 'global');
    for (const [n, c] of Object.entries(CONSTANTS)) this.declare(n, 'const', c.type, NO_SPAN, -1);
    // Pass 1: collect fn and data signatures so declaration order does not matter.
    for (const item of p.items) {
      if (item.kind === 'FnDecl') {
        if (this.fns.has(item.name) || this.data.some((d) => d.name === item.name)) { this.err('C020', `"${item.name}" is declared twice`, item.nameSpan); continue; }
        const sig: FnSig = { name: item.name, params: item.params.map((x) => this.resolveType(x.type)), paramNames: item.params.map((x) => x.name), ret: this.resolveType(item.ret), node: item.id };
        this.fns.set(item.name, sig);
        this.callGraph[item.name] = [];
        this.declare(item.name, 'fn', `fn(${sig.params.join(', ')}) -> ${sig.ret}`, item.nameSpan, item.id);
      } else if (item.kind === 'DataDecl') {
        if (this.fns.has(item.name) || this.data.some((d) => d.name === item.name)) { this.err('C020', `"${item.name}" is declared twice`, item.nameSpan); continue; }
        const t = this.resolveType(item.type);
        if (listElem(t) === null && t !== ERR) this.err('C002', `datasets must be lists, found ${t}`, item.type.span, 'declare it as List<Number>, List<Point>, List<String> or List<Color>');
        this.data.push({ name: item.name, type: t, fixture: item.fixture, node: item.id });
        const sid = this.declare(item.name, 'data', t, item.nameSpan, item.id);
        this.reads.add(sid);
      }
    }
    // Pass 2: bodies.
    for (const item of p.items) {
      if (item.kind === 'FnDecl' && this.fns.get(item.name)?.node === item.id) this.fnBody(item);
      else if (item.kind === 'SceneDecl' && !this.scene) this.sceneBody(item);
    }
    if (this.checkRecursion(p)) { this.checkCallDepth(p); this.checkNestingWeight(p); }
    this.popScope();
    return {
      diagnostics: this.diagnostics, types: this.types, resolutions: this.resolutions, symbols: this.symbols, scopes: this.scopes,
      fns: this.fns, data: this.data, callGraph: this.callGraph, trace: this.trace, scene: this.scene,
    };
  }

  resolveType(t: A.TypeNode): Type {
    if (t.name === 'List') {
      if (!t.elem) return ERR;
      if (t.elem.name === 'List') { this.err('C015', 'lists of lists are not supported in FOLIO 0.1', t.span); return ERR; }
      return `List<${t.elem.name}>`;
    }
    return t.name;
  }

  fnBody(f: A.FnDecl) {
    const sig = this.fns.get(f.name)!;
    this.currentFn = sig;
    this.pushScope('fn', f.span, `fn ${f.name}`);
    f.params.forEach((p, i) => { const id = this.declare(p.name, 'param', sig.params[i], p.span, p.id); this.reads.add(id); });
    const returns = this.block(f.body, false);
    if (!returns && sig.ret !== ERR) this.err('C009', `"${f.name}" can reach the end of its body without returning a ${sig.ret}`, f.body.span, 'make sure every path ends in `return`');
    this.popScope();
    this.currentFn = null;
  }

  sceneBody(s: A.SceneDecl) {
    let width = 800, height = 480, frames = 1, background = '#101013';
    const seen = new Set<string>();
    for (const o of s.options) {
      if (seen.has(o.name)) this.err('C019', `scene option "${o.name}" given twice`, o.span);
      seen.add(o.name);
      if (o.name === 'size') {
        const [w, h] = o.values as number[];
        const okDim = (v: number) => Number.isInteger(v) && v >= 1 && v <= this.limits.maxCanvas;
        if (!okDim(w) || !okDim(h)) this.err('C019', `canvas size must be whole numbers from 1 to ${this.limits.maxCanvas}`, o.span);
        else { width = w; height = h; }
      } else if (o.name === 'frames') {
        const f = o.values[0] as number;
        if (!Number.isInteger(f) || f < 1 || f > this.limits.maxFrames) this.err('C019', `frames must be a whole number from 1 to ${this.limits.maxFrames}`, o.span);
        else frames = f;
      } else background = o.values[0] as string;
    }
    this.scene = { title: s.title, width, height, frames, background };
    this.inScene = true;
    this.pushScope('scene', s.span, `scene "${s.title}"`);
    for (const [n, t] of [['WIDTH', 'Number'], ['HEIGHT', 'Number'], ['time', 'Number'], ['frame', 'Number']]) this.declare(n, 'scene-input', t, NO_SPAN, -1);
    this.block(s.body, false);
    this.popScope();
    this.inScene = false;
  }

  /** Checks a block; returns true when every path through it ends in `return`. */
  block(b: A.Block, newScope = true, label = 'block'): boolean {
    if (newScope) this.pushScope('block', b.span, label);
    let returns = false;
    let warned = false;
    for (const s of b.stmts) {
      if (returns && !warned) { this.warn('W002', 'this statement can never run: every path above it returns', s.span); warned = true; }
      if (this.stmt(s)) returns = true;
    }
    if (newScope) this.popScope();
    return returns;
  }

  stmt(s: A.Stmt): boolean {
    switch (s.kind) {
      case 'Let': {
        const declared = s.type ? this.resolveType(s.type) : null;
        const t = this.expr(s.init, declared);
        if (declared && t !== ERR && declared !== ERR && t !== declared) {
          this.err('C002', `"${s.name}" is declared ${declared} but its value is ${t}`, s.init.span);
        }
        const id = this.declare(s.name, s.mutable ? 'var' : 'let', declared ?? t, s.nameSpan, s.id);
        this.resolutions.set(s.id, id);
        return false;
      }
      case 'Assign': {
        const id = this.lookup(s.name);
        const t = this.expr(s.value, id !== null ? this.symbols[id].type : null);
        if (id === null) { this.err('C001', `"${s.name}" is not declared`, s.nameSpan, this.suggest(s.name)); return false; }
        const sym = this.symbols[id];
        this.resolutions.set(s.id, id);
        sym.uses.push(s.nameSpan);
        if (sym.kind !== 'var') {
          this.err('C006', `"${s.name}" is ${sym.kind === 'let' ? 'an immutable let binding' : `a ${sym.kind}`} and cannot be assigned`, s.nameSpan, sym.kind === 'let' ? 'declare it with `var` to allow assignment' : undefined);
        } else if (t !== ERR && sym.type !== ERR && t !== sym.type) {
          this.err('C002', `cannot assign ${t} to "${s.name}", which is ${sym.type}`, s.value.span);
        }
        return false;
      }
      case 'If': {
        this.expectType(s.cond, 'Boolean', 'an if condition');
        const a = this.block(s.then, true, 'if');
        if (!s.else) return false;
        const b = s.else.kind === 'If' ? this.stmt(s.else) : this.block(s.else, true, 'else');
        return a && b;
      }
      case 'Repeat': {
        let elemType: Type = 'Number';
        if (s.iterable) {
          const t = this.expr(s.iterable, null);
          const e = listElem(t);
          if (t !== ERR && e === null) this.err('C002', `repeat over a range (a..b) or a List, found ${t}`, s.iterable.span);
          elemType = e ?? ERR;
        } else {
          this.expectType(s.from!, 'Number', 'a range start');
          this.expectType(s.to!, 'Number', 'a range end');
        }
        this.pushScope('loop', s.span, `repeat ${s.name}`);
        const id = this.declare(s.name, 'loop', elemType, s.nameSpan, s.id);
        this.reads.add(id);
        this.block(s.body, false);
        this.popScope();
        return false;
      }
      case 'Return': {
        if (!this.currentFn) { this.err('C010', '`return` is only allowed inside a function', s.span); this.expr(s.value, null); return true; }
        this.expectType(s.value, this.currentFn.ret, `the return value of "${this.currentFn.name}"`);
        return true;
      }
      case 'Assert':
        this.expectType(s.cond, 'Boolean', 'an assertion');
        return false;
      case 'Draw': {
        if (!(s.prim in PRIMITIVES)) {
          const hint = s.prim in BUILTINS || this.fns.has(s.prim) ? `"${s.prim}" returns a value; use it inside an expression, e.g. let v = ${s.prim}(…);` : this.suggest(s.prim);
          this.err('C008', `"${s.prim}" is not a drawing primitive (circle, rect, line, path, text)`, s.primSpan, hint);
          for (const a of s.args) this.expr(a.value, null);
          return false;
        }
        if (this.currentFn) this.err('C011', `functions are pure: "${s.prim}" can only be drawn in the scene`, s.primSpan, 'return the numbers you need and draw in the scene body');
        this.namedArgs(s.prim, PRIMITIVES[s.prim], s.args, s.primSpan);
        return false;
      }
      case 'Group': {
        if (this.currentFn) this.err('C011', 'functions are pure: `group` can only be used in the scene', s.span);
        this.namedArgs('group', GROUP_SIG, s.args, s.span);
        this.block(s.body, true, 'group');
        return false;
      }
    }
  }

  namedArgs(what: string, sig: PrimSig, args: A.NamedArg[], at: Span) {
    const seen = new Set<string>();
    for (const a of args) {
      const p = sig.params.find((x) => x.name === a.name);
      if (!p) {
        this.err('C004', `${what} has no argument "${a.name}"`, a.nameSpan, `it takes ${sig.params.map((x) => x.name).join(', ')}`);
        this.expr(a.value, null);
        continue;
      }
      if (seen.has(a.name)) this.err('C004', `argument "${a.name}" given twice`, a.nameSpan);
      seen.add(a.name);
      this.expectType(a.value, p.type, `${what}'s ${a.name}`);
    }
    for (const p of sig.params) {
      if (p.default === undefined && !seen.has(p.name)) this.err('C005', `${what} needs "${p.name}: ${p.type}"`, at, sig.doc);
    }
  }

  expectType(e: A.Expr, want: Type, what: string): Type {
    const t = this.expr(e, want);
    if (t !== ERR && want !== ERR && t !== want) this.err('C002', `${what} must be ${want}, found ${t}`, e.span);
    return t;
  }

  record(e: A.Expr, t: Type, rule: string): Type {
    this.types.set(e.id, t);
    this.trace.push({ node: e.id, span: e.span, type: t, rule });
    return t;
  }

  expr(e: A.Expr, expected: Type | null): Type {
    switch (e.kind) {
      case 'Num': return this.record(e, 'Number', 'number literal');
      case 'Str': return this.record(e, 'String', 'string literal');
      case 'Color': return this.record(e, 'Color', 'colour literal');
      case 'Bool': return this.record(e, 'Boolean', 'boolean literal');
      case 'Name': {
        const id = this.lookup(e.name);
        if (id === null) {
          const inFnHint = this.currentFn && ['time', 'frame', 'WIDTH', 'HEIGHT'].includes(e.name) ? `functions cannot see scene inputs; pass ${e.name} as a parameter` : this.suggest(e.name);
          this.err('C001', `"${e.name}" is not declared`, e.span, inFnHint);
          return this.record(e, ERR, 'undeclared');
        }
        const sym = this.symbols[id];
        if (sym.kind === 'fn') { this.err('C014', `"${e.name}" is a function; call it with (…)`, e.span); return this.record(e, ERR, 'function used as value'); }
        this.resolutions.set(e.id, id);
        sym.uses.push(e.span);
        this.reads.add(id);
        return this.record(e, sym.type, `${sym.kind} "${sym.name}" declared at ${sym.declNode < 0 ? 'built-in' : `line ${sym.declSpan.line}`}`);
      }
      case 'Unary': {
        const want = e.op === '-' ? 'Number' : 'Boolean';
        const t = this.expr(e.operand, want);
        if (t !== ERR && t !== want) { this.err('C014', `"${e.op}" needs ${want}, found ${t}`, e.span); return this.record(e, ERR, `${e.op} ${t}: invalid`); }
        return this.record(e, t === ERR ? ERR : want, `${e.op} ${want} → ${want}`);
      }
      case 'Binary': return this.binary(e);
      case 'Call': return this.call(e);
      case 'Index': {
        const t = this.expr(e.target, null);
        this.expectType(e.index, 'Number', 'a list index');
        const el = listElem(t);
        if (t !== ERR && el === null) { this.err('C014', `only lists can be indexed, found ${t}`, e.target.span); return this.record(e, ERR, 'index of non-list'); }
        return this.record(e, el ?? ERR, `${t}[Number] → ${el ?? ERR}`);
      }
      case 'Field': {
        const t = this.expr(e.target, null);
        const fields: Record<string, string[]> = { Point: ['x', 'y'], Color: ['r', 'g', 'b', 'a'] };
        if (t === ERR) return this.record(e, ERR, 'field of error');
        if (!fields[t]?.includes(e.field)) {
          this.err('C018', `${t} has no field "${e.field}"`, e.fieldSpan, fields[t] ? `${t} fields: ${fields[t].join(', ')}` : `${t} has no fields`);
          return this.record(e, ERR, 'unknown field');
        }
        return this.record(e, 'Number', `${t}.${e.field} → Number`);
      }
      case 'List': {
        if (e.items.length > this.limits.maxListLiteral) this.err('C016', `list literal has ${e.items.length} items; the limit is ${this.limits.maxListLiteral}`, e.span);
        const expEl = expected ? listElem(expected) : null;
        if (e.items.length === 0) {
          if (!expEl) { this.err('C013', 'an empty list needs a declared type', e.span, 'write `let xs: List<Number> = [];`'); return this.record(e, ERR, 'empty list without type'); }
          return this.record(e, `List<${expEl}>`, `[] with declared element ${expEl}`);
        }
        const first = this.expr(e.items[0], expEl);
        if (listElem(first)) { this.err('C015', 'lists of lists are not supported in FOLIO 0.1', e.items[0].span); return this.record(e, ERR, 'nested list'); }
        for (const it of e.items.slice(1)) {
          const t = this.expr(it, first);
          if (t !== ERR && first !== ERR && t !== first) this.err('C002', `list items must all be ${first}, found ${t}`, it.span);
        }
        return this.record(e, first === ERR ? ERR : `List<${first}>`, `[${first}, …] → List<${first}>`);
      }
    }
  }

  binary(e: A.BinaryExpr): Type {
    const l = this.expr(e.left, null);
    const r = this.expr(e.right, null);
    if (l === ERR || r === ERR) return this.record(e, ERR, 'operand has an error');
    const bad = (needs: string) => {
      this.err('C002', `"${e.op}" needs ${needs}, found ${l} ${e.op} ${r}`, e.span, l === 'String' || r === 'String' ? 'convert numbers with str(n) or fmt(n, digits)' : undefined);
      return this.record(e, ERR, `${l} ${e.op} ${r}: no rule`);
    };
    switch (e.op) {
      case '+':
        if (l === 'Number' && r === 'Number') return this.record(e, 'Number', 'Number + Number → Number');
        if (l === 'String' && r === 'String') return this.record(e, 'String', 'String + String → String (concatenation)');
        return bad('two Numbers or two Strings');
      case '-': case '*': case '/': case '%':
        if (l === 'Number' && r === 'Number') return this.record(e, 'Number', `Number ${e.op} Number → Number`);
        return bad('two Numbers');
      case '<': case '<=': case '>': case '>=':
        if (l === 'Number' && r === 'Number') return this.record(e, 'Boolean', `Number ${e.op} Number → Boolean`);
        return bad('two Numbers');
      case '==': case '!=':
        if (l === r && EQ_TYPES.has(l)) return this.record(e, 'Boolean', `${l} ${e.op} ${l} → Boolean`);
        return bad('two values of the same type (Number, Boolean, String or Color)');
      case 'and': case 'or':
        if (l === 'Boolean' && r === 'Boolean') return this.record(e, 'Boolean', `Boolean ${e.op} Boolean → Boolean (short-circuit)`);
        return bad('two Booleans');
    }
  }

  call(e: A.CallExpr): Type {
    const b = BUILTINS[e.callee];
    const f = this.fns.get(e.callee);
    if (!b && !f) {
      for (const a of e.args) this.expr(a, null);
      if (e.callee in PRIMITIVES) { this.err('C008', `"${e.callee}" draws a shape and has no value; use it as a statement`, e.calleeSpan); return this.record(e, ERR, 'primitive in expression'); }
      const local = this.lookup(e.callee);
      if (local !== null) this.err('C008', `"${e.callee}" is a ${this.symbols[local].kind}, not a function`, e.calleeSpan);
      else this.err('C001', `no function named "${e.callee}"`, e.calleeSpan, this.suggest(e.callee));
      return this.record(e, ERR, 'unknown function');
    }
    const params = b ? b.params : f!.params;
    if (e.args.length !== params.length) {
      for (const a of e.args) this.expr(a, null);
      this.err('C003', `${e.callee} takes ${params.length} argument${params.length === 1 ? '' : 's'}, given ${e.args.length}`, e.span, b ? undefined : `fn ${e.callee}(${f!.paramNames.map((n, i) => `${n}: ${f!.params[i]}`).join(', ')}) -> ${f!.ret}`);
      return this.record(e, b ? b.ret : f!.ret, 'arity error');
    }
    let ok = true;
    let listArg: Type = ERR;
    e.args.forEach((a, i) => {
      if (params[i] === 'List<*>') {
        const t = this.expr(a, null);
        if (t !== ERR && !listElem(t)) { this.err('C002', `${e.callee} needs a List, found ${t}`, a.span); ok = false; }
        listArg = t;
      } else {
        const t = this.expectType(a, params[i], `argument ${i + 1} of ${e.callee}`);
        if (t !== params[i]) ok = false;
      }
    });
    if (f) {
      if (this.currentFn) { const cg = this.callGraph[this.currentFn.name]; if (!cg.includes(e.callee)) cg.push(e.callee); }
      else if (!this.sceneCalls.includes(e.callee)) this.sceneCalls.push(e.callee);
      // Calls always name the function (a let may shadow the name as a value, never as a callee).
      const sid = this.symbols.findIndex((s) => s.kind === 'fn' && s.name === e.callee);
      if (sid >= 0) { this.resolutions.set(e.id, sid); this.symbols[sid].uses.push(e.calleeSpan); }
    }
    const ret = b ? b.ret : f!.ret;
    const sigText = `${e.callee}(${params.map((p) => (p === 'List<*>' ? listArg : p)).join(', ')}) → ${ret}`;
    return this.record(e, ok ? ret : ERR, b ? `built-in ${sigText}` : `fn ${sigText}`);
  }

  /** The VM's call-depth limit, made a static rule: the longest call chain from the scene (scene frame included)
   * must fit, so both executors accept exactly the same programs. Only runs when the call graph is acyclic. */
  checkCallDepth(p: A.Program) {
    const memo = new Map<string, number>();
    const depth = (f: string): number => {
      if (memo.has(f)) return memo.get(f)!;
      const d = 1 + Math.max(0, ...(this.callGraph[f] ?? []).map(depth));
      memo.set(f, d);
      return d;
    };
    const longest = 1 + Math.max(0, ...this.sceneCalls.map(depth));
    if (longest > this.limits.maxCallDepth) {
      const scene = p.items.find((i) => i.kind === 'SceneDecl');
      this.err('S004', `the longest call chain is ${longest - 1} functions deep; the limit is ${this.limits.maxCallDepth - 1}`, scene?.span ?? p.span, 'flatten the chain of helper functions');
    }
  }

  /**
   * The reference interpreter is a tree walker: a call evaluates the callee's body on the host stack below the
   * call site. Its deepest host recursion is therefore the deepest syntax path through the scene, where a call to a
   * user function continues into that function's own deepest path. That weight must fit a fixed budget so the
   * oracle never overflows the host stack on a checked program. Only runs when the call graph is acyclic.
   */
  checkNestingWeight(p: A.Program) {
    const decls = new Map<string, A.FnDecl>();
    for (const i of p.items) if (i.kind === 'FnDecl' && !decls.has(i.name)) decls.set(i.name, i);
    // Callees are weighed before their callers (post-order over the acyclic call graph, without host recursion),
    // so each walk below stays inside one declaration and never nests into another.
    const memo = new Map<string, number>();
    const weightOf = (root: A.AnyNode): number => {
      let best = 0;
      const walk = (n: A.AnyNode, d: number) => {
        let here = d;
        if (n.kind === 'Call' && decls.has(n.callee) && !Object.hasOwn(BUILTINS, n.callee)) here = d + (memo.get(n.callee) ?? 0);
        if (here > best) best = here;
        for (const k of children(n)) walk(k, d + 1);
      };
      walk(root, 1);
      return best;
    };
    const done = new Set<string>();
    for (const start of decls.keys()) {
      if (done.has(start)) continue;
      const stack: [string, number][] = [[start, 0]];
      done.add(start);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const callees = (this.callGraph[top[0]] ?? []).filter((c) => decls.has(c));
        if (top[1] < callees.length) {
          const next = callees[top[1]++];
          if (!done.has(next)) { done.add(next); stack.push([next, 0]); }
          continue;
        }
        stack.pop();
        memo.set(top[0], weightOf(decls.get(top[0])!));
      }
    }
    const scene = p.items.find((i) => i.kind === 'SceneDecl');
    if (!scene) return;
    const w = weightOf(scene);
    if (w > this.limits.maxNestingWeight) {
      this.err('S005', `the deepest nesting through calls is ${w} syntax levels; the limit is ${this.limits.maxNestingWeight}`, scene.span, 'split long expressions into let statements, or flatten the chain of helper functions');
    }
  }

  checkRecursion(p: A.Program): boolean {
    // Depth-first search over the call graph; any back edge is (direct or mutual) recursion.
    const state = new Map<string, 0 | 1 | 2>();
    const reported = new Set<string>();
    const visit = (n: string, path: string[]) => {
      state.set(n, 1);
      for (const m of this.callGraph[n] ?? []) {
        if (state.get(m) === 1) {
          const cycle = [...path.slice(path.indexOf(m)), m];
          const key = [...cycle].sort().join(',');
          if (!reported.has(key)) {
            reported.add(key);
            const decl = p.items.find((i) => i.kind === 'FnDecl' && i.name === m) as A.FnDecl | undefined;
            this.err('C012', `recursion is not allowed: ${cycle.join(' → ')}`, decl?.nameSpan ?? p.span, 'FOLIO 0.1 programs always terminate; rewrite the recursion as a bounded repeat');
          }
        } else if (!state.get(m)) visit(m, [...path, m]);
      }
      state.set(n, 2);
    };
    for (const n of Object.keys(this.callGraph)) if (!state.get(n)) visit(n, [n]);
    return reported.size === 0;
  }
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
