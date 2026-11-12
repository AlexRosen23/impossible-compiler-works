// CLI: node scripts/folio.ts <file.folio> [--opt] [--ir] [--bc] [--fixtures dir]
import { readFileSync } from 'node:fs';
import { compile, disassemble, interpret, printModule, runVM, sceneHash, SAFE_PASSES } from '../core/index.ts';
import { loadExampleFixtures } from './lib.ts';

const file = process.argv[2];
if (!file) { console.error('usage: folio <file.folio> [--opt] [--ir] [--bc]'); process.exit(2); }
const src = readFileSync(file, 'utf8');
const opt = process.argv.includes('--opt');
const c = compile(src, { passes: opt ? SAFE_PASSES : [], fixtures: loadExampleFixtures() });
for (const d of c.diagnostics) console.log(`${file}:${d.span.line}:${d.span.col} ${d.severity} ${d.code}: ${d.message}${d.hint ? `\n    hint: ${d.hint}` : ''}`);
for (const s of c.stages) console.log(`  [${s.ok ? 'ok ' : 'ERR'}] ${s.stage.padEnd(9)} ${String(s.ms).padStart(8)} ms  ${s.summary}`);
if (!c.ok) process.exit(1);
if (process.argv.includes('--ir')) console.log(printModule(c.irOptimized!));
if (process.argv.includes('--bc')) for (let i = 0; i < c.bytecode!.functions.length; i++) {
  console.log(`\n${c.bytecode!.functions[i].name}:`);
  for (const l of disassemble(c.bytecode!, i)) console.log(`  ${String(l.pc).padStart(4)}  ${l.text.padEnd(36)} ${l.effect.padEnd(6)} line ${l.line}`);
}
const vm = runVM(c.bytecode!, c.data, c.limits);
const ref = interpret(c.program!, c.check!, c.data, c.limits);
console.log(`VM:        ${sceneHash(vm.scene).slice(0, 16)}  frames ${vm.scene.frames.length}  shapes ${vm.stats.draws}  steps ${vm.steps.reduce((a, b) => a + b, 0)}${vm.fault ? `  FAULT ${vm.fault.code} line ${vm.fault.span?.line}: ${vm.fault.message}` : ''}`);
console.log(`reference: ${sceneHash(ref.scene).slice(0, 16)}${ref.fault ? `  FAULT ${ref.fault.code} line ${ref.fault.span?.line}` : ''}`);
console.log(sceneHash(vm.scene) === sceneHash(ref.scene) ? 'AGREE' : 'DIVERGE');
