import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS, DebugSession, OPC, compile, loadBytecode, makeReceipt, reproduce, runVM, sceneHash, serialize, sha256,
  validateScene, verifyBytecode, verifyIR, type BCModule,
} from '../core/index.ts';
import { examples, fixtures } from './helpers.ts';

const SRC = 'fn sq(v: Number) -> Number { return v * v; }\nscene "s" frames 3 {\n  repeat i in 0..4 {\n    circle(x: sq(i), y: time * 10, radius: 2);\n  }\n}';

describe('sha256 matches node:crypto', () => {
  it('on assorted inputs', () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ünïcödé 紙の虎 🐯', 'x'.repeat(10_000)]) {
      expect(sha256(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('IR verifier', () => {
  it('accepts lowered and optimized IR for every example', () => {
    for (const ex of examples()) {
      const c = compile(ex.source, { passes: ['constfold', 'dce', 'cse'], fixtures: fixtures() });
      expect(verifyIR(c.ir!)).toEqual([]);
      expect(verifyIR(c.irOptimized!)).toEqual([]);
    }
  });
  it('rejects double definitions, undefined registers and non-dominating uses', () => {
    const c = compile('scene "s" { let a = 1 + time; if a > 1 { let b = a * 2; circle(x: b, y: 1, radius: 1); } }');
    const ir = structuredClone(c.ir!);
    const f = ir.functions[ir.main];
    const then = f.blocks.find((b) => b.label.startsWith('then'))!;
    const def = then.instrs.find((i) => i.dst !== null)!;
    // Use the then-block's register from the entry block: its definition does not dominate.
    f.blocks[0].instrs.push({ ...def, id: 9999, dst: f.nregs, args: [{ k: 'r', id: def.dst! }] });
    f.nregs++;
    expect(verifyIR(ir).join('\n')).toMatch(/does not dominate|used before/);
    const ir2 = structuredClone(c.ir!);
    ir2.functions[ir2.main].blocks[0].instrs.push({ ...def, id: 9998 });
    expect(verifyIR(ir2).join('\n')).toMatch(/defined twice/);
  });
});

describe('bytecode verifier and loader', () => {
  const c = compile(SRC, { passes: ['constfold'] });
  const good = c.bytecode!;
  const mutate = (f: (m: BCModule) => void) => { const m = structuredClone(good) as BCModule & { hash?: string }; delete m.hash; f(m); return verifyBytecode(m, DEFAULT_LIMITS); };
  it('accepts compiler output', () => { expect(verifyBytecode(good, DEFAULT_LIMITS)).toEqual([]); });
  it('rejects unknown opcodes, bad operands, bad jumps and stack-discipline violations', () => {
    expect(mutate((m) => { m.functions[m.main].code[0] = 99; }).join()).toMatch(/unknown opcode/);
    expect(mutate((m) => { const f = m.functions[m.main]; const i = f.code.findIndex((x, k) => k % 3 === 0 && (x === OPC.JMP || x === OPC.JMPF)); f.code[i + 1] = 10_000; }).join()).toMatch(/jump target out of range/);
    expect(mutate((m) => { const f = m.functions[m.main]; const i = f.code.findIndex((x, k) => k % 3 === 0 && x === OPC.CONST); f.code[i + 1] = 9999; }).join()).toMatch(/constant index/);
    expect(mutate((m) => { const f = m.functions[m.main]; const i = f.code.findIndex((x, k) => k % 3 === 0 && x === OPC.CONST); f.code[i] = OPC.ADD; }).join()).toMatch(/underflow|inconsistent|depth/);
    expect(mutate((m) => { const f = m.functions[0]; f.code.splice(f.code.length - 3, 3); f.spans.pop(); f.ir.pop(); }).join()).toMatch(/past the end/);
    expect(mutate((m) => { const f = m.functions[0]; f.code.unshift(OPC.CALLF, 0, 1, OPC.STORER, 0, 0); f.spans.unshift(f.spans[0], f.spans[0]); f.ir.unshift(-1, -1); }).join()).toMatch(/cycle|recursion|depth/);
  });
  it('rejects tampered or incompatible serialized bytecode before verification', () => {
    const tampered = structuredClone(good);
    tampered.consts[0] = 12345;
    expect(loadBytecode(tampered, DEFAULT_LIMITS).errors[0]).toMatch(/hash mismatch/);
    expect(loadBytecode({ ...good, version: 'folio-bc/9.9' }, DEFAULT_LIMITS).errors[0]).toMatch(/incompatible/);
    expect(loadBytecode({ hello: 1 }, DEFAULT_LIMITS).errors[0]).toMatch(/not FOLIO/);
    expect(loadBytecode(JSON.parse(JSON.stringify(good)), DEFAULT_LIMITS).errors).toEqual([]);
    // Re-signing a structurally broken module is still caught by the verifier.
    const broken = structuredClone(good) as BCModule & { hash?: string };
    delete broken.hash;
    broken.functions[broken.main].code[1] = 9999;
    expect(loadBytecode(serialize(broken), DEFAULT_LIMITS).errors.length).toBeGreaterThan(0);
  });
  it('compiles deterministically: same source + config + version → same bytecode hash', () => {
    for (const ex of examples()) {
      const a = compile(ex.source, { passes: ['constfold', 'dce', 'cse'], fixtures: fixtures() });
      const b = compile(ex.source, { passes: ['constfold', 'dce', 'cse'], fixtures: fixtures() });
      expect(a.bytecode!.hash).toBe(b.bytecode!.hash);
      expect(a.stages.map((s) => s.outputHash)).toEqual(b.stages.map((s) => s.outputHash));
    }
  });
});

describe('VM machine limits', () => {
  it('fuel exhaustion is a bounded R006 fault, not a hang', () => {
    const c = compile('scene "s" { repeat i in 0..50000 { let _a = i * 2; } }');
    const r = runVM(c.bytecode!, c.data, { ...DEFAULT_LIMITS, fuelPerFrame: 10_000 });
    expect(r.fault?.code).toBe('R006');
  });
  it('validates scene buffers before rendering', () => {
    const c = compile('scene "s" { circle(x: 1, y: 1, radius: 1); text(x: 1, y: 1, value: "<script>"); }');
    const s = runVM(c.bytecode!, c.data, DEFAULT_LIMITS).scene;
    expect(validateScene(s, DEFAULT_LIMITS)).toEqual([]);
    const bad = structuredClone(s);
    (bad.frames[0].cmds[0].a as Record<string, unknown>).fill = 'url(javascript:alert(1))';
    bad.frames[0].cmds[0].m[0] = Number.NaN;
    expect(validateScene(bad, DEFAULT_LIMITS).length).toBeGreaterThan(0);
  });
});

describe('debugger', () => {
  const c = compile(SRC, { passes: ['constfold', 'dce', 'cse'] });
  it('steps by instruction, by line, over calls, and stops at breakpoints', () => {
    const d = new DebugSession(c.bytecode!, c.data, c.limits, 1);
    d.stepInstruction();
    expect(d.position().step).toBe(1);
    d.continue(new Set([4]));
    expect(d.position().line).toBe(4);
    d.stepIn();
    const inFn = d.position();
    d.goto(0);
    d.continue(new Set([4]));
    d.stepOver();
    expect(d.position().depth).toBe(1);
    expect(inFn.step).toBeGreaterThan(0);
    expect(d.breakableLines()).toContain(4);
  });
  it('rewind + replay reaches byte-identical state, and the frame result is unchanged', () => {
    const d = new DebugSession(c.bytecode!, c.data, c.limits, 2, 8);
    d.continue(new Set());
    const end = d.vm.stateHash();
    const total = d.vm.steps;
    for (const n of [0, 1, 7, 8, 9, Math.floor(total / 2), total - 1, total]) {
      const proof = d.proveReplay(n);
      expect(proof.equal, `step ${n}`).toBe(true);
    }
    d.goto(3);
    d.continue(new Set());
    expect(d.vm.stateHash()).toBe(end);
    const batch = runVM(c.bytecode!, c.data, c.limits, 2);
    expect(sceneHash({ ...batch.scene, frames: [{ index: 2, time: d.vm.time, cmds: d.vm.scene.cmds }] })).toBe(sceneHash(batch.scene));
  });
  it('keeps checkpoint memory bounded on long runs', () => {
    const big = compile('scene "s" { repeat i in 0..20000 { let _a = i + 1; } }');
    const d = new DebugSession(big.bytecode!, big.data, big.limits, 0, 4, 64);
    d.continue(new Set());
    expect(d.checkpoints.length).toBeLessThanOrEqual(64);
    expect(d.proveReplay(Math.floor(d.vm.steps * 0.7)).equal).toBe(true);
  });
});

describe('receipts: reproduce and tamper detection', () => {
  const src = examples().find((e) => e.name.startsWith('02'))!.source;
  const { receipt, compiled } = makeReceipt({ project: 'test', source: src, fixtures: fixtures(), passes: ['constfold', 'dce', 'cse'] });
  it('reproduces from scratch, including the independent oracle', () => {
    expect(receipt!.oracle.agrees).toBe(true);
    const checks = reproduce(JSON.parse(JSON.stringify(receipt)), JSON.parse(JSON.stringify(compiled.bytecode)));
    expect(checks.filter((x) => !x.ok)).toEqual([]);
  });
  it('fails on any edited field, edited source, edited fixture or edited bytecode artifact', () => {
    const edit = (f: (r: typeof receipt & object) => void) => { const r = structuredClone(receipt!); f(r); return reproduce(r).filter((x) => !x.ok).map((x) => x.name); };
    expect(edit((r) => { r.sceneHash = '0'.repeat(64); })).toContain('receipt digest (no field edited)');
    expect(edit((r) => { r.source = r.source.replace('peak = 110', 'peak = 120'); })).toEqual(expect.arrayContaining(['source hash']));
    expect(edit((r) => { (r.fixtures.rainfall as number[])[0] = 1; })).toEqual(expect.arrayContaining(['fixture hash']));
    const bc = structuredClone(compiled.bytecode!);
    bc.functions[bc.main].code[1] = 777;
    expect(reproduce(receipt!, bc).find((x) => x.name.startsWith('exported bytecode artifact loads'))!.ok).toBe(false);
  });
});
