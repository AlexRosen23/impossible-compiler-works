// Bytecode: a compact stack-machine encoding of the (optimized) IR, plus serialization and a verifier.
// Code is a flat array of [opcode, a, b] triples; pc counts triples. Every instruction keeps its IR id and
// source span in parallel debug tables, which is what lets the debugger map the instruction pointer back to
// the source line. A serialized module carries a content hash; loading recomputes it and then verifies
// structure (opcodes, operand ranges, jump targets, stack discipline) before anything runs.
import { BUILTINS } from './builtins.ts';
import type { Span } from './diagnostics.ts';
import type { IRFunction, IRModule, Instr, Operand } from './ir.ts';
import type { Limits } from './limits.ts';
import { PRIMITIVE_KINDS, PRIMITIVES } from './primitives.ts';
import { canonicalJson, sha256 } from './sha256.ts';
import { type EncodedValue, type Value, decodeValue, encodeValue } from './values.ts';
import { BYTECODE_VERSION } from './version.ts';

export const OPCODES = [
  'CONST', 'LOADR', 'STORER', 'LOADS', 'STORES', 'GLOBAL',
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG', 'CONCAT',
  'LT', 'LE', 'GT', 'GE', 'EQ', 'NE', 'NOT',
  'CALLB', 'CALLF', 'LIST', 'INDEX', 'FIELD', 'LEN',
  'DRAW', 'GPUSH', 'GPOP', 'ASSERT', 'TICK', 'RANGECHK',
  'JMP', 'JMPF', 'RET', 'HALT',
] as const;
export type Opcode = (typeof OPCODES)[number];
export const OPC = Object.fromEntries(OPCODES.map((o, i) => [o, i])) as Record<Opcode, number>;
export const FIELDS = ['x', 'y', 'r', 'g', 'b', 'a'];
export const BUILTIN_NAMES = Object.keys(BUILTINS);

export interface BCFunction {
  name: string;
  nparams: number;
  nregs: number;
  nslots: number;
  slotNames: string[];
  code: number[];
  /** Per instruction: [start, end, line, col] and the IR instruction id (-1 for terminators/glue). */
  spans: [number, number, number, number][];
  ir: number[];
}
export interface BCModule {
  format: 'folio-bc';
  version: string;
  scene: { title: string; width: number; height: number; frames: number; background: string };
  data: { name: string; type: string }[];
  consts: EncodedValue[];
  functions: BCFunction[];
  main: number;
}
export interface SerializedBC extends BCModule { hash: string }

export function stackEffect(op: Opcode, a: number): { pop: number; push: number } {
  switch (op) {
    case 'CONST': case 'LOADR': case 'LOADS': case 'GLOBAL': return { pop: 0, push: 1 };
    case 'STORER': case 'STORES': case 'ASSERT': case 'JMPF': return { pop: 1, push: 0 };
    case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'MOD': case 'CONCAT':
    case 'LT': case 'LE': case 'GT': case 'GE': case 'EQ': case 'NE': case 'INDEX': return { pop: 2, push: 1 };
    case 'NEG': case 'NOT': case 'FIELD': case 'LEN': return { pop: 1, push: 1 };
    case 'CALLB': case 'CALLF': return { pop: a, push: 1 };
    case 'LIST': return { pop: a, push: 1 };
    case 'DRAW': return { pop: PRIMITIVES[PRIMITIVE_KINDS[a]]?.params.length ?? 0, push: 0 };
    case 'GPUSH': return { pop: 4, push: 0 };
    case 'RANGECHK': return { pop: 2, push: 0 };
    case 'RET': return { pop: 1, push: 0 };
    case 'GPOP': case 'TICK': case 'JMP': case 'HALT': return { pop: 0, push: 0 };
  }
}

