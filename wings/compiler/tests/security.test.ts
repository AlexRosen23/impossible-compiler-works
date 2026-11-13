// Regressions for the pre-release red-team review (docs/SECURITY.md §5, docs/BUILD_LEDGER.md "red-team review").
// Each test is a reproduction that crashed, hung or misreported before the fix. Small custom limits keep the
// resource tests fast; the defaults are what the server and the IDE use.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS, type Limits, OPCODES, type SerializedBC, compile, interpret, makeReceipt, receiptShape, reproduce, runVM,
  sceneHash, validateScene, verifyBytecode,
} from '../core/index.ts';
import { differential } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const limits = (over: Partial<Limits>): Limits => ({ ...DEFAULT_LIMITS, ...over });
const timed = <T>(f: () => T): { v: T; ms: number } => { const t = performance.now(); const v = f(); return { v, ms: performance.now() - t }; };
/** Both executors on one compiled program. */
function both(src: string, l: Limits = DEFAULT_LIMITS, passes: ('constfold' | 'dce' | 'cse')[] = ['constfold', 'dce', 'cse']) {
  const c = compile(src, { passes, limits: l });
  if (!c.ok) throw new Error(c.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
  return { c, vm: runVM(c.bytecode!, c.data, l), ref: interpret(c.program!, c.check!, c.data, l) };
}

describe('red-team: bounded work', () => {
  it('an exponential call tree stops on the call limit (R013) in both executors, quickly and identically', () => {
    const fns = Array.from({ length: 62 }, (_, i) => `fn f${i}(x: Number) -> Number {\n  return ${i < 61 ? `f${i + 1}(x) + f${i + 1}(x + 1)` : 'x'};\n}`).join('\n');
    const src = `${fns}\nscene "boom" {\n  circle(x: f0(1) % 100, y: 1, radius: 1);\n}\n`;
    const { v: r, ms } = timed(() => both(src));
    expect(r.vm.fault?.code).toBe('R013');
    expect(r.ref.fault?.code).toBe('R013');
    expect(r.vm.fault?.span?.start).toBe(r.ref.fault?.span?.start);
    expect(ms).toBeLessThan(5_000);
    const { receipt } = makeReceipt({ project: 't', source: src, fixtures: {}, passes: ['constfold', 'dce', 'cse'] });
    expect(receipt!.oracle.status).toBe('agree');
  });

  it('the reference interpreter has its own fuel: work the VM folds away is reported as a reference resource limit', () => {
    const chain = Array.from({ length: 150 }, () => '1').join(' + ');
    const src = `scene "fold" {\n  var t = 0;\n  repeat i in 0..100000 {\n    t = t + (${chain});\n  }\n  circle(x: t % 100, y: 1, radius: 1);\n}\n`;
    const { receipt } = makeReceipt({ project: 't', source: src, fixtures: {}, passes: ['constfold', 'dce', 'cse'], limits: limits({ refFuelPerFrame: 2_000_000 }) });
    expect(receipt!.fault).toBeNull();
    expect(receipt!.oracle.status).toBe('reference-resource-limit');
  });

  it('fuel has a whole-run budget in both executors, not only a per-frame one', () => {
    const src = 'scene "long" frames 50 {\n  var t = 0;\n  repeat i in 0..200 {\n    t = t + i;\n  }\n  circle(x: t % 100, y: 1, radius: 1);\n}\n';
    const r = both(src, limits({ fuelPerRun: 20_000, refFuelPerRun: 20_000 }), []);
    expect(r.vm.fault?.code).toBe('R006');
    expect(r.vm.fault?.message).toMatch(/whole run/);
    expect(r.ref.fault?.code).toBe('R014');
    expect(r.ref.fault?.message).toMatch(/whole run/);
  });

  it('scene size is bounded per frame and per run, before memory is spent (was: 11 KB program → heap out of memory)', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => `point(${i % 7}, ${i % 5})`).join(', ');
    const src = `scene "oom" frames 240 {\n  let ps = [${pts}];\n  repeat i in 0..10000 {\n    path(points: ps);\n  }\n}\n`;
    const { v: r, ms } = timed(() => both(src));
    expect(r.vm.fault?.code).toBe('R005');
    expect(r.ref.fault?.code).toBe('R005');
    expect(sceneHash(r.vm.scene)).toBe(sceneHash(r.ref.scene));
    expect(ms).toBeLessThan(5_000);
    const long = 'x'.repeat(1000);
    const t = both(`scene "txt" frames 240 {\n  repeat i in 0..10000 {\n    text(x: 1, y: 1, value: "${long}");\n  }\n}\n`);
    expect(t.vm.fault?.code).toBe('R005');
    const run = both('scene "many" frames 20 {\n  repeat i in 0..50 {\n    circle(x: i, y: 1, radius: 1);\n  }\n}\n', limits({ maxSceneUnits: 500 }));
    expect(run.vm.fault?.message).toMatch(/whole run/);
    expect(run.vm.fault?.frame).toBe(10);
    expect(run.ref.fault?.frame).toBe(10);
  });
});

