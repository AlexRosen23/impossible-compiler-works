import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, instrCount, interpret, printModule, reduce, runVM, sceneHash } from '../core/index.ts';
import { ROOT, differential } from './helpers.ts';

const ALL = ['constfold', 'dce', 'cse'] as const;

describe('constant folding legality', () => {
  it('folds constant arithmetic and propagates let bindings', () => {
    const c = compile('scene "s" { let a = 2 * 3 + 4; let b = a * 2; circle(x: b, y: a, radius: 1); }', { passes: ['constfold'] });
    expect(printModule(c.irOptimized!)).toContain('draw circle(20, 10, 1');
  });
  it('never folds an operation that would fault; the fault keeps its span', () => {
    const src = 'scene "s" {\n  let z = 0;\n  let q = 1 / z;\n  circle(x: q, y: 1, radius: 1);\n}';
    const c = compile(src, { passes: [...ALL] });
    expect(printModule(c.irOptimized!)).toMatch(/div 1, 0/);
    const r = differential(src, [...ALL]);
    expect(r.ok && r.vm.fault).toBe(r.ok && r.ref.fault);
    expect(r.ok && r.vm.fault).toMatch(/^R001@/);
  });
  it('preserves -0 and does not fold NaN-producing builtins', () => {
    const src = 'scene "s" { let n = 0 * -1; text(x: 1, y: 1, value: str(1 / n)); }';
    const r = differential(src, [...ALL]);
    expect(r.ok && r.vm.fault).toMatch(/^R001/); // 1 / -0 = -Infinity: still faults, still at run time
    expect(r.ok && r.vm).toEqual(r.ok && r.ref);
    const nan = compile('scene "s" { let v = sqrt(0 - 4); circle(x: v, y: 1, radius: 1); }', { passes: [...ALL] });
    expect(printModule(nan.irOptimized!)).toContain('callb sqrt(-4)');
  });
  it('folds constant branches and removes the dead side', () => {
    const c = compile('scene "s" { let debug = false; if debug { text(x: 1, y: 1, value: "d"); } circle(x: 1, y: 1, radius: 1); }', { passes: [...ALL] });
    expect(printModule(c.irOptimized!)).not.toContain('draw text');
    expect(c.passReports.find((p) => p.pass === 'dce')!.changes.some((x) => x.kind === 'block-removed')).toBe(true);
  });
});

describe('dead code elimination legality', () => {
  it('keeps unused operations that may fault (strict evaluation)', () => {
    const src = 'scene "s" { let _unused = 1 / 0; circle(x: 1, y: 1, radius: 1); }';
    const c = compile(src, { passes: ['dce'] });
    expect(printModule(c.irOptimized!)).toContain('div 1, 0');
    const r = differential(src, ['dce']);
    expect(r.ok && r.vm.fault).toMatch(/^R001/);
  });
  it('removes unused non-faulting results and never-read stores', () => {
    const c = compile('scene "s" { let _p = point(1, 2); var _v = 3; _v = 4; circle(x: 1, y: 1, radius: 1); }', { passes: ['dce'] });
    const ir = printModule(c.irOptimized!);
    expect(ir).not.toContain('callb point');
    expect(ir).not.toContain('store');
  });
});

describe('common subexpression elimination legality', () => {
  it('reuses repeated pure computations and loads within a block', () => {
    const c = compile('scene "s" { repeat i in 0..3 { circle(x: sin(i * 2), y: sin(i * 2), radius: 1); } }', { passes: ['cse'] });
    expect(c.passReports[0].changes.filter((x) => x.kind === 'reused').length).toBeGreaterThanOrEqual(2);
  });
  it('treats only add, mul, eq and ne as commutative', () => {
    const c = compile('scene "s" { repeat i in 0..3 { let a = i + 1; let b = 1 + i; let d = i - 1; let e = 1 - i; circle(x: a + b, y: d + e, radius: 1); } }', { passes: ['cse'] });
    const reused = c.passReports[0].changes.filter((x) => x.kind === 'reused' && /add|sub/.test(x.detail)).map((x) => x.detail);
    expect(reused.some((d) => d.includes('add'))).toBe(true);
    expect(reused.some((d) => d.includes('sub'))).toBe(false);
  });
});

describe('fault lab: a deliberately wrong pass is caught by the independent oracle', () => {
  const src = readFileSync(join(ROOT, 'examples', 'fault-lab-commute.folio'), 'utf8');
  it('the program is correct under every safe pass', () => {
    const r = differential(src, [...ALL]);
    expect(r.ok && r.vm).toEqual(r.ok && r.ref);
  });
  it('BAD_cse_commute_all miscompiles it and the reference interpreter detects the divergence', () => {
    const r = differential(src, ['constfold', 'dce', 'BAD_cse_commute_all']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vm.scene).not.toBe(r.ref.scene);
  });
  it('the reducer shrinks the miscompile to a small reproducer that still diverges', () => {
    const diverges = (s: string) => { const r = differential(s, ['BAD_cse_commute_all'], {}); return r.ok && r.vm.scene !== r.ref.scene; };
    expect(diverges(src)).toBe(true);
    const red = reduce(src, diverges);
    expect(diverges(red.source)).toBe(true);
    expect(red.source.length).toBeLessThan(src.length / 2);
    expect(red.steps).toBeGreaterThan(0);
  });
});

describe('optimization effect is reported honestly', () => {
  it('reports instruction counts and the VM step change for the optimizer bench', () => {
    const src = readFileSync(join(ROOT, 'examples', '13-optimizer-bench.folio'), 'utf8');
    const off = compile(src);
    const on = compile(src, { passes: [...ALL] });
    expect(instrCount(on.irOptimized!)).toBeLessThan(instrCount(off.irOptimized!));
    const a = runVM(off.bytecode!, off.data, off.limits), b = runVM(on.bytecode!, on.data, on.limits);
    expect(sceneHash(a.scene)).toBe(sceneHash(b.scene));
    expect(b.steps.reduce((x, y) => x + y)).toBeLessThan(a.steps.reduce((x, y) => x + y));
    expect(sceneHash(interpret(on.program!, on.check!, on.data, on.limits).scene)).toBe(sceneHash(b.scene));
  });
});
