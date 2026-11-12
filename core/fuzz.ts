// Grammar- and type-directed program generator with a stable seed. Generated programs are well-typed by
// construction (they still go through the real parser and checker: a generator bug shows up as a rejected
// program, which the fuzz harness reports). Faults are allowed and expected (division by zero, out-of-range
// indexes, failing assertions): the oracle must fault identically.
import type * as A from './ast.ts';
import { NO_SPAN } from './diagnostics.ts';
import { formatProgram } from './format.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type T = 'Number' | 'Boolean' | 'String' | 'Color' | 'Point';
const S = NO_SPAN;
const num = (v: number): A.Expr => ({ kind: 'Num', id: 0, value: v, span: S });
const nm = (n: string): A.Expr => ({ kind: 'Name', id: 0, name: n, span: S });
const call = (f: string, args: A.Expr[]): A.Expr => ({ kind: 'Call', id: 0, callee: f, calleeSpan: S, args, span: S });
const bin = (op: A.BinaryOp, l: A.Expr, r: A.Expr): A.Expr => ({ kind: 'Binary', id: 0, op, left: l, right: r, span: S });
const ty = (n: T): A.TypeNode => ({ kind: 'TypeRef', id: 0, name: n, elem: null, span: S });

interface Scope { vars: { name: string; type: T; mutable: boolean }[] }

export class Generator {
  r: () => number;
  n = 0;
  fns: { name: string; arity: number }[] = [];
  constructor(seed: number) { this.r = mulberry32(seed); }
  pick<X>(xs: X[]): X { return xs[Math.floor(this.r() * xs.length)]; }
  chance(p: number): boolean { return this.r() < p; }
  fresh(prefix: string): string { return `${prefix}${this.n++}`; }

  program(): A.Program {
    const items: A.Item[] = [];
    const nf = Math.floor(this.r() * 3);
    for (let k = 0; k < nf; k++) items.push(this.fn(`f${k}`));
    const frames = this.pick([1, 1, 2, 3]);
    const scope: Scope = { vars: [{ name: 'time', type: 'Number', mutable: false }, { name: 'frame', type: 'Number', mutable: false }] };
    const body = this.stmts(scope, 2, true, 3 + Math.floor(this.r() * 8));
    items.push({ kind: 'SceneDecl', id: 0, title: 'fuzz', options: frames > 1 ? [{ name: 'frames', values: [frames], span: S }] : [], body: { kind: 'Block', id: 0, stmts: body, span: S }, span: S });
    return { kind: 'Program', id: 0, items, span: S };
  }

  fn(name: string): A.FnDecl {
    const arity = 1 + Math.floor(this.r() * 2);
    const params: A.Param[] = Array.from({ length: arity }, (_, i) => ({ kind: 'Param', id: 0, name: `p${i}`, type: ty('Number'), span: S }));
    const scope: Scope = { vars: params.map((p) => ({ name: p.name, type: 'Number' as T, mutable: false })) };
    const stmts = this.stmts(scope, 1, false, 1 + Math.floor(this.r() * 3));
    if (this.chance(0.4)) {
      stmts.push({ kind: 'If', id: 0, cond: this.expr('Boolean', scope, 2), then: { kind: 'Block', id: 0, stmts: [{ kind: 'Return', id: 0, value: this.expr('Number', scope, 2), span: S }], span: S }, else: null, span: S });
    }
    stmts.push({ kind: 'Return', id: 0, value: this.expr('Number', scope, 3), span: S });
    this.fns.push({ name, arity });
    return { kind: 'FnDecl', id: 0, name, nameSpan: S, params, ret: ty('Number'), body: { kind: 'Block', id: 0, stmts, span: S }, span: S };
  }

  stmts(scope: Scope, depth: number, inScene: boolean, count: number): A.Stmt[] {
    const out: A.Stmt[] = [];
    const local: Scope = { vars: [...scope.vars] };
    for (let k = 0; k < count; k++) out.push(...this.stmt(local, depth, inScene));
    return out;
  }

