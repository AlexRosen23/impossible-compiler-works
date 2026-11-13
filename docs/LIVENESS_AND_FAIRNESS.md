# Liveness and fairness

## Invariant versus liveness

An **invariant** (safety) says "nothing bad ever happens"; a counterexample is a *finite*
path to a bad state. A **liveness** property says "something good eventually happens"; a
counterexample is an *infinite* behaviour in which the good thing never happens. On a finite
graph such a behaviour is a **lasso**: a prefix followed by a loop repeated forever, or a state
where the system stops (stutters) forever.

Reachability alone cannot prove liveness: the graph may show that the goal *can* be reached
while some fair schedule still avoids it forever. `bounded-counter-unfair` shows the opposite
direction too: the goal is reachable, yet `eventually count = 3` fails because nothing forces
the counter to move.

## Supported properties

- `liveness L: eventually q` — TLA+ `<>q`
- `liveness L: p leadsto q` — TLA+ `p ~> q` (that is, `[](p => <>q)`)

Anything else (nested temporal operators, `always`, `until`, CTL path quantifiers) is
refused at compile time.

## Semantics (identical to TLA+ / TLC)

- Behaviours may **stutter**: a step that changes nothing is always allowed, including forever.
  Without fairness, almost every liveness property is violated by stopping.
- `fairness weak P` = `WF_vars(P.a1 ∨ P.a2 ∨ …)`: if some action of `P` stays continuously
  enabled, `P` eventually takes a step. `fairness weak P.a` restricts this to action family `a`
  (all its parameter instances).
- `fairness strong P` / `strong P.a` = `SF_vars(…)`: if enabled infinitely often, taken
  infinitely often.
- "Enabled" and "taken" refer to `⟨A⟩_vars` steps, i.e. steps that change the state; a
  self-loop counts as neither.
- Liveness is checked by the internal engine only on a **complete** graph; on an incomplete
  graph the status is `INCOMPLETE`. If the model has domain violations or evaluation errors the
  status is `ERROR` (its behaviours are not well defined).

## The starvation trio (examples/starvation-*.witness)

| variant | fairness | verdict for `B.pc = waiting leadsto B.pc = critical` | why |
|---|---|---|---|
| unfair | none | VIOLATED — stutter | everyone may stop forever |
| weak | WF(A), WF(B) | VIOLATED — fair cycle | A loops idle→waiting→critical; B's acquire is enabled only while the lock is free, so it is not *continuously* enabled and WF never forces it |
| strong | WF(A), SF(B) | VERIFIED_BOUNDED | B's acquire is enabled infinitely often, so SF forces it |

The lesson the UI teaches: adding fairness changes a verdict only when it is encoded on the
right action with the right strength. `polite-livelock` shows a fair livelock (every process
keeps moving under WF and nobody enters); `peterson` shows starvation freedom under WF.

## Who checked what

Every liveness verdict shown in the app comes from the internal engine. TLC re-checks the
same properties (exported as `PROPERTY` with `WF_vars`/`SF_vars` in `Spec`) in the Proof
Observatory, and every TLC lasso is re-derived by the independent replay evaluator, including
its fairness. Results: `evidence/tlc-crosscheck.md` (all liveness verdicts agree; lasso lengths
differ, as expected).

## Limitations

Only weak/strong fairness over action families or whole processes; no fairness on arbitrary
state predicates. Lassos are not minimal. No liveness on incomplete graphs, so state explosion
also limits liveness.
