// FOLIO IR: a typed, register-based three-address code in basic blocks.
//   - Registers are single-assignment: each register has exactly one defining instruction, and that
//     definition dominates every use (the verifier checks both). There are no phi nodes: values that merge
//     across control flow (var bindings, loop counters, short-circuit results) live in numbered frame slots
//     accessed with load/store.
//   - Every instruction carries a stable id and the source span it came from.
import type { Span } from './diagnostics.ts';
import { type EncodedValue, type Value, decodeValue, encodeValue, showValue } from './values.ts';

export type Operand = { k: 'r'; id: number } | { k: 'c'; v: Value };
export type Op =
  | 'mov' | 'add' | 'sub' | 'mul' | 'div' | 'mod' | 'neg' | 'concat'
  | 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne' | 'not'
  | 'callb' | 'callf' | 'list' | 'index' | 'field' | 'len' | 'global'
  | 'load' | 'store' | 'draw' | 'gpush' | 'gpop' | 'assert' | 'tick' | 'rangechk';

export interface InstrMeta { name?: string; slot?: number; field?: string; kind?: string; message?: string; binding?: string; global?: number }
export interface Instr { id: number; op: Op; dst: number | null; args: Operand[]; meta: InstrMeta; span: Span; type: string | null }
export type Terminator =
  | { op: 'jmp'; target: number; span: Span }
  | { op: 'br'; cond: Operand; t: number; f: number; span: Span }
  | { op: 'ret'; value: Operand; span: Span }
  | { op: 'halt'; span: Span };
export interface BasicBlock { id: number; label: string; instrs: Instr[]; term: Terminator }
export interface Slot { name: string; type: string; kind: 'param' | 'var' | 'loop' | 'hidden' | 'input' }
export interface IRFunction { name: string; nparams: number; slots: Slot[]; nregs: number; blocks: BasicBlock[]; ret: string | null; regTypes: (string | null)[] }
export interface IRModule {
  version: string;
  scene: { title: string; width: number; height: number; frames: number; background: string };
  data: { name: string; type: string }[];
  functions: IRFunction[];
  /** Index of the scene function in `functions`. */
  main: number;
  nextInstrId: number;
}

/** Ops with no observable effect besides their result. `mayFault` ops can still raise a runtime fault. */
export const PURE_OPS = new Set<Op>(['mov', 'add', 'sub', 'mul', 'div', 'mod', 'neg', 'concat', 'lt', 'le', 'gt', 'ge', 'eq', 'ne', 'not', 'callb', 'list', 'index', 'field', 'len', 'global']);
export const FAULTING_OPS = new Set<Op>(['add', 'sub', 'mul', 'div', 'mod', 'concat', 'index', 'callb']);
/** Built-ins that cannot fault on any finite input (removable when unused). */
export const NONFAULTING_BUILTINS = new Set(['sin', 'cos', 'abs', 'floor', 'ceil', 'round', 'sign', 'min', 'max', 'clamp', 'point', 'rgb', 'rgba', 'hsl', 'mix', 'alpha', 'str', 'fmt']);
export const COMMUTATIVE = new Set<Op>(['add', 'mul', 'eq', 'ne']);

export function canFault(i: Instr): boolean {
  if (i.op === 'callb') return !NONFAULTING_BUILTINS.has(i.meta.name!);
  return FAULTING_OPS.has(i.op);
}

export function successors(t: Terminator): number[] {
  return t.op === 'jmp' ? [t.target] : t.op === 'br' ? [t.t, t.f] : [];
}

export function cloneModule(m: IRModule): IRModule {
  // Values are immutable, so a structural copy of everything but operand values is enough.
  return {
    ...m,
    data: m.data.map((d) => ({ ...d })),
    functions: m.functions.map((f) => ({
      ...f,
      slots: f.slots.map((s) => ({ ...s })),
      regTypes: [...f.regTypes],
      blocks: f.blocks.map((b) => ({ ...b, instrs: b.instrs.map((i) => ({ ...i, args: i.args.map((a) => ({ ...a })), meta: { ...i.meta } })), term: { ...b.term } as Terminator })),
    })),
  };
}

