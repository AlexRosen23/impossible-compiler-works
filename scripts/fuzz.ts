// Differential fuzz campaign: node scripts/fuzz.ts [count=2000] [startSeed=1]
// Every generated program must type-check and produce identical observable results (scene hash, fault code,
// fault offset, frame) in the reference interpreter and in the VM with optimizations off and on. Failures are
// reduced deterministically and written to evidence/fuzz-failures/. A summary goes to evidence/fuzz-summary.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PassName, SAFE_PASSES, compile, generateProgram, interpret, mutateSource, reduce, runVM, sceneHash } from '../core/index.ts';
import { ROOT } from './lib.ts';

const count = Number(process.argv[2] ?? 2000);
const start = Number(process.argv[3] ?? 1);
const configs: PassName[][] = [[], SAFE_PASSES];
const outcome = (src: string, passes: PassName[]) => {
  const c = compile(src, { passes });
  if (!c.ok) return { ok: false, why: c.diagnostics.slice(0, 2).map((d) => `${d.code} ${d.message}`).join('; ') };
  const vm = runVM(c.bytecode!, c.data, c.limits), ref = interpret(c.program!, c.check!, c.data, c.limits);
  const o = (r: typeof vm | typeof ref) => `${sceneHash(r.scene)}|${r.fault ? `${r.fault.code}@${r.fault.span?.start}#${r.fault.frame}` : '-'}`;
  return { ok: true, vm: o(vm), ref: o(ref), fault: vm.fault?.code ?? null };
};
const t0 = performance.now();
let agree = 0, rejected = 0, crashes = 0;
const faults: Record<string, number> = {};
const failures: { seed: number; config: string; reduced: string }[] = [];
for (let seed = start; seed < start + count; seed++) {
  const src = generateProgram(seed);
  for (const cfg of configs) {
    const r = outcome(src, cfg);
    if (!r.ok) { rejected++; failures.push({ seed, config: cfg.join('+') || 'none', reduced: `REJECTED: ${r.why}\n${src}` }); continue; }
    if (r.vm === r.ref) { agree++; if (r.fault) faults[r.fault] = (faults[r.fault] ?? 0) + 1; continue; }
    const red = reduce(src, (s) => { const x = outcome(s, cfg); return x.ok && x.vm !== x.ref; });
    failures.push({ seed, config: cfg.join('+') || 'none', reduced: red.source });
  }
  // Robustness: a mutated program must never crash the compiler (it may be rejected).
  try { const c = compile(mutateSource(src, seed * 7919)); if (c.diagnostics.some((d) => d.code === 'ICE')) crashes++; } catch { crashes++; }
}
const ms = performance.now() - t0;
const dir = join(ROOT, 'evidence');
mkdirSync(join(dir, 'fuzz-failures'), { recursive: true });
failures.forEach((f) => writeFileSync(join(dir, 'fuzz-failures', `seed-${f.seed}-${f.config}.folio`), f.reduced));
const summary = { seeds: [start, start + count - 1], configs: configs.map((c) => c.join('+') || 'none'), runs: count * configs.length, agree, divergent: failures.length - rejected, rejected, compilerCrashesOnMutations: crashes, faultsObserved: faults, seconds: Math.round(ms / 10) / 100, node: process.version };
writeFileSync(join(dir, 'fuzz-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length || crashes ? 1 : 0);
