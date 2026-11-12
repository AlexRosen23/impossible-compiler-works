// The FOLIO virtual machine: a hand-written bounded evaluator for verified bytecode. Explicit frame stack (no
// host recursion), per-instruction fuel, operand-stack and call-depth limits, and no host access besides the
// vetted pure built-ins and the scene builder. The same class serves batch runs and the step debugger.
import { BUILTIN_NAMES, type BCModule, FIELDS, OPCODES } from './bytecode.ts';
import type { Span } from './diagnostics.ts';
import type { RunFault, RunResult } from './interpreter.ts';
import type { Limits } from './limits.ts';
import { evalPure } from './ops.ts';
import { PRIMITIVE_KINDS, PRIMITIVES } from './primitives.ts';
import { type DrawCmd, type Frame, SceneBuilder } from './scene.ts';
import { type SceneSnap, restoreScene, snapScene } from './scene-snap.ts';
import { canonicalJson, sha256 } from './sha256.ts';
import { type FaultCode, FaultSignal, FolioFault, type PointV, type Value, decodeValue, encodeValue, showValue } from './values.ts';
import { SCENE_FORMAT } from './version.ts';

export interface CallFrame { fn: number; pc: number; regs: Value[]; slots: Value[]; stack: Value[] }
export type VMStatus = 'ready' | 'running' | 'halted' | 'fault';

const OPS = OPCODES;
const BIN_IR: Record<string, string> = { ADD: 'add', SUB: 'sub', MUL: 'mul', DIV: 'div', MOD: 'mod', CONCAT: 'concat', LT: 'lt', LE: 'le', GT: 'gt', GE: 'ge', EQ: 'eq', NE: 'ne', INDEX: 'index' };

/** One frame of execution (one value of `time`). */
export class VMRun {
  frames: CallFrame[] = [];
  scene: SceneBuilder;
  steps = 0;
  iterations = 0;
  status: VMStatus = 'ready';
  fault: FolioFault | null = null;
  /** Rolling FNV-1a over executed (fn, pc): a cheap fingerprint of the exact instruction trace. */
  traceFp = 0x811c9dc5;
  readonly consts: Value[];
  readonly m: BCModule;
  readonly data: Value[];
  readonly limits: Limits;
  readonly frameIndex: number;
  readonly time: number;

  constructor(m: BCModule, data: Map<string, Value>, limits: Limits, frameIndex: number, consts?: Value[]) {
    this.m = m; this.limits = limits; this.frameIndex = frameIndex;
    this.time = frameIndex / m.scene.frames;
    this.consts = consts ?? m.consts.map(decodeValue);
    this.data = m.data.map((d) => data.get(d.name) ?? Object.freeze([]));
    this.scene = new SceneBuilder(limits);
    const main = m.functions[m.main];
    const slots: Value[] = new Array(main.nslots).fill(0);
    slots[0] = this.time; slots[1] = frameIndex;
    this.frames.push({ fn: m.main, pc: 0, regs: new Array(main.nregs).fill(0), slots, stack: [] });
  }

  get done(): boolean { return this.status === 'halted' || this.status === 'fault'; }

  currentSpan(): Span | null {
    const fr = this.frames[this.frames.length - 1];
    if (!fr) return null;
    const s = this.m.functions[fr.fn].spans[fr.pc];
    return s ? { start: s[0], end: s[1], line: s[2], col: s[3] } : null;
  }

  private die(code: FaultCode, message: string) {
    this.fault = new FolioFault(code, message, this.currentSpan());
    this.status = 'fault';
  }