describe('red-team: no host exceptions from hostile source', () => {
  it('a 3,000-term operator chain is a diagnostic (S002), not a RangeError', () => {
    const src = `scene "s" {\n  let _v = ${Array.from({ length: 3000 }, () => '1').join(' + ')};\n}\n`;
    const c = compile(src);
    expect(c.ok).toBe(false);
    expect(c.diagnostics.map((d) => d.code)).toContain('S002');
    expect(c.diagnostics.map((d) => d.code)).not.toContain('ICE');
  });

  it('nesting that adds up across calls is rejected statically (S005) instead of overflowing the interpreter', () => {
    const terms = Array.from({ length: 190 }, () => '1').join(' + ');
    const fns = Array.from({ length: 40 }, (_, i) => `fn f${i}(x: Number) -> Number {\n  return ${i < 39 ? `f${i + 1}(x)` : 'x'} + ${terms};\n}`).join('\n');
    const c = compile(`${fns}\nscene "s" {\n  circle(x: f0(1) % 100, y: 1, radius: 1);\n}\n`);
    expect(c.diagnostics.map((d) => d.code)).toContain('S005');
    expect(c.diagnostics.map((d) => d.code)).not.toContain('ICE');
  });

  it('prototype names are ordinary names (was: internal compiler error on fn toString)', () => {
    for (const name of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__']) {
      const r = differential(`fn ${name}(x: Number) -> Number {\n  return x + 1;\n}\nscene "p" {\n  circle(x: ${name}(1), y: 1, radius: 1);\n}\n`, ['constfold', 'dce', 'cse'], {});
      expect(r.ok, name).toBe(true);
      expect(r.ok && r.vm, name).toEqual(r.ok && r.ref);
    }
    const draw = compile('scene "p" {\n  toString(x: 1);\n}\n');
    expect(draw.ok).toBe(false);
    expect(draw.diagnostics.map((d) => d.code)).not.toContain('ICE');
  });

  it('diagnostics stop at maxErrors and stay cheap (was: 10 s and 2,600 diagnostics)', () => {
    const lets = Array.from({ length: 900 }, (_, i) => `  let a${i} = ${i};`).join('\n');
    const bad = Array.from({ length: 1700 }, (_, i) => `  undeclaredName${String(i).padStart(6, '0')} = 1;`).join('\n');
    const { v: c, ms } = timed(() => compile(`scene "s" {\n${lets}\n${bad}\n}\n`));
    expect(c.ok).toBe(false);
    expect(c.diagnostics.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxErrors + 2);
    expect(c.diagnostics.map((d) => d.code)).toContain('S006');
    expect(ms).toBeLessThan(3_000);
    const lexErrors = compile('scene "s" {}\n' + '@'.repeat(20_000));
    expect(lexErrors.diagnostics.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxErrors + 2);
  });

  it('source that is not valid Unicode is rejected (L008), so a source hash names exactly one program', () => {
    const c = compile('scene "s" {\n  text(x: 1, y: 1, value: "\uD800");\n}\n');
    expect(c.diagnostics.map((d) => d.code)).toEqual(['L008']);
    expect(compile('scene "s" {\n  text(x: 1, y: 1, value: "� 🐯");\n}\n').ok).toBe(true);
  });
});

describe('red-team: bytecode verifier', () => {
  const base = (): SerializedBC => {
    const c = compile('fn g(x: Number) -> Number {\n  return sqrt(x) + 1;\n}\nscene "v" {\n  let xs = [1, 2];\n  circle(x: g(len(xs)), y: 1, radius: 1);\n}\n');
    return JSON.parse(JSON.stringify(c.bytecode)) as SerializedBC;
  };
  const opAt = (m: SerializedBC, name: string) => {
    for (const f of m.functions) for (let p = 0; p < f.code.length; p += 3) if (OPCODES[f.code[p]] === name) return { f, p };
    throw new Error(`no ${name}`);
  };
  const crafted: [string, (m: SerializedBC) => void][] = [
    ['fractional CALLB operand', (m) => { const { f, p } = opAt(m, 'CALLB'); f.code[p + 1] = 0.5; }],
    ['fractional LOADS operand', (m) => { const { f, p } = opAt(m, 'LOADS'); f.code[p + 1] = 0.5; }],
    ['null function', (m) => { (m.functions as unknown[]).push(null); }],
    ['huge slot count', (m) => { m.functions[0].nslots = 1e9; }],
    ['huge register count', (m) => { m.functions[0].nregs = 2e9; }],
    ['frame count out of range', (m) => { m.scene.frames = 1e9; }],
    ['bad background', (m) => { m.scene.background = 'url(javascript:alert(1))'; }],
    ['opcode out of table', (m) => { m.functions[0].code[0] = 999; }],
    ['string operand', (m) => { (m.functions[0].code as unknown[])[1] = '0'; }],
  ];
  for (const [name, mutate] of crafted) {
    it(`rejects a ${name} with a message, never an exception`, () => {
      const m = base();
      expect(verifyBytecode(m, DEFAULT_LIMITS)).toEqual([]);
      mutate(m);
      let errs: string[] = [];
      expect(() => { errs = verifyBytecode(m, DEFAULT_LIMITS); }).not.toThrow();
      expect(errs.length, name).toBeGreaterThan(0);
    });
  }
  it('checks a 20,000-function call chain without host recursion', () => {
    const m = base();
    const g = m.functions.find((f) => f.name === 'g')!;
    const callf = OPCODES.indexOf('CALLF');
    const many = Array.from({ length: 1_999 }, (_, i) => ({ ...g, name: `h${i}`, code: [callf, m.functions.length + i + 1, g.nparams, ...g.code] }));
    m.functions.push(...many);
    expect(() => verifyBytecode(m, { ...DEFAULT_LIMITS, maxSymbols: 50_000 })).not.toThrow();
  });
});