// --- codegen ------------------------------------------------------------------------------------
export function codegen(m: IRModule): BCModule {
  const consts: EncodedValue[] = [];
  const constIndex = new Map<string, number>();
  const k = (v: Value) => {
    const e = encodeValue(v);
    const key = canonicalJson(e);
    let i = constIndex.get(key);
    if (i === undefined) { i = consts.length; consts.push(e); constIndex.set(key, i); }
    return i;
  };
  const fnIndex = new Map(m.functions.map((f, i) => [f.name, i]));
  const functions = m.functions.map((f) => genFn(f, k, fnIndex));
  return { format: 'folio-bc', version: BYTECODE_VERSION, scene: { ...m.scene }, data: m.data.map((d) => ({ ...d })), consts, functions, main: m.main };
}

function genFn(f: IRFunction, k: (v: Value) => number, fnIndex: Map<string, number>): BCFunction {
  const code: number[] = [];
  const spans: BCFunction['spans'] = [];
  const ir: number[] = [];
  const fixups: { at: number; block: number }[] = [];
  const blockPc = new Map<number, number>();
  const emit = (op: Opcode, a: number, b: number, span: Span, irId: number) => {
    code.push(OPC[op], a, b);
    spans.push([span.start, span.end, span.line, span.col]);
    ir.push(irId);
  };
  const push = (o: Operand, span: Span, id: number) => (o.k === 'r' ? emit('LOADR', o.id, 0, span, id) : emit('CONST', k(o.v), 0, span, id));
  const pc = () => code.length / 3;
  const binop: Record<string, Opcode> = { add: 'ADD', sub: 'SUB', mul: 'MUL', div: 'DIV', mod: 'MOD', concat: 'CONCAT', lt: 'LT', le: 'LE', gt: 'GT', ge: 'GE', eq: 'EQ', ne: 'NE', index: 'INDEX', neg: 'NEG', not: 'NOT', len: 'LEN' };
  f.blocks.forEach((b, bi) => {
    blockPc.set(b.id, pc());
    for (const i of b.instrs) genInstr(i);
    const t = b.term;
    const next = f.blocks[bi + 1]?.id;
    if (t.op === 'jmp') { if (t.target !== next) { fixups.push({ at: pc(), block: t.target }); emit('JMP', 0, 0, t.span, -1); } }
    else if (t.op === 'br') {
      push(t.cond, t.span, -1);
      fixups.push({ at: pc(), block: t.f }); emit('JMPF', 0, 0, t.span, -1);
      if (t.t !== next) { fixups.push({ at: pc(), block: t.t }); emit('JMP', 0, 0, t.span, -1); }
    } else if (t.op === 'ret') { push(t.value, t.span, -1); emit('RET', 0, 0, t.span, -1); }
    else emit('HALT', 0, 0, t.span, -1);
  });
  for (const fx of fixups) code[fx.at * 3 + 1] = blockPc.get(fx.block)!;
  return { name: f.name, nparams: f.nparams, nregs: f.nregs, nslots: f.slots.length, slotNames: f.slots.map((s) => s.name), code, spans, ir };

  function genInstr(i: Instr) {
    const s = i.span, id = i.id;
    const store = () => { if (i.dst !== null) emit('STORER', i.dst, 0, s, id); };
    switch (i.op) {
      case 'mov': push(i.args[0], s, id); store(); return;
      case 'load': emit('LOADS', i.meta.slot!, 0, s, id); store(); return;
      case 'store': push(i.args[0], s, id); emit('STORES', i.meta.slot!, 0, s, id); return;
      case 'global': emit('GLOBAL', i.meta.global!, 0, s, id); store(); return;
      case 'callb': for (const a of i.args) push(a, s, id); emit('CALLB', BUILTIN_NAMES.indexOf(i.meta.name!), i.args.length, s, id); store(); return;
      case 'callf': for (const a of i.args) push(a, s, id); emit('CALLF', fnIndex.get(i.meta.name!)!, i.args.length, s, id); store(); return;
      case 'list': for (const a of i.args) push(a, s, id); emit('LIST', i.args.length, 0, s, id); store(); return;
      case 'field': push(i.args[0], s, id); emit('FIELD', FIELDS.indexOf(i.meta.field!), 0, s, id); store(); return;
      case 'draw': for (const a of i.args) push(a, s, id); emit('DRAW', PRIMITIVE_KINDS.indexOf(i.meta.kind!), 0, s, id); return;
      case 'gpush': for (const a of i.args) push(a, s, id); emit('GPUSH', 0, 0, s, id); return;
      case 'gpop': emit('GPOP', 0, 0, s, id); return;
      case 'assert': push(i.args[0], s, id); emit('ASSERT', i.meta.message !== undefined ? k(i.meta.message) : -1, 0, s, id); return;
      case 'tick': emit('TICK', 0, 0, s, id); return;
      case 'rangechk': for (const a of i.args) push(a, s, id); emit('RANGECHK', 0, 0, s, id); return;
      default: {
        for (const a of i.args) push(a, s, id);
        emit(binop[i.op], 0, 0, s, id);
        store();
      }
    }
  }
}

