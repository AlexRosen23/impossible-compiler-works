// Every receipt written before the merge must still replay or verify inside THE IMPOSSIBLE COMPILER WORKS.
// Witness wing: evidence/demo/*.receipt.json (re-run + trace replay). Compiler wing (formerly PAPER TIGER):
// wings/compiler/evidence/receipts/*/receipt.json (recompile, VM re-run, reference interpreter, every pinned hash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyReceipt } from '../src/core/receipt/receipt.ts';
import { reproduce, receiptShape, type Receipt as CompilerReceipt } from '../wings/compiler/core/index.ts';
import { ROOT } from './helpers.ts';

const WITNESS_DIR = path.join(ROOT, 'evidence', 'demo');
const COMPILER_DIR = path.join(ROOT, 'wings', 'compiler', 'evidence', 'receipts');
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

test('legacy Witness wing receipts (made by The Impossible Witness 0.1.0) still verify with a full re-run', () => {
  const files = readdirSync(WITNESS_DIR).filter((f) => f.endsWith('.receipt.json'));
  assert.ok(files.length >= 4, 'expected the shipped demo receipts');
  for (const f of files) {
    const rep = verifyReceipt(json(path.join(WITNESS_DIR, f)), { rerun: true });
    assert.equal(rep.verdict, 'VALID', `${f}: ${rep.checks.filter((c) => !c.ok).map((c) => `${c.name} ${c.detail}`).join('; ')}`);
  }
  assert.equal(verifyReceipt(json(path.join(WITNESS_DIR, 'counter-race.TAMPERED.json')), { rerun: true }).verdict, 'REJECTED');
});

test('legacy Compiler wing receipts (made by PAPER TIGER 0.2.0) still reproduce: bytecode, VM trace, scene, oracle', () => {
  const runs = readdirSync(COMPILER_DIR);
  assert.ok(runs.length >= 3, 'expected the shipped Compiler wing receipts');
  for (const run of runs) {
    const r = json(path.join(COMPILER_DIR, run, 'receipt.json')) as CompilerReceipt;
    assert.equal(receiptShape(r), null, `${run}: shape`);
    const checks = reproduce(r, json(path.join(COMPILER_DIR, run, 'bytecode.json')));
    assert.ok(checks.length >= 5, `${run}: expected the full reproduce check list`);
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name), [], `${run}: every check passes`);
  }
  const t = json(path.join(COMPILER_DIR, runs[0], 'receipt.json')) as CompilerReceipt;
  t.source = t.source.replace(/\d/, (d) => String((Number(d) + 1) % 10));
  assert.ok(reproduce(t).some((c) => !c.ok), 'a tampered Compiler wing receipt must not reproduce');
});
