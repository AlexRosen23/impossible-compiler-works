// The reference interpreter: a direct tree-walking evaluator of the checked AST. It is the semantic oracle for
// differential testing, so it deliberately shares nothing with the IR, the optimizer, the bytecode or the VM.
// It does share the value representation, the pure built-ins, the primitive table and the scene builder (the
// output device); those are covered by their own unit tests. See docs/OPTIMIZATION_CORRECTNESS.md.
import type * as A from './ast.ts';
import { CONSTANTS, callBuiltin, BUILTINS } from './builtins.ts';
import type { CheckResult } from './checker.ts';
import type { Span } from './diagnostics.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { GROUP_SIG, PRIMITIVES, type PrimSig } from './primitives.ts';
import { type DrawCmd, type Frame, SceneBuilder, type SceneOutput } from './scene.ts';
import {
  type ColorV, FaultSignal, FolioFault, type PointV, type Value, colorFromHex, finite, isColor, valueEquals,
} from './values.ts';
import { SCENE_FORMAT } from './version.ts';

export interface RunFault { code: string; message: string; span: Span | null; frame: number }
export interface RunResult { scene: SceneOutput; fault: RunFault | null; stats: { iterations: number; draws: number } }

class Env {
  vars = new Map<string, { v: Value; mutable: boolean }>();
  parent: Env | null;
  constructor(parent: Env | null) { this.parent = parent; }
  get(n: string): Value {
    for (let e: Env | null = this; e; e = e.parent) { const b = e.vars.get(n); if (b) return b.v; }
    throw new Error(`reference interpreter: unbound ${n} (checker should have rejected this)`);
  }
  set(n: string, v: Value) {
    for (let e: Env | null = this; e; e = e.parent) { const b = e.vars.get(n); if (b) { b.v = v; return; } }
    throw new Error(`reference interpreter: unbound ${n}`);
  }
  define(n: string, v: Value, mutable = false) { this.vars.set(n, { v, mutable }); }
}

class ReturnSignal { value: Value; constructor(v: Value) { this.value = v; } }

export function interpret(program: A.Program, check: CheckResult, data: Map<string, Value>, limits: Limits = DEFAULT_LIMITS, onlyFrame?: number): RunResult {
  const sceneDecl = program.items.find((i): i is A.SceneDecl => i.kind === 'SceneDecl');
  if (!sceneDecl || !check.scene) throw new Error('interpret: no scene');
  const info = check.scene;
  const fns = new Map<string, A.FnDecl>();
  for (const i of program.items) if (i.kind === 'FnDecl' && !fns.has(i.name)) fns.set(i.name, i);
  const globals = new Env(null);
  for (const [n, c] of Object.entries(CONSTANTS)) globals.define(n, c.value);
  for (const [n, v] of data) globals.define(n, v);

  const frames: Frame[] = [];
  let fault: RunFault | null = null;
  let iterations = 0, draws = 0;
  const indices = onlyFrame === undefined ? Array.from({ length: info.frames }, (_, i) => i) : [onlyFrame];
  for (const f of indices) {
    const time = f / info.frames;
    const ev = new Evaluator(fns, globals, limits);
    const env = new Env(globals);
    env.define('WIDTH', info.width); env.define('HEIGHT', info.height); env.define('time', time); env.define('frame', f);
    try {
      ev.block(sceneDecl.body, env);
    } catch (e) {
      if (!(e instanceof FolioFault)) throw e;
      fault = { code: e.code, message: e.message, span: e.span, frame: f };
    }
    frames.push({ index: f, time, cmds: ev.scene.cmds as DrawCmd[] });
    iterations += ev.iterations; draws += ev.scene.cmds.length;
    if (fault) break;
  }
  return { scene: { format: SCENE_FORMAT, title: info.title, width: info.width, height: info.height, background: info.background, frames }, fault, stats: { iterations, draws } };
}

class Evaluator {
  scene: SceneBuilder;
  iterations = 0;
  private fns: Map<string, A.FnDecl>;
  private globals: Env;
  private limits: Limits;
  constructor(fns: Map<string, A.FnDecl>, globals: Env, limits: Limits) {
    this.fns = fns; this.globals = globals; this.limits = limits;
    this.scene = new SceneBuilder(limits);
  }

  at<T>(span: Span, f: () => T): T {
    try { return f(); } catch (e) {
      if (e instanceof FaultSignal) throw new FolioFault(e.code, e.message, span);
      throw e;
    }
  }

  block(b: A.Block, env: Env): void {
    for (const s of b.stmts) this.stmt(s, env);
  }

