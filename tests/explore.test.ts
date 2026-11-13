import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, run, prop, compileOk } from './helpers.ts';
import { stateKey, stateDigest } from '../src/core/engine/state.ts';
import { explore } from '../src/core/engine/explore.ts';

test('hand oracle: broken two-thread counter has exactly 13 states, 14 edges and a 4-step shortest witness', () => {
  const { result } = run(example('counter-race'));
  assert.equal(result.complete, true);
  assert.equal(result.stats.states, 13);
  assert.equal(result.stats.edges, 14);
  assert.equal(result.stats.terminals, 3);
  const p = prop(result, 'NoLostUpdate');
  assert.equal(p.status, 'VIOLATED');
  assert.deepEqual(p.trace!.steps.map((s) => s.action), [null, 'A.read', 'B.read', 'A.write', 'B.write']);
  assert.equal(p.trace!.steps.at(-1)!.state.counter, 1);
  assert.equal(p.violatingStates, 1);
});

test('hand oracle: atomic counter has 4 states and verifies in the bounded model', () => {
  const { result } = run(example('counter-atomic'));
  assert.equal(result.stats.states, 4);
  assert.equal(result.verdict, 'NO_VIOLATION_IN_BOUNDED_MODEL');
  assert.equal(prop(result, 'NoLostUpdate').status, 'VERIFIED_BOUNDED');
});

test('hand oracle: three independent counters give 10^3 states and 3*900 edges', () => {
  const { result } = run(example('state-explosion'));
  assert.equal(result.stats.states, 1000);
  assert.equal(result.stats.edges, 2700);
  assert.equal(result.stats.maxDepth, 27);
});

test('a state cap yields INCOMPLETE, never a safety verdict', () => {
  const { result } = run(example('state-explosion'), { maxStates: 50 });
  assert.equal(result.complete, false);
  assert.equal(result.capReason, 'maxStates');
  assert.equal(result.verdict, 'INCOMPLETE');
  assert.equal(result.stats.states, 50);
  for (const p of result.properties) assert.notEqual(p.status, 'VERIFIED_BOUNDED', p.name);
  assert.ok(result.limitations[0].startsWith('INCOMPLETE'));
});

test('a violation found before a cap is still a real violation', () => {
  const full = run(example('counter-race'));
  const bad = full.exploration.invariantViolations[0][0];
  assert.ok(bad + 1 < 13, 'the violating state is not the last one discovered');
  const { result } = run(example('counter-race'), { maxStates: bad + 1 });
  assert.equal(result.complete, false);
  assert.equal(prop(result, 'NoLostUpdate').status, 'VIOLATED');
  assert.equal(result.verdict, 'VIOLATION_FOUND');
});

test('depth and edge caps are reported as such', () => {
  assert.equal(run(example('state-explosion'), { maxDepth: 5 }).result.capReason, 'maxDepth');
  assert.equal(run(example('state-explosion'), { maxEdges: 100 }).result.capReason, 'maxEdges');
});

test('deadlock is distinguished from intended termination', () => {
  const dl = run(example('lock-order-deadlock')).result;
  const d = prop(dl, 'DeadlockFreedom');
  assert.equal(d.status, 'VIOLATED');
  assert.equal(d.trace!.length, 2);
  const st = d.trace!.steps.at(-1)!.state;
  assert.equal(st.lock1, 'A');
  assert.equal(st.lock2, 'B');
  assert.equal(prop(run(example('lock-order-fixed')).result, 'DeadlockFreedom').status, 'VERIFIED_BOUNDED');
  // without a terminal declaration, finished runs ARE deadlocks
  const noTerm = run('model m\nvar x : 0..1 = 0\nprocess P { action a when x = 0 { x := 1 } }').result;
  assert.equal(prop(noTerm, 'DeadlockFreedom').status, 'VIOLATED');
});

test('an assignment outside the declared domain is reported with its witness (TypeOK)', () => {
  const { result } = run('model m\nvar x : 0..2 = 0\nprocess P { action inc { x := x + 1 } }');
  const t = prop(result, 'TypeOK');
  assert.equal(t.status, 'VIOLATED');
  assert.equal(t.trace!.length, 3);
  assert.deepEqual(t.trace!.badWrite, { variable: 'x', value: 3 });
  assert.equal(result.stats.states, 3);
});

test('nondeterministic initial values produce one initial state per combination', () => {
  const { result } = run('model m\nvar x : 0..3 in 0..1\nvar b : bool in bool\nprocess P { action a when x < 3 { x := x + 1 } }\nterminal x = 3');
  assert.equal(result.stats.initialStates, 4);
});

test('evaluation errors are surfaced, not swallowed', () => {
  const { result } = run('model m\nvar x : 0..2 = 0\nprocess P { action a when x % (x - x) = 0 { x := 1 } }');
  assert.equal(result.verdict, 'ERROR');
  assert.match(result.evalFailures[0].message, /modulo/);
});

test('canonical state keys are exact and order-stable; digests do not depend on object key order', () => {
  assert.equal(stateKey(Int32Array.from([1, 0, 2])), '1,0,2');
  assert.notEqual(stateKey(Int32Array.from([1, 10])), stateKey(Int32Array.from([11, 0])));
  const m = compileOk(example('counter-race'));
  const a = stateDigest(m, Int32Array.from([0, 0, 0, 0, 0]));
  const b = stateDigest(m, [0, 0, 0, 0, 0]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('exploration is deterministic: identical runs give identical graphs', () => {
  const m = compileOk(example('two-phase-presumed-commit'));
  const a = explore(m);
  const b = explore(m);
  assert.deepEqual(a.edgeTo, b.edgeTo);
  assert.deepEqual(a.states.map((s) => stateKey(s)), b.states.map((s) => stateKey(s)));
});

test('BFS witnesses are minimal: no violating state exists at a smaller depth', () => {
  for (const slug of ['counter-race', 'inventory-race', 'bank-transfer-race', 'queue-redelivery', 'two-phase-presumed-commit']) {
    const { result, exploration } = run(example(slug));
    for (const p of result.properties.filter((x) => x.kind === 'invariant' && x.status === 'VIOLATED')) {
      const k = exploration.model.invariants.findIndex((i) => i.name === p.name);
      const minDepth = Math.min(...exploration.invariantViolations[k].map((s) => exploration.depth[s]));
      assert.equal(p.trace!.length, minDepth, `${slug}/${p.name}`);
    }
  }
});

test('the graph payload flags initial, witness, violating and terminal states', () => {
  const { result } = run(example('counter-race'));
  const g = result.graph!;
  assert.equal(g.nodes.length, 13);
  assert.ok(g.nodes[0].flags & 1);
  assert.equal(g.nodes.filter((n) => n.flags & 32).length, 5);
  assert.equal(g.nodes.filter((n) => n.flags & 8).length, 3);
});
