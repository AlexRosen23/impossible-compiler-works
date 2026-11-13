// The cross-feature: the Witness engine model-checks the Compiler wing's optimizer over every pass order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkPassOrders, abstractPassOrders, toWml, readSeed, SAFE_ALPHABET, MUTANT_ALPHABET, REPO } from '../pass-orders.ts';
import { verifyReceipt, replayWitness, witnessFromTrace } from '../../src/core/receipt/receipt.ts';

const EVIDENCE = path.join(REPO, 'evidence', 'bridge');

test('safe passes in any order never diverge from the reference interpreter (two seeds, complete abstraction)', () => {
  for (const seed of ['13-optimizer-bench', 'fault-lab-commute']) {
    const r = checkPassOrders(seed, SAFE_ALPHABET);
    assert.equal(r.abstraction.complete, true, `${seed}: abstraction must be complete`);
    assert.ok(r.abstraction.states.length > 1, `${seed}: passes must actually change the IR`);
    assert.ok(r.abstraction.states.every((s) => s.label === 'agree'), `${seed}: every reachable module agrees`);
    assert.equal(r.verdict, 'NO_DIVERGENCE_IN_ANY_PASS_ORDER');
    assert.equal(r.result.properties.find((p) => p.name === 'OptimizedMatchesReference')?.status, 'VERIFIED_BOUNDED');
    // The Witness search visits exactly the abstract programs (agree is a function of prog).
    assert.equal(r.result.stats.states, r.abstraction.states.length);
  }
});

test('negative control: the deliberately wrong pass is caught with the shortest pass sequence', () => {
  const r = checkPassOrders('fault-lab-commute', MUTANT_ALPHABET);
  assert.equal(r.verdict, 'DIVERGENCE_FOUND');
  assert.deepEqual(r.shortestPassSequence, ['BAD_cse_commute_all']);
  assert.ok(r.abstraction.states.some((s) => s.label === 'diverge'));
  const inv = r.result.properties.find((p) => p.name === 'OptimizedMatchesReference')!;
  assert.equal(inv.status, 'VIOLATED');
  // The counterexample replays independently (the Witness replay engine, not the explorer).
  const replay = replayWitness(r.wml, witnessFromTrace(inv.trace!));
  assert.equal(replay.ok, true, JSON.stringify(replay).slice(0, 300));
});

test('the wrong pass is harmless on a seed with no subtraction to commute (the check is not vacuous either way)', () => {
  const r = checkPassOrders('13-optimizer-bench', MUTANT_ALPHABET);
  assert.equal(r.verdict, 'NO_DIVERGENCE_IN_ANY_PASS_ORDER');
});

test('the generated model is deterministic and the shipped evidence regenerates byte-for-byte from the FOLIO seed', () => {
  for (const [seed, kind, alphabet] of [['13-optimizer-bench', 'safe', SAFE_ALPHABET], ['fault-lab-commute', 'safe', SAFE_ALPHABET], ['13-optimizer-bench', 'mutant', MUTANT_ALPHABET], ['fault-lab-commute', 'mutant', MUTANT_ALPHABET]] as const) {
    const wml = toWml(abstractPassOrders(seed, readSeed(seed), [...alphabet]));
    assert.equal(wml, readFileSync(path.join(EVIDENCE, `${seed}.${kind}.witness`), 'utf8'), `${seed}.${kind}: regenerate with node bridge/pass-orders.ts [--mutant] <seed> --write evidence/bridge`);
  }
});

test('bridge receipts verify (re-run) and a tampered one is rejected', () => {
  for (const f of ['13-optimizer-bench.safe', 'fault-lab-commute.safe', 'fault-lab-commute.mutant']) {
    const rep = verifyReceipt(JSON.parse(readFileSync(path.join(EVIDENCE, `${f}.receipt.json`), 'utf8')), { rerun: true });
    assert.equal(rep.verdict, 'VALID', `${f}: ${rep.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`);
  }
  const t = JSON.parse(readFileSync(path.join(EVIDENCE, 'fault-lab-commute.mutant.receipt.json'), 'utf8'));
  t.result.verdict = 'NO_VIOLATION_IN_BOUNDED_MODEL';
  assert.equal(verifyReceipt(t, { rerun: true }).verdict, 'REJECTED');
});

test('seed names cannot walk out of the examples folder', () => {
  assert.throws(() => readSeed('../../package'), /bad seed name/);
  assert.throws(() => readSeed('/etc/passwd'), /bad seed name/);
});
