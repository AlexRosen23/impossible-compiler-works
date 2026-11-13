// Regressions for defects found by the documentation review (docs/BUILD_LEDGER.md, "review findings").
import { describe, expect, it } from 'vitest';
import {
  BUILTINS, DEFAULT_LIMITS, SceneBuilder, callBuiltin, color, colorHex, compile, makeReceipt, point, reproduce, validateScene,
} from '../core/index.ts';
import { differential } from './helpers.ts';

describe('review findings', () => {
  it('1 · -0 survives constant folding, the constant pool and CSE keys', () => {
    const src = 'scene "z" {\n  let x = -0 * frame;\n  text(x: 10, y: 10, value: str(atan2(0, x + 0)) + " " + str(atan2(0, x + -0)));\n}\n';
    for (const cfg of [[], ['constfold'], ['constfold', 'dce', 'cse']] as const) {
      const r = differential(src, [...cfg], {});
      expect(r.ok && r.vm, `[${cfg}]`).toEqual(r.ok && r.ref);
    }
  });
  it('2a · a deep but finite call chain is rejected statically (S004), never as a VM-only fault', () => {
    const fns = Array.from({ length: 70 }, (_, i) => `fn f${i}(x: Number) -> Number { return ${i < 69 ? `f${i + 1}(x)` : 'x'}; }`).join('\n');
    const c = compile(`${fns}\nscene "s" { circle(x: f0(1), y: 1, radius: 1); }`);
    expect(c.diagnostics.map((d) => d.code)).toContain('S004');
    const ok = compile(`${Array.from({ length: 40 }, (_, i) => `fn f${i}(x: Number) -> Number { return ${i < 39 ? `f${i + 1}(x)` : 'x'}; }`).join('\n')}\nscene "s" { circle(x: f0(1), y: 1, radius: 1); }`);
    expect(ok.ok).toBe(true);
    const r = differential(ok.source, ['constfold', 'dce', 'cse'], {});
    expect(r.ok && r.vm).toEqual(r.ok && r.ref);
  });
  it('2b · fuel exhaustion is reported as a VM resource limit, not as an oracle divergence', () => {
    const src = 'scene "s" { var t = 0; repeat i in 0..100000 { t = t + sin(i) * cos(i) + sqrt(i) * 2 + abs(i - 3) + floor(i / 7) + min(i, 3) + max(i, 9); } circle(x: 1, y: 1, radius: 1); }';
    const { receipt } = makeReceipt({ project: 't', source: src, fixtures: {}, passes: [], limits: { ...DEFAULT_LIMITS, fuelPerFrame: 1_000_000 } });
    expect(receipt!.fault?.code).toBe('R006');
    expect(receipt!.oracle.status).toBe('vm-resource-limit');
  });
  it('4 · a receipt cannot raise the host limits', () => {
    const { receipt } = makeReceipt({ project: 't', source: 'scene "s" { circle(x: 1, y: 1, radius: 1); }', fixtures: {}, passes: [] });
    const r = structuredClone(receipt!);
    r.limits.fuelPerFrame = 1e12;
    const checks = reproduce(r);
    expect(checks.find((c) => c.name === 'receipt limits within this host\'s caps')!.ok).toBe(false);
  });
  it('5 · deeply nested blocks are a size diagnostic, not an internal error', () => {
    const src = `scene "s" { ${'if true { '.repeat(2000)}${'} '.repeat(2000)} }`;
    const c = compile(src);
    expect(c.diagnostics.some((d) => d.code === 'ICE')).toBe(false);
    expect(c.diagnostics.some((d) => d.code === 'S002')).toBe(true);
  });
  it('7 · validateScene checks background, opacity and point coordinates', () => {
    const s = { format: 'folio-scene/0.1', title: 't', width: 10, height: 10, background: 'red;x', frames: [{ index: 0, time: 0, cmds: [{ k: 'line' as const, a: { from: [[Number.NaN, 0]], to: [[1, 1]], stroke: '#000000ff', strokeWidth: 1 }, m: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number], o: 7 }] }] };
    const errs = validateScene(s, DEFAULT_LIMITS).join(' ');
    expect(errs).toMatch(/background/);
    expect(errs).toMatch(/opacity/);
    expect(errs).toMatch(/point/);
  });
  it('9 · a let that shadows a function name does not steal the call resolution', () => {
    const c = compile('fn g(x: Number) -> Number { return x; }\nscene "s" { let g = 2; circle(x: g(g), y: 1, radius: 1); }');
    const fnSym = c.check!.symbols.find((s) => s.kind === 'fn' && s.name === 'g')!;
    const call = c.check!.trace.find((t) => t.rule.startsWith('fn g('))!;
    expect(c.check!.resolutions.get(call.node)).toBe(fnSym.id);
  });
});

describe('shared output device and built-ins (unit)', () => {
  it('colours clamp and round; hsl, mix and alpha are exact on known values', () => {
    expect(colorHex(color(300, -5, 127.5, 2))).toBe('#ff0080ff');
    expect(colorHex(callBuiltin('hsl', [0, 1, 0.5], 1000) as never)).toBe('#ff0000ff');
    expect(colorHex(callBuiltin('hsl', [120, 1, 0.25], 1000) as never)).toBe('#008000ff');
    expect(colorHex(callBuiltin('mix', [color(0, 0, 0), color(255, 255, 255), 0.5], 1000) as never)).toBe('#808080ff');
    expect(colorHex(callBuiltin('alpha', [color(1, 2, 3), 0], 1000) as never)).toBe('#01020300');
  });
  it('noise is deterministic and in [0, 1); fmt clamps digits; non-finite results fault', () => {
    for (let i = 0; i < 200; i++) { const v = callBuiltin('noise', [i, i * 3], 1000) as number; expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    expect(callBuiltin('noise', [3, 4], 1000)).toBe(callBuiltin('noise', [3, 4], 1000));
    expect(callBuiltin('fmt', [Math.PI, 99], 1000)).toBe('3.141593');
    expect(() => callBuiltin('sqrt', [-1], 1000)).toThrow(/NaN/);
    expect(() => callBuiltin('log', [0], 1000)).toThrow(/Infinity/);
    expect(Object.keys(BUILTINS).length).toBe(28);
  });
  it('the scene builder composes translate·rotate·scale, multiplies opacity and enforces limits', () => {
    const b = new SceneBuilder(DEFAULT_LIMITS);
    b.pushGroup(point(10, 20), 90, 2, 0.5);
    b.pushGroup(point(0, 0), 0, 1, 0.5);
    b.draw('circle', [1, 0, 3, color(1, 1, 1), null, 1]);
    expect(b.cmds[0].m).toEqual([0, 2, -2, 0, 10, 20]);
    expect(b.cmds[0].o).toBe(0.25);
    expect(() => b.draw('circle', [0, 0, -1, color(1, 1, 1), null, 1])).toThrow(/radius/);
    const tiny = new SceneBuilder({ ...DEFAULT_LIMITS, maxDrawsPerFrame: 1 });
    tiny.draw('rect', [0, 0, 1, 1, color(0, 0, 0), null, 1, 0]);
    expect(() => tiny.draw('rect', [0, 0, 1, 1, color(0, 0, 0), null, 1, 0])).toThrow(/more than 1/);
  });
});