// --- serialization --------------------------------------------------------------------------------
export function bytecodeHash(m: BCModule): string {
  const { ...rest } = m as BCModule & { hash?: string };
  delete (rest as { hash?: string }).hash;
  return sha256(canonicalJson(rest));
}
export function serialize(m: BCModule): SerializedBC { return { ...m, hash: bytecodeHash(m) }; }

/** Load untrusted serialized bytecode: hash check, then structural verification. Returns errors (empty = ok). */
export function loadBytecode(json: unknown, limits: Limits): { module: BCModule | null; errors: string[] } {
  const s = json as SerializedBC;
  if (!s || typeof s !== 'object') return { module: null, errors: ['not an object'] };
  if (s.format !== 'folio-bc') return { module: null, errors: ['not FOLIO bytecode (format field)'] };
  if (s.version !== BYTECODE_VERSION) return { module: null, errors: [`incompatible bytecode version ${String(s.version)}; this VM runs ${BYTECODE_VERSION}`] };
  let h: string;
  try { h = bytecodeHash(s); } catch { return { module: null, errors: ['bytecode is not canonical JSON (non-finite numbers?)'] }; }
  if (h !== s.hash) return { module: null, errors: [`content hash mismatch: the bytecode was modified after it was produced (expected ${String(s.hash).slice(0, 12)}…, computed ${h.slice(0, 12)}…)`] };
  const errors = verifyBytecode(s, limits);
  return { module: errors.length ? null : s, errors };
}

/**
 * Structural verification: header and scene fields, table sizes, whole-number operands in range, jump targets,
 * consistent stack depth, terminators and an acyclic call graph. Any module, however malformed, gets a list of
 * problems back, never an exception.
 */