  stmt(scope: Scope, depth: number, inScene: boolean): A.Stmt[] {
    const kinds = ['let', 'let', 'var', 'assign', 'if', 'repeat', 'assert'];
    if (inScene) kinds.push('draw', 'draw', 'draw', 'group');
    const k = this.pick(depth > 0 ? kinds : kinds.filter((x) => x !== 'if' && x !== 'repeat' && x !== 'group'));
    switch (k) {
      case 'let': case 'var': {
        const t = this.pick<T>(['Number', 'Number', 'Boolean', 'String', 'Color', 'Point']);
        const name = this.fresh(k === 'var' ? 'v' : 'l');
        const init = this.expr(t, scope, 3);
        scope.vars.push({ name, type: t, mutable: k === 'var' });
        return [{ kind: 'Let', id: 0, mutable: k === 'var', name, nameSpan: S, type: this.chance(0.5) ? ty(t) : null, init, span: S }];
      }
      case 'assign': {
        const vs = scope.vars.filter((v) => v.mutable);
        if (!vs.length) return [];
        const v = this.pick(vs);
        return [{ kind: 'Assign', id: 0, name: v.name, nameSpan: S, value: this.expr(v.type, scope, 3), span: S }];
      }
      case 'if':
        return [{
          kind: 'If', id: 0, cond: this.expr('Boolean', scope, 2),
          then: { kind: 'Block', id: 0, stmts: this.stmts(scope, depth - 1, inScene, 1 + Math.floor(this.r() * 3)), span: S },
          else: this.chance(0.5) ? { kind: 'Block', id: 0, stmts: this.stmts(scope, depth - 1, inScene, 1 + Math.floor(this.r() * 2)), span: S } : null, span: S,
        }];
      case 'repeat': {
        const name = this.fresh('i');
        const inner: Scope = { vars: [...scope.vars, { name, type: 'Number', mutable: false }] };
        const overList = this.chance(0.3);
        const list: A.Expr = { kind: 'List', id: 0, items: Array.from({ length: 1 + Math.floor(this.r() * 4) }, () => this.expr('Number', scope, 1)), span: S };
        return [{
          kind: 'Repeat', id: 0, name, nameSpan: S,
          from: overList ? null : num(Math.floor(this.r() * 3)), to: overList ? null : (this.chance(0.8) ? num(Math.floor(this.r() * 6)) : this.expr('Number', scope, 1)),
          iterable: overList ? list : null,
          body: { kind: 'Block', id: 0, stmts: this.stmts(inner, depth - 1, inScene, 1 + Math.floor(this.r() * 3)), span: S }, span: S,
        }];
      }
      case 'assert':
        return [{ kind: 'Assert', id: 0, cond: this.chance(0.7) ? bin('==', this.expr('Number', scope, 1), this.expr('Number', scope, 1)) : this.expr('Boolean', scope, 2), message: this.chance(0.5) ? 'fuzz assert' : null, span: S }];
      case 'group':
        return [{
          kind: 'Group', id: 0, args: this.named([['translate', 'Point'], ['rotate', 'Number'], ['scale', 'Number'], ['opacity', 'Number']], scope, true),
          body: { kind: 'Block', id: 0, stmts: this.stmts(scope, depth - 1, inScene, 1 + Math.floor(this.r() * 2)), span: S }, span: S,
        }];
      default: {
        const prim = this.pick(['circle', 'rect', 'line', 'text']);
        const sig: Record<string, [string, T, boolean][]> = {
          circle: [['x', 'Number', false], ['y', 'Number', false], ['radius', 'Number', false], ['fill', 'Color', true], ['stroke', 'Color', true], ['strokeWidth', 'Number', true]],
          rect: [['x', 'Number', false], ['y', 'Number', false], ['width', 'Number', false], ['height', 'Number', false], ['fill', 'Color', true], ['corner', 'Number', true]],
          line: [['from', 'Point', false], ['to', 'Point', false], ['stroke', 'Color', true], ['strokeWidth', 'Number', true]],
          text: [['x', 'Number', false], ['y', 'Number', false], ['value', 'String', false], ['size', 'Number', true], ['fill', 'Color', true]],
        };
        const args: A.NamedArg[] = [];
        for (const [n, t, opt] of sig[prim]) {
          if (opt && this.chance(0.5)) continue;
          // Sizes are usually non-negative, sometimes not (exercises R010 in both executors).
          const v = ['radius', 'width', 'height', 'strokeWidth', 'size', 'corner'].includes(n) && this.chance(0.9) ? call('abs', [this.expr('Number', scope, 2)]) : this.expr(t, scope, 2);
          args.push({ kind: 'NamedArg', id: 0, name: n, nameSpan: S, value: v, span: S });
        }
        // Shuffle: named arguments are evaluated in the order written.
        for (let i = args.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [args[i], args[j]] = [args[j], args[i]]; }
        return [{ kind: 'Draw', id: 0, prim, primSpan: S, args, span: S }];
      }
    }
  }

  named(params: [string, T][], scope: Scope, optional: boolean): A.NamedArg[] {
    return params.filter(() => !optional || this.chance(0.6)).map(([n, t]) => ({ kind: 'NamedArg', id: 0, name: n, nameSpan: S, value: this.expr(t, scope, 2), span: S }));
  }

