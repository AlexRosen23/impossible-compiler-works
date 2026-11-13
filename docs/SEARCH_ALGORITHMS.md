# Search algorithms

## Explicit-state breadth-first search (`src/core/engine/explore.ts`)

1. Enumerate `S0` in declaration order; each new state gets the next id.
2. FIFO queue over state ids. For the state at the head, try every action instance **in
   declaration order (process template order, instance order, action order, parameter order)**;
   for each enabled one compute the successor by simultaneous assignment.
3. Deduplicate by exact canonical key (`Map<string, id>`). A new state records its BFS parent,
   the action taken and its depth, and every invariant is evaluated on it immediately.
4. A state is **expanded** only when all of its successors were generated. If a cap is hit in
   the middle of a state, its partial edges are rolled back, so "expanded" always means "all
   successors present".
5. After expansion, a state with no successors is classified as an intended terminal state
   (terminal predicate true) or a deadlock.

The order is deterministic, so two runs of the same model and bounds produce identical
graphs, ids, witnesses and trace hashes (tested; required for receipt re-runs).

### Why witnesses are shortest

BFS discovers states in non-decreasing depth. Invariants are checked at discovery time, so the
first violating state recorded has minimal depth; following parent pointers gives a path of
exactly that length. The same holds for the first deadlock and the first domain violation.
`tests/explore.test.ts` checks this minimality against all violating states for several models.
No other search order is used, so nothing is labelled DFS.

### Resource caps and `INCOMPLETE`

| bound | default | hard maximum |
|---|---|---|
| `maxStates` | 200,000 | 2,000,000 |
| `maxEdges` | 2,000,000 | 20,000,000 |
| `maxDepth` | 5,000 | 100,000 |
| `timeLimitMs` | 30,000 | 300,000 |
| `maxHeapMB` | 1,536 | 3,072 |

Plus, in the service: a worker heap limit of 2 GiB and a 10-minute wall-clock budget per job.
When any cap is hit the exploration is **incomplete**: partial statistics are kept, a
violation found before the cap is still reported (its witness is real and replayable), but no
property is ever reported as `VERIFIED_BOUNDED`; the run verdict is `INCOMPLETE` and liveness
gets no verdict. "Exhaustive" means the queue emptied with no cap hit.

## Liveness: SCCs with fairness (`src/core/engine/liveness.ts`)

Only on a complete graph. For each property the search region is the set of `¬q` states
reachable inside `¬q` from the start set (initial `¬q` states for `eventually q`; reachable
`p ∧ ¬q` states for `p leadsto q`). A counterexample exists iff the region contains

- a **fair stutter state**: no fairness constraint enabled there, so the behaviour may stop
  forever (this covers deadlocks), or
- a **fair strongly connected component** (≥ 2 states): computed with iterative Tarjan. For each
  constraint: WF holds on the SCC if an action of it is taken inside the SCC or it is disabled
  in some SCC state; SF holds if taken or disabled in every SCC state. A failed WF rejects the
  SCC (every sub-cycle fails it too). A failed SF removes the states where it is enabled and the
  remainder is re-decomposed (Emerson–Lei refinement).

The counterexample is a lasso: the shortest BFS prefix to a start state, a path inside `¬q` to
the component, and a loop that visits a waypoint for every fairness constraint (an edge where
it is taken, or a state where it is disabled) before closing. Lassos are not claimed shortest.

## Complexity and performance

BFS is `O((|S| + |T|) · cost(action))` time and `O(|S| · n)` memory for the vectors plus keys.
Measured numbers: `evidence/benchmarks.md` (e.g. 160,000 states / 608,000 transitions in under
a second on an Apple M5 Pro). The UI renders at most the first 5,000 states (`graphLimit`);
counts and verdicts always cover the full exploration and the UI says when the drawing is
truncated.

## What this engine is not

It is not a symbolic model checker (no BDDs/SAT), does no partial-order reduction or symmetry
reduction, and uses no hash compaction: exact keys trade memory for zero collision risk.