export function showOperand(o: Operand): string { return o.k === 'r' ? `%${o.id}` : showValue(o.v); }

export function showInstr(i: Instr, f?: IRFunction): string {
  const lhs = i.dst !== null ? `%${i.dst} = ` : '';
  const args = i.args.map(showOperand).join(', ');
  const slot = (s: number) => (f ? `$${s}:${f.slots[s]?.name ?? '?'}` : `$${s}`);
  switch (i.op) {
    case 'callb': case 'callf': return `${lhs}${i.op} ${i.meta.name}(${args})`;
    case 'load': return `${lhs}load ${slot(i.meta.slot!)}`;
    case 'store': return `store ${slot(i.meta.slot!)}, ${args}`;
    case 'field': return `${lhs}field ${args}.${i.meta.field}`;
    case 'draw': return `draw ${i.meta.kind}(${args})`;
    case 'assert': return `assert ${args}${i.meta.message ? `, ${JSON.stringify(i.meta.message)}` : ''}`;
    case 'global': return `${lhs}global ${i.meta.name}`;
    case 'mov': return `${lhs}mov ${args}${i.meta.binding ? `    ; let ${i.meta.binding}` : ''}`;
    default: return `${lhs}${i.op} ${args}`.trimEnd();
  }
}

export function showTerm(t: Terminator, blocks: BasicBlock[]): string {
  const lbl = (id: number) => blocks.find((b) => b.id === id)?.label ?? `b${id}`;
  switch (t.op) {
    case 'jmp': return `jmp ${lbl(t.target)}`;
    case 'br': return `br ${showOperand(t.cond)}, ${lbl(t.t)}, ${lbl(t.f)}`;
    case 'ret': return `ret ${showOperand(t.value)}`;
    case 'halt': return 'halt';
  }
}

/** Plain-text listing (the Lowering Floor shows the structured form; tests and receipts use this). */
export function printModule(m: IRModule): string {
  const out: string[] = [`; ${m.version}  scene "${m.scene.title}" ${m.scene.width}x${m.scene.height} frames ${m.scene.frames}`];
  for (const f of m.functions) {
    out.push('', `fn ${f.name}(${f.slots.slice(0, f.nparams).map((s) => `${s.name}: ${s.type}`).join(', ')})${f.ret ? ` -> ${f.ret}` : ''}  ; ${f.nregs} regs, ${f.slots.length} slots`);
    for (const b of f.blocks) {
      out.push(`  ${b.label}:`);
      for (const i of b.instrs) out.push(`    ${showInstr(i, f)}`.padEnd(48) + `; #${i.id} @${i.span.line}:${i.span.col}`);
      out.push(`    ${showTerm(b.term, f.blocks)}`);
    }
  }
  return out.join('\n');
}

/** JSON-safe form (constants encoded) used for hashing and export. */
export function encodeModule(m: IRModule): unknown {
  const enc = (o: Operand) => (o.k === 'r' ? { r: o.id } : { c: encodeValue(o.v) });
  return {
    ...m,
    functions: m.functions.map((f) => ({
      ...f,
      blocks: f.blocks.map((b) => ({
        ...b,
        instrs: b.instrs.map((i) => ({ ...i, args: i.args.map(enc) })),
        term: b.term.op === 'br' ? { ...b.term, cond: enc(b.term.cond) } : b.term.op === 'ret' ? { ...b.term, value: enc(b.term.value) } : b.term,
      })),
    })),
  };
}
export function decodeOperand(e: { r: number } | { c: EncodedValue }): Operand {
  return 'r' in e ? { k: 'r', id: e.r } : { k: 'c', v: decodeValue(e.c) };
}
