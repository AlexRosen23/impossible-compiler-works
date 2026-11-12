// node scripts/reproduce.ts <receipt.json> [bytecode.json]
// Re-checks a receipt in a fresh process: pinned versions, source and fixture hashes, recompilation to the same
// bytecode hash, VM re-execution to the same trace and scene hashes, and the independent reference interpreter.
// Exit 0 only if every check passes; 1 if any fails; 2 on usage errors.
import { readFileSync } from 'node:fs';
import { type Receipt, reproduce } from '../core/index.ts';

const [file, bcFile] = process.argv.slice(2);
if (!file) { console.error('usage: reproduce <receipt.json> [bytecode.json]'); process.exit(2); }
let receipt: Receipt, bc: unknown;
try {
  receipt = JSON.parse(readFileSync(file, 'utf8'));
  bc = bcFile ? JSON.parse(readFileSync(bcFile, 'utf8')) : undefined;
} catch (e) { console.error(`cannot read input: ${(e as Error).message}`); process.exit(2); }
const checks = reproduce(receipt, bc);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n      expected ${c.expected}\n      actual   ${c.actual}`}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED: this receipt does not reproduce.` : `\nAll ${checks.length} checks passed: reproduced.`);
process.exit(failed ? 1 : 0);
