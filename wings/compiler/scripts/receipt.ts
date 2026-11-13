// node scripts/receipt.ts <file.folio> [outDir]  → writes receipt.json and bytecode.json for a program.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SAFE_PASSES, makeReceipt } from '../core/index.ts';
import { ROOT, gitCommit, loadExampleFixtures } from './lib.ts';

const file = process.argv[2];
if (!file) { console.error('usage: receipt <file.folio> [outDir]'); process.exit(2); }
const out = process.argv[3] ?? join(ROOT, 'evidence', 'receipts', basename(file, '.folio'));
const source = readFileSync(file, 'utf8');
// Embed only the fixtures the program declares.
const all = loadExampleFixtures();
const used = Object.fromEntries(Object.entries(all).filter(([k]) => source.includes(`"${k}"`)));
const { receipt, compiled } = makeReceipt({ project: basename(file), source, fixtures: used, passes: SAFE_PASSES, commit: gitCommit() });
if (!receipt) { console.error(compiled.diagnostics.map((d) => `${d.code}@${d.span.line}:${d.span.col} ${d.message}`).join('\n')); process.exit(1); }
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
writeFileSync(join(out, 'bytecode.json'), JSON.stringify(compiled.bytecode) + '\n');
console.log(`wrote ${join(out, 'receipt.json')}  scene ${receipt.sceneHash.slice(0, 16)}  oracle agrees: ${receipt.oracle.agrees}`);
