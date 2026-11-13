import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, example, compileOk, run, prop } from './helpers.ts';
import { exportTla } from '../src/core/tla/export.ts';
import { parseTlcOutput, tlcAvailability, runTlcCrossCheck } from '../src/core/tla/tlc.ts';
import { replayTrace } from '../src/core/replay/replay.ts';

const fx = (f: string) => readFileSync(path.join(ROOT, 'tests/fixtures/tlc', f), 'utf8');
const toWml = (slug: string, steps: { action: string | null; state: Record<string, unknown>; stutter?: boolean }[]) => {
  const m = compileOk(example(slug));
  const ex = exportTla(m);
  return steps.map((s) => ({ ...s, state: Object.fromEntries(m.vars.map((v, i) => [v.name, s.state[ex.varNames[i]]])) as Record<string, number | boolean | string> }));
};

test('the exporter emits a complete module: variables, TypeOK, Init, one operator per action, fairness, properties', () => {
  const ex = exportTla(compileOk(example('starvation-strong')));
  for (const s of ['---- MODULE Witness_starvation_strong ----', 'EXTENDS Integers', 'VARIABLES locked, A_pc, B_pc', 'TypeOK ==', 'Init ==', 'A_acquire ==', "locked' = TRUE", 'UNCHANGED <<B_pc>>', 'WF_vars(A_request \\/ A_acquire \\/ A_release)', 'SF_vars(B_request \\/ B_acquire \\/ B_release)', 'Spec == Init /\\ [][Next]_vars /\\ Fairness', '~>', '====']) {
    assert.ok(ex.tla.includes(s), `missing: ${s}`);
  }
  assert.equal(ex.opToLabel.B_acquire, 'B.acquire');
});

test('terminal states become a Terminating stutter disjunct; reserved names are escaped', () => {
  const ex = exportTla(compileOk('model m\nvar Init : 0..1 = 0\nprocess P { action a when Init = 0 { Init := 1 } }\nterminal Init = 1'));
  assert.match(ex.tla, /VARIABLES Init_\n/);
  assert.match(ex.tla, /Terminating == \(Init_ = 1\) \/\\ UNCHANGED vars/);
});

test('recorded TLC output: invariant violation parses to a 4-step trace that replays independently', () => {
  const ex = exportTla(compileOk(example('counter-race')));
  const r = parseTlcOutput(fx('counter-race.inv-NoLostUpdate.out'), ex);
  assert.equal(r.status, 'INVARIANT_VIOLATED');
  assert.equal(r.violated, 'NoLostUpdate');
  assert.equal(r.trace!.length, 5);
  assert.match(r.version!, /TLC2 Version 2\.19/);
  const rr = replayTrace(example('counter-race'), toWml('counter-race', r.trace!), { kind: 'invariant', property: 'NoLostUpdate' });
  assert.ok(rr.ok, rr.reason);
});

test('recorded TLC output: a temporal lasso with "Back to state" parses and replays with fairness', () => {
  const ex = exportTla(compileOk(example('starvation-weak')));
  const r = parseTlcOutput(fx('starvation-weak.live-BEventuallyEnters.out'), ex);
  assert.equal(r.status, 'TEMPORAL_VIOLATED');
  assert.ok(r.loopStart !== undefined);
  const rr = replayTrace(example('starvation-weak'), toWml('starvation-weak', r.trace!), { kind: 'liveness', property: 'BEventuallyEnters', loopStart: r.loopStart });
  assert.ok(rr.ok, rr.reason);
});

test('recorded TLC output: stuttering lasso, deadlock and full-count runs parse', () => {
  const st = parseTlcOutput(fx('bounded-counter-unfair.live-ReachesThree.out'), exportTla(compileOk(example('bounded-counter-unfair'))));
  assert.equal(st.status, 'TEMPORAL_VIOLATED');
  assert.equal(st.stutterForever, true);
  const dl = parseTlcOutput(fx('lock-order-deadlock.deadlock.out'), exportTla(compileOk(example('lock-order-deadlock'))));
  assert.equal(dl.status, 'DEADLOCK');
  assert.equal(dl.trace!.length, 3);
  const full = parseTlcOutput(fx('counter-atomic.full.out'), exportTla(compileOk(example('counter-atomic'))));
  assert.equal(full.status, 'NO_ERROR');
  assert.equal(full.distinctStates, run(example('counter-atomic')).result.stats.states);
});

test('garbage or truncated TLC output is a TLC_ERROR, never a pass', () => {
  const ex = exportTla(compileOk(example('counter-race')));
  assert.equal(parseTlcOutput('', ex).status, 'TLC_ERROR');
  assert.equal(parseTlcOutput('Model checking completed. No error has been found.', ex).status, 'TLC_ERROR');
  assert.equal(parseTlcOutput('@!@!@STARTMSG 1000:1 @!@!@\nsyntax error\n@!@!@ENDMSG 1000 @!@!@', ex).status, 'TLC_ERROR');
});

test('live TLC cross-check (skipped when no Java runtime is available)', async (t) => {
  const a = await tlcAvailability();
  if (!a.available) { t.skip(`INTERNAL_ONLY: ${a.reason}`); return; }
  const src = example('counter-race');
  const r = await runTlcCrossCheck(src, compileOk(src), run(src).result);
  assert.ok(r.comparison!.every((c) => c.agree), JSON.stringify(r.comparison));
  assert.equal(prop(run(src).result, 'NoLostUpdate').trace!.length, 4);
});
