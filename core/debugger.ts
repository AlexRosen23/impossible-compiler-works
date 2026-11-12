// Debug session over one scene frame: instruction stepping, line stepping (in / over / out), line
// breakpoints, and time travel. Rewinding restores the nearest checkpoint and re-executes forward; because the
// VM is deterministic, `proveReplay(n)` can show that reaching step n by rewinding and by replaying from a
// fresh machine gives byte-identical state. Checkpoint memory is bounded: when the table is full, every other
// checkpoint is dropped and the interval doubles.
import type { BCModule } from './bytecode.ts';
import type { Limits } from './limits.ts';
import type { Value } from './values.ts';
import { decodeValue } from './values.ts';
import { VMRun, type VMSnapshot } from './vm.ts';

export interface DebugPosition { step: number; fn: string; pc: number; line: number; depth: number; status: string }

export class DebugSession {
  vm: VMRun;
  checkpoints: VMSnapshot[] = [];
  interval: number;
  readonly maxCheckpoints: number;
  private consts: Value[];
  private m: BCModule;
  private data: Map<string, Value>;
  private limits: Limits;
  readonly frameIndex: number;

  constructor(m: BCModule, data: Map<string, Value>, limits: Limits, frameIndex = 0, interval = 256, maxCheckpoints = 512) {
    this.m = m; this.data = data; this.limits = limits; this.frameIndex = frameIndex;
    this.interval = interval; this.maxCheckpoints = maxCheckpoints;
    this.consts = m.consts.map(decodeValue);
    this.vm = this.fresh();
    this.checkpoints.push(this.vm.snapshot());
  }
  private fresh(): VMRun { return new VMRun(this.m, this.data, this.limits, this.frameIndex, this.consts); }

  position(): DebugPosition {
    const fr = this.vm.frames[this.vm.frames.length - 1];
    const fn = this.m.functions[fr.fn];
    return { step: this.vm.steps, fn: fn.name, pc: fr.pc, line: fn.spans[fr.pc]?.[2] ?? 0, depth: this.vm.frames.length, status: this.vm.status };
  }
  line(): number { return this.position().line; }

  private record() {
    if (this.vm.steps % this.interval !== 0 || this.vm.done) return;
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && last.steps >= this.vm.steps) return;
    this.checkpoints.push(this.vm.snapshot());
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints = this.checkpoints.filter((_, i) => i % 2 === 0);
      this.interval *= 2;
    }
  }

  /** Run until `stop` (checked before each instruction) or `max` instructions; records checkpoints on the way. */
  private advance(stop: (s: DebugSession) => boolean, max: number): void {
    for (let i = 0; i < max && !this.vm.done; i++) {
      if (i > 0 && stop(this)) return;
      this.vm.run(1);
      this.record();
    }
  }
  stepInstruction(): void { this.advance(() => false, 1); }
  /** Step in: run to the next instruction on a different source line (any call depth). */
  stepIn(): void { const l0 = this.line(), d0 = this.vm.frames.length; this.advance((s) => s.line() !== l0 || s.vm.frames.length !== d0, 1_000_000); }
  /** Step over: like step in, but runs whole calls made from this line. */
  stepOver(): void { const l0 = this.line(), d0 = this.vm.frames.length; this.advance((s) => s.vm.frames.length < d0 || (s.vm.frames.length === d0 && s.line() !== l0), 1_000_000); }
  stepOut(): void { const d0 = this.vm.frames.length; if (d0 <= 1) { this.continue(new Set()); return; } this.advance((s) => s.vm.frames.length < d0, 10_000_000); }
  /** Continue to the next breakpoint line (entering a breakpoint line from a different line), or the end. */
  continue(breakLines: Set<number>): void {
    let prev = this.line();
    this.advance((s) => { const l = s.line(); const hit = l !== prev && breakLines.has(l); prev = l; return hit; }, 50_000_000);
  }

  /** Time travel: restore the nearest checkpoint at or before `step` and re-execute forward. */
  goto(step: number): void {
    const target = Math.max(0, step);
    let cp = this.checkpoints[0];
    for (const c of this.checkpoints) if (c.steps <= target && c.steps >= cp.steps) cp = c;
    this.vm.restore(cp);
    this.advance(() => false, target - cp.steps);
  }

  /** Proof of deterministic replay: state hash at `step` via checkpoint+rewind vs via a brand-new machine. */
  proveReplay(step: number): { step: number; viaCheckpoint: string; viaFreshReplay: string; equal: boolean } {
    const here = this.vm.steps;
    this.goto(step);
    const a = this.vm.stateHash();
    const reached = this.vm.steps;
    const vm2 = this.fresh();
    vm2.run(reached);
    const b = vm2.stateHash();
    this.goto(here);
    return { step: reached, viaCheckpoint: a, viaFreshReplay: b, equal: a === b };
  }

  /** Source lines that hold at least one instruction (where a breakpoint can bind). */
  breakableLines(): number[] {
    const s = new Set<number>();
    for (const f of this.m.functions) for (const sp of f.spans) if (sp[2] > 0) s.add(sp[2]);
    return [...s].sort((a, b) => a - b);
  }
}
