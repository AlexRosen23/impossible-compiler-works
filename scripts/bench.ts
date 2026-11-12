// Benchmark: VM wall time per example, optimizations off vs on. Warmup runs are discarded; we report median,
// p95, mean and standard deviation of N timed runs, plus VM instruction counts (deterministic). Results are
// written to evidence/benchmarks.json with the exact environment. No result is extrapolated.
import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { SAFE_PASSES, compile, runVM, sceneHash } from '../core/index.ts';
import { ROOT, gitCommit, loadExampleFixtures } from './lib.ts';
import { readdirSync, readFileSync } from 'node:fs';

const WARMUP = Number(process.env.WARMUP ?? 5);
const RUNS = Number(process.env.RUNS ?? 25);
const fx = loadExampleFixtures();
const files = readdirSync(join(ROOT, 'examples')).filter((f) => /^\d\d-.*\.folio$/.test(f)).sort();
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  const pick = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { median: r3(pick(0.5)), p95: r3(pick(0.95)), mean: r3(mean), sd: r3(sd), min: r3(s[0]), max: r3(s[s.length - 1]) };
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const rows = [];
for (const f of files) {
  const src = readFileSync(join(ROOT, 'examples', f), 'utf8');
  const res: Record<string, unknown> = { example: f };
  const hashes: string[] = [];
  for (const [label, passes] of [['off', []], ['on', SAFE_PASSES]] as const) {
    const c = compile(src, { passes: [...passes], fixtures: fx });
    const times: number[] = [];
    let steps = 0;
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const t0 = performance.now();
      const r = runVM(c.bytecode!, c.data, c.limits);
      const dt = performance.now() - t0;
      if (i >= WARMUP) times.push(dt);
      steps = r.steps.reduce((a, b) => a + b, 0);
      if (i === 0) hashes.push(sceneHash(r.scene));
    }
    res[label] = { ms: stats(times), vmInstructions: steps, bytecodeInstructions: c.bytecode!.functions.reduce((n, x) => n + x.code.length / 3, 0) };
  }
  const off = res.off as { ms: { median: number }; vmInstructions: number }, on = res.on as { ms: { median: number }; vmInstructions: number };
  res.sameScene = hashes[0] === hashes[1];
  res.instructionReduction = r3(1 - on.vmInstructions / off.vmInstructions);
  res.medianSpeedup = r3(off.ms.median / on.ms.median);
  rows.push(res);
  console.log(`${f.padEnd(28)} steps ${String(off.vmInstructions).padStart(8)} → ${String(on.vmInstructions).padStart(8)}  median ${off.ms.median.toFixed(3).padStart(8)} → ${on.ms.median.toFixed(3).padStart(8)} ms  x${(res.medianSpeedup as number).toFixed(2)}  same scene: ${res.sameScene}`);
}
const env = { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30), warmup: WARMUP, runs: RUNS, commit: gitCommit(), date: new Date().toISOString(), note: 'Wall time of runVM over all frames, single process, machine not otherwise idle-controlled.' };
writeFileSync(join(ROOT, 'evidence', 'benchmarks.json'), JSON.stringify({ env, rows }, null, 2) + '\n');
console.log(env);