  expr(t: T, scope: Scope, depth: number): A.Expr {
    const vars = scope.vars.filter((v) => v.type === t);
    if (depth <= 0 || this.chance(0.25)) {
      if (vars.length && this.chance(0.6)) return nm(this.pick(vars).name);
      return this.leaf(t, scope);
    }
    const d = depth - 1;
    switch (t) {
      case 'Number': {
        const c = this.pick(['bin', 'bin', 'bin', 'neg', 'call', 'call', 'fn', 'field', 'index', 'len']);
        if (c === 'bin') return bin(this.pick(['+', '-', '*', '/', '%'] as A.BinaryOp[]), this.expr('Number', scope, d), this.expr('Number', scope, d));
        if (c === 'neg') return { kind: 'Unary', id: 0, op: '-', operand: this.expr('Number', scope, d), span: S };
        if (c === 'call') {
          const [f, n] = this.pick<[string, number]>([['sin', 1], ['cos', 1], ['sqrt', 1], ['abs', 1], ['floor', 1], ['round', 1], ['min', 2], ['max', 2], ['clamp', 3], ['lerp', 3], ['pow', 2], ['noise', 2]]);
          return call(f, Array.from({ length: n }, () => this.expr('Number', scope, d)));
        }
        if (c === 'fn' && this.fns.length) { const f = this.pick(this.fns); return call(f.name, Array.from({ length: f.arity }, () => this.expr('Number', scope, d))); }
        if (c === 'field') return { kind: 'Field', id: 0, target: this.expr('Point', scope, d), field: this.pick(['x', 'y']), fieldSpan: S, span: S };
        if (c === 'index') return { kind: 'Index', id: 0, target: { kind: 'List', id: 0, items: [this.expr('Number', scope, d), this.expr('Number', scope, d)], span: S }, index: this.chance(0.8) ? num(Math.floor(this.r() * 2)) : this.expr('Number', scope, d), span: S };
        if (c === 'len') return call('len', [{ kind: 'List', id: 0, items: [this.leaf('Number', scope)], span: S }]);
        return this.leaf(t, scope);
      }
      case 'Boolean': {
        const c = this.pick(['cmp', 'cmp', 'eq', 'logic', 'not']);
        if (c === 'cmp') return bin(this.pick(['<', '<=', '>', '>='] as A.BinaryOp[]), this.expr('Number', scope, d), this.expr('Number', scope, d));
        if (c === 'eq') { const tt = this.pick<T>(['Number', 'Boolean', 'String', 'Color']); return bin(this.pick(['==', '!='] as A.BinaryOp[]), this.expr(tt, scope, d), this.expr(tt, scope, d)); }
        if (c === 'logic') return bin(this.pick(['and', 'or'] as A.BinaryOp[]), this.expr('Boolean', scope, d), this.expr('Boolean', scope, d));
        return { kind: 'Unary', id: 0, op: 'not', operand: this.expr('Boolean', scope, d), span: S };
      }
      case 'String': {
        const c = this.pick(['concat', 'str', 'fmt']);
        if (c === 'concat') return bin('+', this.expr('String', scope, d), this.expr('String', scope, d));
        if (c === 'str') return call('str', [this.expr('Number', scope, d)]);
        return call('fmt', [this.expr('Number', scope, d), num(Math.floor(this.r() * 4))]);
      }
      case 'Color': {
        const c = this.pick(['rgb', 'hsl', 'mix', 'alpha']);
        if (c === 'rgb') return call('rgb', [this.expr('Number', scope, d), this.expr('Number', scope, d), this.expr('Number', scope, d)]);
        if (c === 'hsl') return call('hsl', [this.expr('Number', scope, d), num(0.5), num(0.5)]);
        if (c === 'mix') return call('mix', [this.expr('Color', scope, d), this.expr('Color', scope, d), this.expr('Number', scope, d)]);
        return call('alpha', [this.expr('Color', scope, d), this.expr('Number', scope, d)]);
      }
      case 'Point':
        return call('point', [this.expr('Number', scope, d), this.expr('Number', scope, d)]);
    }
  }

  leaf(t: T, scope: Scope): A.Expr {
    switch (t) {
      case 'Number': return this.chance(0.15) ? num(0) : num(this.chance(0.5) ? Math.floor(this.r() * 100) : Math.round(this.r() * 1000) / 100);
      case 'Boolean': return { kind: 'Bool', id: 0, value: this.chance(0.5), span: S };
      case 'String': return { kind: 'Str', id: 0, value: this.pick(['a', 'tiger', 'ü', '', '"q"', '紙']), span: S };
      case 'Color': return { kind: 'Color', id: 0, value: this.pick(['#b2534f', '#bb9c67', '#98abb9', '#8db7a2ff', '#f0eadd80']), span: S };
      case 'Point': return call('point', [this.leaf('Number', scope), this.leaf('Number', scope)]);
    }
  }
}

export function generateProgram(seed: number): string {
  return formatProgram(new Generator(seed).program());
}

/** Token-level mutation of a valid program for robustness fuzzing of the lexer/parser/checker (no crashes). */
export function mutateSource(src: string, seed: number): string {
  const r = mulberry32(seed);
  const pieces = src.split(/(\s+)/);
  const ops = 1 + Math.floor(r() * 3);
  for (let k = 0; k < ops; k++) {
    const i = Math.floor(r() * pieces.length);
    const choice = Math.floor(r() * 5);
    if (choice === 0) pieces.splice(i, 1);
    else if (choice === 1) pieces.splice(i, 0, pieces[Math.floor(r() * pieces.length)] ?? '');
    else if (choice === 2) pieces[i] = (pieces[i] ?? '').slice(0, Math.floor(r() * 3));
    else if (choice === 3) pieces[i] = ['{', '}', '(', ')', ';', '..', '"', '#zz', '@', 'let', 'repeat', '/*'][Math.floor(r() * 12)];
    else { const j = Math.floor(r() * pieces.length); [pieces[i], pieces[j]] = [pieces[j], pieces[i]]; }
  }
  return pieces.join('');
}