  stmt(s: A.Stmt, env: Env): void {
    switch (s.kind) {
      case 'Let': env.define(s.name, this.expr(s.init, env), s.mutable); return;
      case 'Assign': env.set(s.name, this.expr(s.value, env)); return;
      case 'If': {
        if (this.expr(s.cond, env) as boolean) this.block(s.then, new Env(env));
        else if (s.else?.kind === 'If') this.stmt(s.else, env);
        else if (s.else) this.block(s.else, new Env(env));
        return;
      }
      case 'Repeat': {
        if (s.iterable) {
          const xs = this.expr(s.iterable, env) as Value[];
          for (const x of xs) {
            this.tick(s.span);
            const inner = new Env(env);
            inner.define(s.name, x);
            this.block(s.body, inner);
          }
        } else {
          const a = this.expr(s.from!, env) as number;
          const b = this.expr(s.to!, env) as number;
          if (!Number.isInteger(a) || !Number.isInteger(b)) throw new FolioFault('R008', `range ${a}..${b} has a bound that is not a whole number`, s.span);
          for (let i = a; i < b; i++) {
            this.tick(s.span);
            const inner = new Env(env);
            inner.define(s.name, i);
            this.block(s.body, inner);
          }
        }
        return;
      }
      case 'Return': throw new ReturnSignal(this.expr(s.value, env));
      case 'Assert': {
        if (!(this.expr(s.cond, env) as boolean)) throw new FolioFault('R003', s.message ?? 'assertion failed', s.span);
        return;
      }
      case 'Draw': {
        const args = this.named(PRIMITIVES[s.prim], s.args, env);
        this.at(s.span, () => this.scene.draw(s.prim as DrawCmd['k'], args));
        return;
      }
      case 'Group': {
        const [t, r, sc, o] = this.named(GROUP_SIG, s.args, env);
        this.at(s.span, () => this.scene.pushGroup(t as PointV, r as number, sc as number, o as number));
        this.block(s.body, new Env(env));
        this.scene.popGroup();
        return;
      }
    }
  }

  tick(span: Span) {
    if (++this.iterations > this.limits.maxIterationsPerFrame) throw new FolioFault('R004', `more than ${this.limits.maxIterationsPerFrame} loop iterations in one frame`, span);
  }

  /** Evaluate named arguments in the order written, then arrange them in parameter order with defaults. */
  named(sig: PrimSig, args: A.NamedArg[], env: Env): Value[] {
    const given = new Map<string, Value>();
    for (const a of args) given.set(a.name, this.expr(a.value, env));
    return sig.params.map((p) => (given.has(p.name) ? given.get(p.name)! : p.default!));
  }

  num(e: A.Expr, env: Env): number { return this.expr(e, env) as number; }

  expr(e: A.Expr, env: Env): Value {
    switch (e.kind) {
      case 'Num': return e.value;
      case 'Str': return e.value;
      case 'Bool': return e.value;
      case 'Color': return colorFromHex(e.value);
      case 'Name': return env.get(e.name);
      case 'List': return Object.freeze(e.items.map((x) => this.expr(x, env)));
      case 'Unary': return e.op === '-' ? -this.num(e.operand, env) : !(this.expr(e.operand, env) as boolean);
      case 'Binary': {
        if (e.op === 'and') return (this.expr(e.left, env) as boolean) ? (this.expr(e.right, env) as boolean) : false;
        if (e.op === 'or') return (this.expr(e.left, env) as boolean) ? true : (this.expr(e.right, env) as boolean);
        const l = this.expr(e.left, env), r = this.expr(e.right, env);
        const arith = (v: number) => this.at(e.span, () => finite(v, `"${e.op}"`));
        switch (e.op) {
          case '+':
            if (typeof l === 'string') {
              const s = l + (r as string);
              if (s.length > this.limits.maxStringLength) throw new FolioFault('R009', `string of ${s.length} characters`, e.span);
              return s;
            }
            return arith((l as number) + (r as number));
          case '-': return arith((l as number) - (r as number));
          case '*': return arith((l as number) * (r as number));
          case '/': return arith((l as number) / (r as number));
          case '%': return arith((l as number) % (r as number));
          case '<': return (l as number) < (r as number);
          case '<=': return (l as number) <= (r as number);
          case '>': return (l as number) > (r as number);
          case '>=': return (l as number) >= (r as number);
          case '==': return valueEquals(l, r);
          case '!=': return !valueEquals(l, r);
        }
        throw new Error('unreachable');
      }
      case 'Call': {
        const args = e.args.map((a) => this.expr(a, env));
        if (e.callee in BUILTINS) return this.at(e.span, () => callBuiltin(e.callee, args, this.limits.maxStringLength));
        const f = this.fns.get(e.callee)!;
        const fenv = new Env(this.globals);
        f.params.forEach((p, i) => fenv.define(p.name, args[i]));
        try {
          this.block(f.body, fenv);
        } catch (sig) {
          if (sig instanceof ReturnSignal) return sig.value;
          throw sig;
        }
        throw new Error(`reference interpreter: ${f.name} fell off its end (checker should have rejected this)`);
      }
      case 'Index': {
        const xs = this.expr(e.target, env) as Value[];
        const i = this.num(e.index, env);
        if (!Number.isInteger(i) || i < 0 || i >= xs.length) throw new FolioFault('R002', `index ${i} is outside 0..${xs.length - 1}`, e.span);
        return xs[i];
      }
      case 'Field': {
        const t = this.expr(e.target, env);
        if (isColor(t)) return (t as ColorV)[e.field as 'r' | 'g' | 'b' | 'a'];
        return (t as PointV)[e.field as 'x' | 'y'];
      }
    }
  }
}
