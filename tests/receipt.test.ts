import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, run } from './helpers.ts';
import { buildReceipt, verifyReceipt, digestOf, canonicalJson } from '../src/core/receipt/receipt.ts';

const make = (slug: string, bounds?: { maxStates?: number }) => {
  const s = example(slug);
  return buildReceipt(s, run(s, bounds).result);
};

test('canonical JSON sorts keys and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalJson({ a: Infinity }));
});

test('a fresh receipt verifies: digest, source hash, replay and re-run all agree', () => {
  const r = make('counter-race');
  assert.ok(r.replay.every((x) => x.ok));
  const v = verifyReceipt(JSON.parse(JSON.stringify(r)));
  assert.equal(v.verdict, 'VALID', JSON.stringify(v.checks.filter((c) => !c.ok)));
});

test('editing any field breaks the digest', () => {
  const r = JSON.parse(JSON.stringify(make('counter-race')));
  r.result.verdict = 'NO_VIOLATION_IN_BOUNDED_MODEL';
  const v = verifyReceipt(r);
  assert.equal(v.verdict, 'REJECTED');
  assert.equal(v.checks.find((c) => c.name === 'digest')!.ok, false);
});

test('a forger who recomputes the digest is still caught by re-running and replay', () => {
  const r = JSON.parse(JSON.stringify(make('counter-race')));
  r.result.verdict = 'NO_VIOLATION_IN_BOUNDED_MODEL';
  r.witnesses[0].steps[4].state.counter = 2;
  r.digest = digestOf(r);
  const v = verifyReceipt(r);
  assert.equal(v.verdict, 'REJECTED');
  assert.equal(v.checks.find((c) => c.name === 'digest')!.ok, true);
  assert.equal(v.checks.find((c) => c.name === 'rerun:verdict')!.ok, false);
  assert.equal(v.checks.find((c) => c.name === 'replay:NoLostUpdate')!.ok, false);
});

test('changing the embedded model is detected by the source hash', () => {
  const r = JSON.parse(JSON.stringify(make('counter-race')));
  r.model.source = r.model.source.replace('counter := tmp + 1', 'counter := counter + 1');
  r.digest = digestOf(r);
  assert.equal(verifyReceipt(r).checks.find((c) => c.name === 'source-hash')!.ok, false);
});

test('INCOMPLETE receipts stay INCOMPLETE and verify as such (journey 6)', () => {
  const r = make('state-explosion', { maxStates: 50 });
  assert.equal(r.result.verdict, 'INCOMPLETE');
  assert.equal(r.result.complete, false);
  assert.equal(verifyReceipt(JSON.parse(JSON.stringify(r))).verdict, 'VALID');
  const forged = JSON.parse(JSON.stringify(r));
  forged.result.verdict = 'NO_VIOLATION_IN_BOUNDED_MODEL';
  forged.result.complete = true;
  forged.digest = digestOf(forged);
  const v = verifyReceipt(forged);
  assert.equal(v.verdict, 'REJECTED');
  assert.equal(v.checks.find((c) => c.name === 'rerun:completeness')!.ok, false);
});

test('incompatible or malformed receipts are rejected without crashing', () => {
  const r = JSON.parse(JSON.stringify(make('counter-atomic')));
  r.schemaVersion = 99;
  assert.match(verifyReceipt(r).checks[0].detail, /schema version 99/);
  assert.equal(verifyReceipt(null).verdict, 'REJECTED');
  assert.equal(verifyReceipt([]).verdict, 'REJECTED');
  assert.equal(verifyReceipt({ schema: 'impossible-witness/receipt', schemaVersion: 1 }).verdict, 'REJECTED');
  assert.equal(verifyReceipt({ schema: 'something-else' }).verdict, 'REJECTED');
});

test('liveness and deadlock receipts verify', () => {
  for (const slug of ['starvation-weak', 'lock-order-deadlock', 'bounded-counter-unfair']) {
    const v = verifyReceipt(JSON.parse(JSON.stringify(make(slug))));
    assert.equal(v.verdict, 'VALID', `${slug}: ${JSON.stringify(v.checks.filter((c) => !c.ok))}`);
  }
});
