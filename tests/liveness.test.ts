import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, run, prop } from './helpers.ts';
import { replayTrace } from '../src/core/replay/replay.ts';

const live = (slug: string, name: string) => prop(run(example(slug)).result, name);

test('without fairness, eventually fails by stuttering forever at the initial state', () => {
  const p = live('bounded-counter-unfair', 'ReachesThree');
  assert.equal(p.status, 'VIOLATED');
  assert.equal(p.trace!.stutterForever, true);
  assert.equal(p.trace!.steps.length, 2);
  assert.equal(p.trace!.steps[1].stutter, true);
});

test('with weak fairness the same counter must reach 3', () => {
  assert.equal(live('bounded-counter', 'ReachesThree').status, 'VERIFIED_BOUNDED');
});

test('starvation: no fairness -> stutter, weak fairness -> fair cycle, strong fairness -> holds', () => {
  const u = live('starvation-unfair', 'BEventuallyEnters');
  assert.equal(u.status, 'VIOLATED');
  assert.equal(u.trace!.stutterForever, true);
  const w = live('starvation-weak', 'BEventuallyEnters');
  assert.equal(w.status, 'VIOLATED');
  assert.equal(w.trace!.stutterForever, false);
  // the loop never takes a step of B
  const loop = w.trace!.steps.slice(w.trace!.loopStart! + 1);
  assert.ok(loop.every((s) => s.process !== 'B'));
  assert.equal(live('starvation-strong', 'BEventuallyEnters').status, 'VERIFIED_BOUNDED');
});

test('livelock is a fair cycle; Peterson is starvation-free under weak fairness', () => {
  const l = live('polite-livelock', 'AEventuallyEnters');
  assert.equal(l.status, 'VIOLATED');
  assert.equal(l.trace!.stutterForever, false);
  assert.equal(live('peterson', 'AEventuallyEnters').status, 'VERIFIED_BOUNDED');
  assert.equal(live('peterson', 'BEventuallyEnters').status, 'VERIFIED_BOUNDED');
});

test('every lasso is re-derived by the independent evaluator, including its fairness', () => {
  for (const [slug, name] of [['bounded-counter-unfair', 'ReachesThree'], ['starvation-unfair', 'BEventuallyEnters'], ['starvation-weak', 'BEventuallyEnters'], ['polite-livelock', 'AEventuallyEnters']]) {
    const t = live(slug, name).trace!;
    const r = replayTrace(example(slug), t.steps.map((s) => ({ action: s.stutter ? null : s.action, state: s.state, stutter: s.stutter })), { kind: 'liveness', property: name, loopStart: t.loopStart, stutterForever: t.stutterForever });
    assert.ok(r.ok, `${slug}: ${r.reason}`);
  }
});

test('a weak-fairness lasso is rejected by replay when strong fairness is declared instead', () => {
  const t = live('starvation-weak', 'BEventuallyEnters').trace!;
  const strongSrc = example('starvation-strong');
  const r = replayTrace(strongSrc.replace('model starvation_strong', 'model starvation_strong'), t.steps.map((s) => ({ action: s.stutter ? null : s.action, state: s.state, stutter: s.stutter })), { kind: 'liveness', property: 'BEventuallyEnters', loopStart: t.loopStart });
  assert.equal(r.ok, false);
  assert.match(r.reason, /violates SF\(B\)/);
});

test('liveness gives no verdict on an incomplete graph', () => {
  const p = prop(run(example('producer-consumer-bounded'), { maxStates: 3 }).result, 'AllConsumed');
  assert.equal(p.status, 'INCOMPLETE');
});

test('strongly connected components are reported for the Temporal Observatory', () => {
  const { result } = run(example('polite-livelock'));
  assert.ok((result.stats.nontrivialSccs ?? 0) >= 1);
  const { result: dag } = run(example('counter-race'));
  assert.equal(dag.stats.nontrivialSccs, 0);
});
