// Lowering: checked AST → IR. Deliberately naive (every `let` becomes a `mov`, every name read of a var
// becomes a `load`, short-circuit operators go through a slot), so the optimizer's work is visible and
// measurable. Evaluation order is preserved exactly: left to right, named arguments in the order written.
import type * as A from './ast.ts';
import { BUILTINS, CONSTANTS } from './builtins.ts';
import type { CheckResult } from './checker.ts';
import type { Span } from './diagnostics.ts';
import type { BasicBlock, IRFunction, IRModule, Instr, InstrMeta, Op, Operand, Slot, Terminator } from './ir.ts';
import { GROUP_SIG, PRIMITIVES, type PrimSig } from './primitives.ts';
import { colorFromHex } from './values.ts';
import { IR_VERSION } from './version.ts';

type Binding = { k: 'reg'; reg: number } | { k: 'slot'; slot: number } | { k: 'const'; v: number } | { k: 'global'; index: number; name: string; type: string };

export function lower(program: A.Program, check: CheckResult): IRModule {
  const scene = check.scene!;
  const mod: IRModule = { version: IR_VERSION, scene: { ...scene }, data: check.data.map((d) => ({ name: d.name, type: d.type })), functions: [], main: 0, nextInstrId: 1 };
  const fnDecls = program.items.filter((i): i is A.FnDecl => i.kind === 'FnDecl' && check.fns.get(i.name)?.node === i.id);
  const sceneDecl = program.items.find((i): i is A.SceneDecl => i.kind === 'SceneDecl')!;
  const ids = { next: 1 };
  for (const f of fnDecls) mod.functions.push(new FnLowerer(check, mod, ids, f.name, check.fns.get(f.name)!.ret).fn(f));
  mod.main = mod.functions.length;
  mod.functions.push(new FnLowerer(check, mod, ids, 'scene', null).scene(sceneDecl));
  mod.nextInstrId = ids.next;
  return mod;
}

class FnLowerer {
  f: IRFunction;
  cur: BasicBlock;
  scopes: Map<string, Binding>[] = [];
  private check: CheckResult;
  private mod: IRModule;
  private ids: { next: number };
  constructor(check: CheckResult, mod: IRModule, ids: { next: number }, name: string, ret: string | null) {
    this.check = check; this.mod = mod; this.ids = ids;
    this.f = { name, nparams: 0, slots: [], nregs: 0, blocks: [], ret, regTypes: [] };
    this.cur = this.newBlock('entry');
    const g = new Map<string, Binding>();
    for (const [n, c] of Object.entries(CONSTANTS)) g.set(n, { k: 'const', v: c.value });
    mod.data.forEach((d, i) => g.set(d.name, { k: 'global', index: i, name: d.name, type: d.type }));
    this.scopes.push(g);
  }

