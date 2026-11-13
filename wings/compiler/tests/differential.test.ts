// The AST reference interpreter is the oracle: for every program, the bytecode VM must produce the same
// normalized scene and the same fault (code, source offset, frame) under every optimization configuration.
import { describe, expect, it } from 'vitest';
import { type PassName, compile, generateProgram, mutateSource } from '../core/index.ts';
import { differential, examples, failures } from './helpers.ts';

const CONFIGS: PassName[][] = [[], ['constfold'], ['dce'], ['cse'], ['constfold', 'dce'], ['constfold', 'dce', 'cse'], ['cse', 'constfold', 'dce', 'cse']];

describe('examples: VM ≡ reference interpreter under every pass configuration', () => {
  for (const ex of examples()) {
    it(ex.name, () => {
      for (const cfg of CONFIGS) {
        const r = differential(ex.source, cfg);
        expect(r.ok, `${ex.name} compiles with [${cfg}]`).toBe(true);
        if (!r.ok) return;
        expect(r.vm, `[${cfg}]`).toEqual(r.ref);
        expect(r.vm.fault).toBeNull();
      }
    });
  }
});

describe('runtime faults are identical (code, span, frame) in both executors', () => {
  for (const f of failures().filter((x) => x.expect.kind === 'fault')) {
    it(`${f.name} → ${f.expect.code} at ${f.expect.line}:${f.expect.col}`, () => {
      for (const cfg of CONFIGS) {
        const r = differential(f.source, cfg);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.vm, `[${cfg}]`).toEqual(r.ref);
        expect(r.vm.fault?.startsWith(f.expect.code)).toBe(true);
      }
      const c = compile(f.source, { passes: ['constfold', 'dce', 'cse'] });
      const offset = Number(differential(f.source, []).ok && (differential(f.source, []) as { vm: { fault: string } }).vm.fault.split('@')[1].split('#')[0]);
      const before = f.source.slice(0, offset);
      expect(before.split('\n').length).toBe(f.expect.line);
      expect(offset - before.lastIndexOf('\n')).toBe(f.expect.col);
      expect(c.ok).toBe(true);
    });
  }
});

describe('seeded differential fuzzing', () => {
  const SEEDS = 300;
  it(`${SEEDS} generated well-typed programs agree under all configurations`, () => {
    let faults = 0, rejected = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const src = generateProgram(seed);
      for (const cfg of [[], ['constfold', 'dce', 'cse']] as PassName[][]) {
        const r = differential(src, cfg, {});
        if (!r.ok) { rejected++; expect.fail(`seed ${seed} was rejected by the checker:\n${src}\n${JSON.stringify(r.diagnostics.slice(0, 2))}`); }
        expect(r.vm, `seed ${seed} [${cfg}]\n${src}`).toEqual(r.ref);
        if (r.vm.fault) faults++;
      }
    }
    expect(rejected).toBe(0);
    // The generator must exercise faults too, not only happy paths.
    expect(faults).toBeGreaterThan(20);
  });
  it('mutated (mostly invalid) programs never crash the compiler', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const src = mutateSource(generateProgram(seed), seed * 7919);
      const c = compile(src);
      expect(c.diagnostics.some((d) => d.code === 'ICE'), `seed ${seed}`).toBe(false);
      if (c.ok) {
        const r = differential(src, ['constfold', 'dce', 'cse'], {});
        if (r.ok) expect(r.vm).toEqual(r.ref);
      }
    }
  });
});