  /** Execute up to `max` instructions; stops early on halt, fault, or when `stop(this)` returns true *before* an instruction. */
  run(max = Infinity, stop?: (vm: VMRun) => boolean): void {
    if (this.done) return;
    this.status = 'running';
    const fuel = this.limits.fuelPerFrame;
    let budget = max;
    while (budget-- > 0) {
      if (stop && stop(this)) return;
      const fr = this.frames[this.frames.length - 1];
      const fn = this.m.functions[fr.fn];
      const code = fn.code;
      const pc = fr.pc;
      if (++this.steps > fuel) { this.die('R006', `used more than ${fuel} instructions in one frame`); return; }
      this.traceFp = Math.imul(this.traceFp ^ (fr.fn * 65599 + pc), 16777619) >>> 0;
      const op = OPS[code[pc * 3]];
      const a = code[pc * 3 + 1];
      const st = fr.stack;
      fr.pc = pc + 1;
      try {
        switch (op) {
          case 'CONST': st.push(this.consts[a]); break;
          case 'LOADR': st.push(fr.regs[a]); break;
          case 'STORER': fr.regs[a] = st.pop()!; break;
          case 'LOADS': st.push(fr.slots[a]); break;
          case 'STORES': fr.slots[a] = st.pop()!; break;
          case 'GLOBAL': st.push(this.data[a]); break;
          case 'NEG': st.push(-(st.pop() as number)); break;
          case 'NOT': st.push(!(st.pop() as boolean)); break;
          case 'LEN': st.push((st.pop() as Value[]).length); break;
          case 'FIELD': st.push(evalPure('field', [st.pop()!], { field: FIELDS[a] }, this.limits.maxStringLength)); break;
          case 'CALLB': {
            const n = code[pc * 3 + 2];
            const args = st.splice(st.length - n, n);
            st.push(evalPure('callb', args, { name: BUILTIN_NAMES[a] }, this.limits.maxStringLength));
            break;
          }
          case 'LIST': { const items = st.splice(st.length - a, a); st.push(Object.freeze(items)); break; }
          case 'CALLF': {
            const n = code[pc * 3 + 2];
            if (this.frames.length >= this.limits.maxCallDepth) { fr.pc = pc; this.die('R007', `call depth over ${this.limits.maxCallDepth}`); return; }
            const callee = this.m.functions[a];
            const slots: Value[] = new Array(callee.nslots).fill(0);
            const args = st.splice(st.length - n, n);
            for (let i = 0; i < n; i++) slots[i] = args[i];
            this.frames.push({ fn: a, pc: 0, regs: new Array(callee.nregs).fill(0), slots, stack: [] });
            break;
          }
          case 'RET': {
            const v = st.pop()!;
            this.frames.pop();
            const caller = this.frames[this.frames.length - 1];
            if (!caller) { this.die('R012', 'return with no caller'); return; }
            caller.stack.push(v);
            break;
          }
          case 'DRAW': {
            const kind = PRIMITIVE_KINDS[a] as DrawCmd['k'];
            const arity = drawArity(kind);
            const args = st.splice(st.length - arity, arity);
            this.scene.draw(kind, args);
            break;
          }
          case 'GPUSH': {
            const [t, r, s, o] = st.splice(st.length - 4, 4);
            this.scene.pushGroup(t as PointV, r as number, s as number, o as number);
            break;
          }
          case 'GPOP': this.scene.popGroup(); break;
          case 'ASSERT': {
            const c = st.pop() as boolean;
            if (!c) { fr.pc = pc; this.die('R003', a >= 0 ? (this.consts[a] as string) : 'assertion failed'); return; }
            break;
          }
          case 'TICK':
            if (++this.iterations > this.limits.maxIterationsPerFrame) { fr.pc = pc; this.die('R004', `more than ${this.limits.maxIterationsPerFrame} loop iterations in one frame`); return; }
            break;
          case 'RANGECHK': {
            const hi = st.pop() as number, lo = st.pop() as number;
            if (!Number.isInteger(lo) || !Number.isInteger(hi)) { fr.pc = pc; this.die('R008', `range ${lo}..${hi} has a bound that is not a whole number`); return; }
            break;
          }
          case 'JMP': fr.pc = a; break;
          case 'JMPF': if (!(st.pop() as boolean)) fr.pc = a; break;
          case 'HALT':
            fr.pc = pc;
            if (this.frames.length !== 1) { this.die('R012', 'HALT inside a function'); return; }
            this.status = 'halted';
            return;
          default: {
            const irop = BIN_IR[op];
            if (!irop) { fr.pc = pc; this.die('R012', `unknown opcode ${String(op)}`); return; }
            const r = st.pop()!, l = st.pop()!;
            st.push(evalPure(irop as never, [l, r], {}, this.limits.maxStringLength));
          }
        }
      } catch (e) {
        if (e instanceof FaultSignal) { fr.pc = pc; this.die(e.code, e.message); return; }
        throw e;
      }
      if (st.length > this.limits.maxStack) { this.die('R007', 'operand stack overflow'); return; }
    }
  }