  newBlock(label: string): BasicBlock {
    const b: BasicBlock = { id: this.f.blocks.length, label: `${label}${this.f.blocks.length}`, instrs: [], term: { op: 'halt', span: { start: 0, end: 0, line: 0, col: 0 } } };
    this.f.blocks.push(b);
    return b;
  }
  /** Blocks are created open; `seal` sets the terminator. An unsealed block keeps the placeholder halt. */
  sealed = new Set<number>();
  terminate(t: Terminator) { if (!this.sealed.has(this.cur.id)) { this.cur.term = t; this.sealed.add(this.cur.id); } }
  enter(b: BasicBlock) { this.cur = b; }
  reg(type: string | null): number { this.f.regTypes.push(type); return this.f.nregs++; }
  slot(name: string, type: string, kind: Slot['kind']): number { this.f.slots.push({ name, type, kind }); return this.f.slots.length - 1; }
  emit(op: Op, args: Operand[], span: Span, type: string | null, meta: InstrMeta = {}): Operand {
    const dst = type === null ? null : this.reg(type);
    const i: Instr = { id: this.ids.next++, op, dst, args, meta, span, type };
    if (!this.sealed.has(this.cur.id)) this.cur.instrs.push(i);
    else { const dead = this.newBlock('dead'); this.enter(dead); dead.instrs.push(i); }
    return dst === null ? { k: 'c', v: null } : { k: 'r', id: dst };
  }
  lookup(n: string): Binding { for (let i = this.scopes.length - 1; i >= 0; i--) { const b = this.scopes[i].get(n); if (b) return b; } throw new Error(`lower: unbound ${n}`); }
  bind(n: string, b: Binding) { this.scopes[this.scopes.length - 1].set(n, b); }
  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }
  typeOf(e: A.Expr): string { return this.check.types.get(e.id) ?? 'Error'; }

  fn(d: A.FnDecl): IRFunction {
    this.push();
    const sig = this.check.fns.get(d.name)!;
    d.params.forEach((p, i) => this.bind(p.name, { k: 'slot', slot: this.slot(p.name, sig.params[i], 'param') }));
    this.f.nparams = d.params.length;
    this.stmts(d.body.stmts);
    // The checker proved every path returns; anything left open is unreachable.
    this.terminate({ op: 'halt', span: d.body.span });
    this.pop();
    return this.f;
  }

  scene(d: A.SceneDecl): IRFunction {
    this.push();
    const s = this.check.scene!;
    this.bind('WIDTH', { k: 'const', v: s.width });
    this.bind('HEIGHT', { k: 'const', v: s.height });
    this.bind('time', { k: 'slot', slot: this.slot('time', 'Number', 'input') });
    this.bind('frame', { k: 'slot', slot: this.slot('frame', 'Number', 'input') });
    this.stmts(d.body.stmts);
    this.terminate({ op: 'halt', span: d.body.span });
    this.pop();
    return this.f;
  }

  stmts(ss: A.Stmt[]) { for (const s of ss) this.stmt(s); }
  blockScoped(b: A.Block) { this.push(); this.stmts(b.stmts); this.pop(); }

  stmt(s: A.Stmt) {
    switch (s.kind) {
      case 'Let': {
        const v = this.expr(s.init);
        const t = this.typeOf(s.init);
        if (s.mutable) {
          const slot = this.slot(s.name, t, 'var');
          this.emit('store', [v], s.span, null, { slot });
          this.bind(s.name, { k: 'slot', slot });
        } else {
          const r = this.emit('mov', [v], s.span, t, { binding: s.name });
          this.bind(s.name, { k: 'reg', reg: (r as { id: number }).id });
        }
        return;
      }
      case 'Assign': {
        const v = this.expr(s.value);
        const b = this.lookup(s.name);
        if (b.k !== 'slot') throw new Error('lower: assignment to non-slot');
        this.emit('store', [v], s.span, null, { slot: b.slot });
        return;
      }
      case 'If': {
        const c = this.expr(s.cond);
        const thenB = this.newBlock('then');
        const join = this.newBlock('endif');
        const elseB = s.else ? this.newBlock('else') : join;
        this.terminate({ op: 'br', cond: c, t: thenB.id, f: elseB.id, span: s.cond.span });
        this.enter(thenB); this.blockScoped(s.then); this.terminate({ op: 'jmp', target: join.id, span: s.then.span });
        if (s.else) {
          this.enter(elseB);
          if (s.else.kind === 'If') this.stmt(s.else); else this.blockScoped(s.else);
          this.terminate({ op: 'jmp', target: join.id, span: s.else.span });
        }
        this.enter(join);
        return;
      }
      case 'Repeat': return this.repeat(s);
      case 'Return': {
        const v = this.expr(s.value);
        this.terminate({ op: 'ret', value: v, span: s.span });
        return;
      }
      case 'Assert': {
        const c = this.expr(s.cond);
        this.emit('assert', [c], s.span, null, { message: s.message ?? undefined });
        return;
      }
      case 'Draw': {
        const args = this.named(PRIMITIVES[s.prim], s.args);
        this.emit('draw', args, s.span, null, { kind: s.prim });
        return;
      }
      case 'Group': {
        const args = this.named(GROUP_SIG, s.args);
        this.emit('gpush', args, s.span, null);
        this.blockScoped(s.body);
        this.emit('gpop', [], s.span, null);
        return;
      }
    }
  }

  repeat(s: A.RepeatStmt) {
    const one: Operand = { k: 'c', v: 1 };
    const zero: Operand = { k: 'c', v: 0 };
    const head = this.newBlock('loop');
    const body = this.newBlock('body');
    const latch = this.newBlock('next');
    const exit = this.newBlock('endloop');
    let cursor: number, limit: number | null = null, listSlot: number | null = null;
    const varType = s.iterable ? (this.typeOf(s.iterable).match(/^List<(.*)>$/)?.[1] ?? 'Error') : 'Number';
    const varSlot = this.slot(s.name, varType, 'loop');
    if (s.iterable) {
      const xs = this.expr(s.iterable);
      listSlot = this.slot(`${s.name}.list`, this.typeOf(s.iterable), 'hidden');
      cursor = this.slot(`${s.name}.index`, 'Number', 'hidden');
      this.emit('store', [xs], s.span, null, { slot: listSlot });
      this.emit('store', [zero], s.span, null, { slot: cursor });
    } else {
      const a = this.expr(s.from!);
      const b = this.expr(s.to!);
      this.emit('rangechk', [a, b], s.span, null);
      cursor = varSlot;
      limit = this.slot(`${s.name}.end`, 'Number', 'hidden');
      this.emit('store', [a], s.span, null, { slot: cursor });
      this.emit('store', [b], s.span, null, { slot: limit });
    }
    this.terminate({ op: 'jmp', target: head.id, span: s.span });
    // head: cursor < limit ?
    this.enter(head);
    const i = this.emit('load', [], s.span, 'Number', { slot: cursor });
    const end = listSlot !== null
      ? this.emit('len', [this.emit('load', [], s.span, this.f.slots[listSlot].type, { slot: listSlot })], s.span, 'Number')
      : this.emit('load', [], s.span, 'Number', { slot: limit! });
    const c = this.emit('lt', [i, end], s.span, 'Boolean');
    this.terminate({ op: 'br', cond: c, t: body.id, f: exit.id, span: s.span });
    // body
    this.enter(body);
    this.emit('tick', [], s.span, null);
    if (listSlot !== null) {
      const xs = this.emit('load', [], s.span, this.f.slots[listSlot].type, { slot: listSlot });
      const k = this.emit('load', [], s.span, 'Number', { slot: cursor });
      const x = this.emit('index', [xs, k], s.span, varType);
      this.emit('store', [x], s.span, null, { slot: varSlot });
    }
    this.push();
    this.bind(s.name, { k: 'slot', slot: varSlot });
    this.stmts(s.body.stmts);
    this.pop();
    this.terminate({ op: 'jmp', target: latch.id, span: s.body.span });
    // latch: cursor = cursor + 1
    this.enter(latch);
    const k2 = this.emit('load', [], s.span, 'Number', { slot: cursor });
    const n = this.emit('add', [k2, one], s.span, 'Number');
    this.emit('store', [n], s.span, null, { slot: cursor });
    this.terminate({ op: 'jmp', target: head.id, span: s.span });
    this.enter(exit);
  }

  named(sig: PrimSig, args: A.NamedArg[]): Operand[] {
    const given = new Map<string, Operand>();
    for (const a of args) given.set(a.name, this.expr(a.value));
    return sig.params.map((p) => given.get(p.name) ?? { k: 'c', v: p.default! });
  }

  expr(e: A.Expr): Operand {
    const t = this.typeOf(e);
    switch (e.kind) {
      case 'Num': return { k: 'c', v: e.value };
      case 'Str': return { k: 'c', v: e.value };
      case 'Bool': return { k: 'c', v: e.value };
      case 'Color': return { k: 'c', v: colorFromHex(e.value) };
      case 'Name': {
        const b = this.lookup(e.name);
        if (b.k === 'reg') return { k: 'r', id: b.reg };
        if (b.k === 'const') return { k: 'c', v: b.v };
        if (b.k === 'global') return this.emit('global', [], e.span, b.type, { global: b.index, name: b.name });
        return this.emit('load', [], e.span, t, { slot: b.slot });
      }
      case 'List': return this.emit('list', e.items.map((x) => this.expr(x)), e.span, t);
      case 'Unary': {
        const v = this.expr(e.operand);
        return this.emit(e.op === '-' ? 'neg' : 'not', [v], e.span, t);
      }
      case 'Binary': {
        if (e.op === 'and' || e.op === 'or') return this.shortCircuit(e);
        const l = this.expr(e.left);
        const r = this.expr(e.right);
        const op: Op = e.op === '+' && t === 'String' ? 'concat'
          : ({ '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne' } as const)[e.op];
        return this.emit(op, [l, r], e.span, t);
      }
      case 'Call': {
        const args = e.args.map((a) => this.expr(a));
        return this.emit(e.callee in BUILTINS ? 'callb' : 'callf', args, e.span, t, { name: e.callee });
      }
      case 'Index': {
        const xs = this.expr(e.target);
        const i = this.expr(e.index);
        return this.emit('index', [xs, i], e.span, t);
      }
      case 'Field': return this.emit('field', [this.expr(e.target)], e.span, t, { field: e.field });
    }
  }

  shortCircuit(e: A.BinaryExpr): Operand {
    const tmp = this.slot(`${e.op}#${e.id}`, 'Boolean', 'hidden');
    const l = this.expr(e.left);
    this.emit('store', [l], e.span, null, { slot: tmp });
    const rhs = this.newBlock(e.op === 'and' ? 'and' : 'or');
    const join = this.newBlock('sc');
    this.terminate(e.op === 'and'
      ? { op: 'br', cond: l, t: rhs.id, f: join.id, span: e.span }
      : { op: 'br', cond: l, t: join.id, f: rhs.id, span: e.span });
    this.enter(rhs);
    const r = this.expr(e.right);
    this.emit('store', [r], e.span, null, { slot: tmp });
    this.terminate({ op: 'jmp', target: join.id, span: e.span });
    this.enter(join);
    return this.emit('load', [], e.span, 'Boolean', { slot: tmp });
  }
}
