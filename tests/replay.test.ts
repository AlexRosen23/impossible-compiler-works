import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, run, prop } from './helpers.ts';
import { replayTrace, type ReplayStep } from '../src/core/replay/replay.ts';

const src = example('counter-race');
const trace = (): ReplayStep[] => prop(run(src).result, 'NoLostUpdate').trace!.steps.map((s) => ({ action: s.action, state: { ...s.state } }));

test('a genuine witness replays', () => {
  const r = replayTrace(src, trace(), { kind: 'invariant', property: 'NoLostUpdate' });
  assert.ok(r.ok, r.reason);
  assert.equal(r.checkedSteps, 5);
});

test('forged traces are rejected with the failing step', () => {
  const bad1 = trace(); bad1[4].state.counter = 2;
  assert.match(replayTrace(src, bad1, { kind: 'invariant', property: 'NoLostUpdate' }).reason, /step 4: B.write does not produce/);
  const bad2 = trace(); bad2[2].action = 'A.read';
  assert.match(replayTrace(src, bad2, { kind: 'invariant', property: 'NoLostUpdate' }).reason, /step 2: A.read is not enabled/);
  const bad3 = trace(); bad3[0].state.counter = 1;
  assert.match(replayTrace(src, bad3, { kind: 'invariant', property: 'NoLostUpdate' }).reason, /not an initial state/);
  const bad4 = trace(); bad4[1].action = 'A.teleport';
  assert.match(replayTrace(src, bad4, { kind: 'invariant', property: 'NoLostUpdate' }).reason, /unknown action/);
  const bad5 = trace(); delete (bad5[1].state as Record<string, unknown>)['B.tmp'];
  assert.match(replayTrace(src, bad5, { kind: 'invariant', property: 'NoLostUpdate' }).reason, /exactly the model's variables/);
  const bad6 = trace(); bad6[3].state['A.tmp'] = 7;
  assert.equal(replayTrace(src, bad6, { kind: 'invariant', property: 'NoLostUpdate' }).ok, false);
});

test('a valid trace that does not violate the claimed property is rejected', () => {
  const ok = trace().slice(0, 4);
  assert.match(replayTrace(src, ok, { kind: 'invariant', property: 'NoLostUpdate' }).reason, /holds in the final state/);
});

test('a fake deadlock claim is rejected', () => {
  assert.match(replayTrace(src, trace().slice(0, 2), { kind: 'deadlock', property: 'DeadlockFreedom' }).reason, /not deadlocked/);
  const atomic = example('counter-atomic');
  const done = prop(run(atomic).result, 'NoLostUpdate');
  void done;
  const steps = [
    { action: null, state: { counter: 0, 'A.pc': 'start', 'B.pc': 'start' } },
    { action: 'A.increment', state: { counter: 1, 'A.pc': 'done', 'B.pc': 'start' } },
    { action: 'B.increment', state: { counter: 2, 'A.pc': 'done', 'B.pc': 'done' } },
  ];
  assert.match(replayTrace(atomic, steps, { kind: 'deadlock', property: 'DeadlockFreedom' }).reason, /terminal condition/);
});

test('the replay evaluator rejects values outside declared domains', () => {
  const t = trace(); t[0].state['A.pc'] = 'nonsense';
  assert.equal(replayTrace(src, t, { kind: 'none', property: '' }).ok, false);
});

test('replay of every example witness succeeds', async () => {
  const { readdirSync } = await import('node:fs');
  const { ROOT } = await import('./helpers.ts');
  for (const f of readdirSync(`${ROOT}/examples`).filter((x) => x.endsWith('.witness') && x !== 'benchmark-grid.witness')) {
    const s = example(f.replace('.witness', ''));
    for (const p of run(s).result.properties.filter((x) => x.trace)) {
      const t = p.trace!;
      const kind = t.kind === 'eval-error' ? 'none' : t.kind;
      const r = replayTrace(s, t.steps.map((x) => ({ action: x.stutter ? null : x.action, state: x.state, stutter: x.stutter })), { kind, property: p.name === 'DeadlockFreedom' ? 'DeadlockFreedom' : t.property, loopStart: t.loopStart, stutterForever: t.stutterForever, badWrite: t.badWrite });
      assert.ok(r.ok, `${f}/${p.name}: ${r.reason}`);
    }
  }
});
