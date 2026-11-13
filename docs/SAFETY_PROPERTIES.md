# Safety properties

## Kinds

- **Invariants** (`invariant Name: expr`) — evaluated on every reachable state as it is discovered.
- **DeadlockFreedom** — implicit; see `TRANSITION_SEMANTICS.md` §5.
- **TypeOK** — implicit domain safety: no step may write a value outside a declared domain.

## Statuses (per property)

| status | meaning |
|---|---|
| `VERIFIED_BOUNDED` | holds in **every** reachable state of this finite model; the exploration was exhaustive (no cap hit). Not a proof about any implementation. |
| `VIOLATED` | a reachable state violates it; a shortest witness (BFS) is attached and has been replayed independently. Valid even if the run later hit a cap. |
| `INCOMPLETE` | no violation among the states explored before a cap. Says nothing about the rest. |
| `UNSUPPORTED` | the property form is not supported (the compiler refuses such properties, so this does not occur for compiled models). |
| `NOT_RUN` | the run did not reach the property (e.g. TLC unavailable for a TLC column). |
| `ERROR` | evaluation failed (overflow, modulo by zero) or, for liveness, the model is ill-defined. |

Run verdicts: `VIOLATION_FOUND`, `NO_VIOLATION_IN_BOUNDED_MODEL`, `INCOMPLETE`, `ERROR`.
"Safe" is never used as a verdict.

## Typed invariant patterns used in the examples

| pattern | example | model |
|---|---|---|
| mutual exclusion | `not (A.pc = critical and B.pc = critical)` | mutex-*, peterson, starvation-* |
| no negative inventory | `stock >= 0` | inventory-* |
| no double allocation | `allocated <= 1` | inventory-* |
| at-most-once effect | `effects <= 1` | queue-* |
| no duplicate authorization | `charges <= 1` | retry-* |
| conservation | `x + y + in_flight = TOTAL` | bank-transfer-atomic |
| atomic commitment | `not (P1 committed and P2 aborted …)` | two-phase-* |
| fencing monotonicity | `last_token >= highest` | lease-* |
| last write wins | `(got1 and got2) => value = 2` | reorder-* |
| no stale cache at rest | `(… and cache_valid) => cache = db` | cache-* |

Bug classes demonstrated by real violations: omitted atomicity (counter, bank, mutex,
inventory), stale read (cache), double allocation (inventory), lost update (counter, bank),
duplicate side effects (queue, retry), split brain (lease), atomic-commit violation (2PC),
reordering (reorder), unfair scheduling (starvation, livelock).

## Mutation testing

`src/core/model/mutate.ts` generates mutants of a model (drop a guard, negate a guard, drop
one assignment of a multi-assignment action, drop or weaken a fairness constraint), prints
them back to WML source, and checks each one. A mutant is **killed** when a property that
the baseline does *not* already violate becomes violated. Survivors point at properties that
are too weak or at harmless mutations. Tests assert specific kills: removing the lock guard
is caught by `MutualExclusion`, dropping the dedup bookkeeping by `EffectAtMostOnce`, and
weakening SF to WF by `BEventuallyEnters`.

## Independent recheck

Every witness is replayed by `src/core/replay/replay.ts` before it goes into a receipt: step 0
must be an initial state, every step must be produced by its named action from the previous
state, and the final state must actually violate the claimed invariant (with all earlier states
satisfying it), be a non-terminal deadlock, or contain the claimed out-of-domain value.