export function verifyBytecode(m: BCModule, limits: Limits): string[] {
  try {
    return verifyUnchecked(m, limits);
  } catch (e) {
    return [`malformed module (${String((e as Error)?.message ?? e).slice(0, 120)})`];
  }
}

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function verifyUnchecked(m: BCModule, limits: Limits): string[] {
  const errs: string[] = [];
  if (!m || typeof m !== 'object') return ['not an object'];
  if (!Array.isArray(m.functions) || !Array.isArray(m.consts) || !Array.isArray(m.data)) return ['missing functions, consts or data'];
  if (m.functions.length < 1 || m.functions.length > limits.maxSymbols) return [`${m.functions.length} functions; expected 1 to ${limits.maxSymbols}`];
  if (m.consts.length > limits.maxBytecodeInstrs || m.data.length > limits.maxSymbols) return ['constant or data table too large'];
  const sc = m.scene;
  if (!sc || typeof sc !== 'object' || typeof sc.title !== 'string' || sc.title.length > limits.maxStringLength) errs.push('bad scene header');
  else {
    if (!isInt(sc.width, 1, limits.maxCanvas) || !isInt(sc.height, 1, limits.maxCanvas)) errs.push('scene size out of range');
    if (!isInt(sc.frames, 1, limits.maxFrames)) errs.push('scene frame count out of range');
    if (typeof sc.background !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(sc.background)) errs.push('bad scene background');
  }
  if (!m.data.every((d) => d && typeof d === 'object' && typeof d.name === 'string' && d.name.length <= 64)) errs.push('bad data table');
  for (const f of m.functions) {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string' || f.name.length > 200) return ['bad function record'];
    if (!Array.isArray(f.code) || !Array.isArray(f.spans) || !Array.isArray(f.ir) || !Array.isArray(f.slotNames)) return [`${f.name}: missing code or debug tables`];
    // Slots come from declarations and registers from IR values; the VM also charges every frame it allocates.
    if (!isInt(f.nparams, 0, 64) || !isInt(f.nslots, f.nparams, limits.maxSymbols + 2) || !isInt(f.nregs, 0, limits.maxBytecodeInstrs)) errs.push(`${f.name}: parameter, slot or register count out of range`);
    if (f.slotNames.length !== f.nslots || !f.slotNames.every((n) => typeof n === 'string')) errs.push(`${f.name}: slot names do not match the slot count`);
    if (!f.spans.every((sp) => Array.isArray(sp) && sp.length === 4 && sp.every((x) => Number.isInteger(x)))) errs.push(`${f.name}: bad span table`);
  }
  if (errs.length) return errs;
  if (!(Number.isInteger(m.main) && m.main >= 0 && m.main < m.functions.length)) errs.push('main index out of range');
  for (const c of m.consts) { try { decodeValue(c); } catch { errs.push('undecodable constant'); } }
  let total = 0;
  m.functions.forEach((f, fi) => {
    const where = (pc: number) => `${f.name}@${pc}`;
    if (!Array.isArray(f.code) || f.code.length % 3 !== 0) { errs.push(`${f.name}: code is not a list of triples`); return; }
    const n = f.code.length / 3;
    total += n;
    if (f.spans?.length !== n || f.ir?.length !== n) errs.push(`${f.name}: debug tables do not match code length`);
    if (!(f.nparams <= f.nslots)) errs.push(`${f.name}: more params than slots`);
    if (fi === m.main && f.nslots < 2) errs.push(`${f.name}: scene function needs time and frame input slots`);
    const depthAt = new Array<number>(n).fill(-1);
    const work: [number, number][] = [[0, 0]];
    while (work.length) {
      const [pc, d] = work.pop()!;
      if (pc < 0 || pc >= n) { errs.push(`${f.name}: control reaches past the end of the code`); continue; }
      if (depthAt[pc] !== -1) { if (depthAt[pc] !== d) errs.push(`${where(pc)}: inconsistent stack depth (${depthAt[pc]} vs ${d})`); continue; }
      depthAt[pc] = d;
      const opn = f.code[pc * 3], a = f.code[pc * 3 + 1], b = f.code[pc * 3 + 2];
      if (!isInt(opn, 0, OPCODES.length - 1)) { errs.push(`${where(pc)}: unknown opcode ${String(opn).slice(0, 20)}`); continue; }
      const op = OPCODES[opn];
      if (!isInt(a, -1, 2 ** 31) || !isInt(b, 0, 2 ** 31)) { errs.push(`${where(pc)} ${op}: operands must be whole numbers`); continue; }
      const bad = (msg: string) => errs.push(`${where(pc)} ${op}: ${msg}`);
      switch (op) {
        case 'CONST': if (!(a >= 0 && a < m.consts.length)) bad('constant index out of range'); break;
        case 'LOADR': case 'STORER': if (!(a >= 0 && a < f.nregs)) bad('register out of range'); break;
        case 'LOADS': case 'STORES': if (!(a >= 0 && a < f.nslots)) bad('slot out of range'); break;
        case 'GLOBAL': if (!(a >= 0 && a < m.data.length)) bad('global out of range'); break;
        case 'CALLB': if (!(a >= 0 && a < BUILTIN_NAMES.length) || BUILTINS[BUILTIN_NAMES[a]].params.length !== b) bad('bad builtin or argument count'); break;
        case 'CALLF': if (!(a >= 0 && a < m.functions.length) || a === m.main || m.functions[a].nparams !== b) bad('bad function or argument count'); break;
        case 'LIST': if (!(a >= 0 && a <= limits.maxListLiteral)) bad('list size out of range'); break;
        case 'FIELD': if (!(a >= 0 && a < FIELDS.length)) bad('bad field'); break;
        case 'DRAW': if (!(a >= 0 && a < PRIMITIVE_KINDS.length)) bad('bad primitive'); break;
        case 'ASSERT': if (!(a === -1 || (a >= 0 && a < m.consts.length && typeof m.consts[a] === 'string'))) bad('bad message constant'); break;
        case 'JMP': case 'JMPF': if (!(Number.isInteger(a) && a >= 0 && a < n)) bad('jump target out of range'); break;
      }
      const eff = stackEffect(op, op === 'DRAW' ? a : op === 'CALLB' || op === 'CALLF' ? b : a);
      if (d < eff.pop) { bad(`stack underflow (depth ${d}, pops ${eff.pop})`); continue; }
      const nd = d - eff.pop + eff.push;
      if (nd > limits.maxStack) { bad('stack too deep'); continue; }
      if (op === 'RET') { if (fi === m.main) bad('RET in the scene function'); if (d !== 1) bad(`RET with stack depth ${d}`); continue; }
      if (op === 'HALT') { if (d !== 0) bad(`HALT with stack depth ${d}`); continue; }
      if (op === 'JMP') { work.push([a, nd]); continue; }
      if (op === 'JMPF') { work.push([a, nd]); work.push([pc + 1, nd]); continue; }
      work.push([pc + 1, nd]);
      if (errs.length > 50) return;
    }
  });
  if (total > limits.maxBytecodeInstrs) errs.push(`${total} instructions; the limit is ${limits.maxBytecodeInstrs}`);
  // No recursion at the bytecode level either (the VM's call-depth limit is a second line of defence).
  const calls = m.functions.map((f) => { const s = new Set<number>(); for (let p = 0; p < f.code.length; p += 3) if (f.code[p] === OPC.CALLF) s.add(f.code[p + 1]); return [...s]; });
  // Iterative depth-first search (a crafted module can chain thousands of functions).
  const state = new Array<number>(m.functions.length).fill(0);
  for (let root = 0; root < m.functions.length && !errs.length; root++) {
    if (state[root]) continue;
    const stack: [number, number][] = [[root, 0]];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [i, k] = top;
      if (k >= calls[i].length) { state[i] = 2; stack.pop(); continue; }
      top[1]++;
      const j = calls[i][k];
      if (state[j] === 1) { errs.push('call graph has a cycle (recursion)'); break; }
      if (!state[j]) { state[j] = 1; stack.push([j, 0]); }
    }
  }
  return errs;
}