describe('red-team: receipts and scenes are untrusted input', () => {
  const good = makeReceipt({ project: 't', source: 'scene "r" {\n  circle(x: 1, y: 1, radius: 1);\n}\n', fixtures: {}, passes: ['constfold'] }).receipt!;
  it('a valid receipt still reproduces', () => {
    expect(reproduce(good).every((c) => c.ok)).toBe(true);
  });
  it('malformed receipts fail a check instead of throwing', () => {
    const variants: unknown[] = [null, 5, [], { ...good, source: {} }, { ...good, source: 5 }, { ...good, fixtures: { a: [{ deep: [[[1]]] }] } },
      { ...good, optimizations: Array(20_000).fill('cse') }, { ...good, optimizations: 'cse' }, { ...good, limits: { toString: 1 } }, { ...good, limits: { maxNestingWeight: 1 } }];
    for (const v of variants) {
      let checks: ReturnType<typeof reproduce> = [];
      expect(() => { checks = reproduce(v as typeof good); }).not.toThrow();
      expect(checks.some((c) => !c.ok), JSON.stringify(v)?.slice(0, 80)).toBe(true);
    }
    expect(receiptShape({ ...good, optimizations: Array(20_000).fill('cse') })).toMatch(/at most 8/);
  });
  it('-0 in a fixture is stored as 0, so the hash the receipt pins names the scene that re-runs', () => {
    const src = 'data z: List<Number> from "z";\nscene "nz" {\n  circle(x: 50 + atan2(z[0], -1) * 10, y: 1, radius: 1);\n}\n';
    const neg = makeReceipt({ project: 't', source: src, fixtures: { z: [-0] }, passes: [] }).receipt!;
    const pos = makeReceipt({ project: 't', source: src, fixtures: { z: [0] }, passes: [] }).receipt!;
    expect(neg.sceneHash).toBe(pos.sceneHash);
    expect(reproduce(neg).every((c) => c.ok)).toBe(true);
  });
  it('validateScene rejects prototype names, unknown arguments and oversized scenes', () => {
    const scene = (cmds: unknown[]) => ({ format: 'folio-scene/0.1', title: 't', width: 10, height: 10, background: '#000000', frames: [{ index: 0, time: 0, cmds }] });
    const cmd = (k: string, a: Record<string, unknown>) => ({ k, a, m: [1, 0, 0, 1, 0, 0], o: 1 });
    expect(validateScene(scene([cmd('toString', {})]), DEFAULT_LIMITS).length).toBeGreaterThan(0);
    expect(validateScene(scene([cmd('__proto__', {})]), DEFAULT_LIMITS).length).toBeGreaterThan(0);
    expect(validateScene(scene([cmd('circle', { x: 1, onclick: 1 })]), DEFAULT_LIMITS).length).toBeGreaterThan(0);
    expect(validateScene(scene([cmd('circle', { x: 1, y: 1, radius: 1 })]), DEFAULT_LIMITS)).toEqual([]);
    const pts = Array.from({ length: 30 }, () => [0, 0]);
    expect(validateScene(scene([cmd('path', { points: pts })]), { ...DEFAULT_LIMITS, maxSceneUnitsPerFrame: 10 }).length).toBeGreaterThan(0);
  });
});

describe('red-team: tooling', () => {
  it('npm run fuzz -- --help prints usage and leaves the evidence untouched', () => {
    const file = join(ROOT, 'evidence', 'fuzz-summary.json');
    const before = readFileSync(file, 'utf8');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fuzz.ts'), '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/usage/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
