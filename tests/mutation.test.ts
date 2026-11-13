import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example } from './helpers.ts';
import { generateMutants, runMutants } from '../src/core/model/mutate.ts';

test('mutants of a repaired model are real, compilable source', () => {
  const ms = generateMutants(example('mutex-test-and-set'));
  assert.ok(ms.length >= 3);
  assert.ok(ms.some((m) => m.operator === 'drop-guard'));
});

test('removing the lock guard is killed by MutualExclusion', () => {
  const r = runMutants(example('mutex-test-and-set'));
  const dropAcquireGuard = r.results.find((m) => m.operator === 'drop-guard' && m.description.includes('acquire'))!;
  assert.equal(dropAcquireGuard.outcome, 'KILLED');
  assert.equal(dropAcquireGuard.killedBy, 'MutualExclusion');
});

test('dropping the idempotency bookkeeping is killed (duplicate output returns)', () => {
  const r = runMutants(example('queue-idempotent'));
  const m = r.results.find((x) => x.operator === 'drop-assignment' && x.description.includes('seen_id'))!;
  assert.equal(m.outcome, 'KILLED');
  assert.equal(m.killedBy, 'EffectAtMostOnce');
});

test('weakening strong fairness to weak is killed by the starvation property', () => {
  const r = runMutants(example('starvation-strong'));
  const m = r.results.find((x) => x.operator === 'weaken-fairness')!;
  assert.equal(m.outcome, 'KILLED');
  assert.equal(m.killedBy, 'BEventuallyEnters');
  assert.match(r.score, /^\d+\/\d+ mutants killed$/);
});