export interface DisasmLine { pc: number; op: string; a: number; b: number; text: string; line: number; ir: number; effect: string }
export function disassemble(m: BCModule, fi: number): DisasmLine[] {
  const f = m.functions[fi];
  const out: DisasmLine[] = [];
  for (let pc = 0; pc < f.code.length / 3; pc++) {
    const op = OPCODES[f.code[pc * 3]];
    const a = f.code[pc * 3 + 1], b = f.code[pc * 3 + 2];
    let text: string = op;
    switch (op) {
      case 'CONST': text = `CONST ${JSON.stringify(m.consts[a])}`; break;
      case 'LOADR': case 'STORER': text = `${op} %${a}`; break;
      case 'LOADS': case 'STORES': text = `${op} $${a} (${f.slotNames[a]})`; break;
      case 'GLOBAL': text = `GLOBAL ${m.data[a]?.name}`; break;
      case 'CALLB': text = `CALLB ${BUILTIN_NAMES[a]}/${b}`; break;
      case 'CALLF': text = `CALLF ${m.functions[a]?.name}/${b}`; break;
      case 'LIST': text = `LIST ${a}`; break;
      case 'FIELD': text = `FIELD .${FIELDS[a]}`; break;
      case 'DRAW': text = `DRAW ${PRIMITIVE_KINDS[a]}`; break;
      case 'ASSERT': text = a >= 0 ? `ASSERT ${JSON.stringify(m.consts[a])}` : 'ASSERT'; break;
      case 'JMP': case 'JMPF': text = `${op} → ${a}`; break;
    }
    const e = stackEffect(op, op === 'DRAW' ? a : op === 'CALLB' || op === 'CALLF' ? b : a);
    out.push({ pc, op, a, b, text, line: f.spans[pc][2], ir: f.ir[pc], effect: `-${e.pop} +${e.push}` });
  }
  return out;
}