  // --- debugger support -------------------------------------------------------------------------
  snapshot(): VMSnapshot {
    return {
      frames: this.frames.map((f) => ({ fn: f.fn, pc: f.pc, regs: f.regs.slice(), slots: f.slots.slice(), stack: f.stack.slice() })),
      scene: snapScene(this.scene), steps: this.steps, iterations: this.iterations, status: this.status, fault: this.fault, traceFp: this.traceFp,
    };
  }
  restore(s: VMSnapshot): void {
    this.frames = s.frames.map((f) => ({ fn: f.fn, pc: f.pc, regs: f.regs.slice(), slots: f.slots.slice(), stack: f.stack.slice() }));
    restoreScene(this.scene, s.scene);
    this.steps = s.steps; this.iterations = s.iterations; this.status = s.status; this.fault = s.fault; this.traceFp = s.traceFp;
  }
  /** Canonical hash of the full machine state: proves that two ways of reaching step N agree exactly. */
  stateHash(): string {
    return sha256(canonicalJson({
      frames: this.frames.map((f) => ({ fn: f.fn, pc: f.pc, regs: f.regs.map(encodeValue), slots: f.slots.map(encodeValue), stack: f.stack.map(encodeValue) })),
      cmds: this.scene.cmds, steps: this.steps, iterations: this.iterations, status: this.status, fp: this.traceFp,
      fault: this.fault ? { code: this.fault.code, span: this.fault.span } : null,
    }));
  }
  describe(): { fn: string; pc: number; line: number; slots: { name: string; value: string }[]; regs: string[]; stack: string[] }[] {
    return this.frames.map((f) => {
      const fn = this.m.functions[f.fn];
      return {
        fn: fn.name, pc: f.pc, line: fn.spans[f.pc]?.[2] ?? 0,
        slots: fn.slotNames.map((n, i) => ({ name: n, value: showValue(f.slots[i]) })),
        regs: f.regs.map(showValue), stack: f.stack.map(showValue),
      };
    }).reverse();
  }
}

export interface VMSnapshot { frames: CallFrame[]; scene: SceneSnap; steps: number; iterations: number; status: VMStatus; fault: FolioFault | null; traceFp: number }

const ARITY_CACHE = new Map<string, number>();
function drawArity(kind: string): number {
  let n = ARITY_CACHE.get(kind);
  if (n === undefined) { n = PRIMITIVES[kind].params.length; ARITY_CACHE.set(kind, n); }
  return n;
}

export interface VMResult extends RunResult { steps: number[]; traceHash: string }

/** Run every frame (or one) to completion; stops at the first faulting frame, like the reference interpreter. */
export function runVM(m: BCModule, data: Map<string, Value>, limits: Limits, onlyFrame?: number): VMResult {
  const frames: Frame[] = [];
  const steps: number[] = [];
  const fps: number[] = [];
  let fault: RunFault | null = null;
  let iterations = 0, draws = 0;
  const consts = m.consts.map(decodeValue);
  const indices = onlyFrame === undefined ? Array.from({ length: m.scene.frames }, (_, i) => i) : [onlyFrame];
  for (const f of indices) {
    const vm = new VMRun(m, data, limits, f, consts);
    vm.run();
    frames.push({ index: f, time: vm.time, cmds: vm.scene.cmds });
    steps.push(vm.steps); fps.push(vm.traceFp);
    iterations += vm.iterations; draws += vm.scene.cmds.length;
    if (vm.fault) { fault = { code: vm.fault.code, message: vm.fault.message, span: vm.fault.span, frame: f }; break; }
  }
  return {
    scene: { format: SCENE_FORMAT, title: m.scene.title, width: m.scene.width, height: m.scene.height, background: m.scene.background, frames },
    fault, stats: { iterations, draws }, steps, traceHash: sha256(canonicalJson({ steps, fps, fault: fault ? { code: fault.code, frame: fault.frame } : null })),
  };
}
