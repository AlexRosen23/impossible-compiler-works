# Case study (draft — not posted anywhere)

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

## The Impossible Witness: a model checker you can watch

**Problem.** Concurrency bugs live in schedules nobody ran: two workers check stock before
either reserves; a retried payment is charged twice; a paused leader writes after its lease
expired. Tests sample a few schedules; logs show one. I wanted a tool that answers "can this
*ever* happen?" for a small model, shows the exact schedule when it can, and is honest about
what that answer is worth.

**What I built.** A local studio with a real explicit-state model checker at its core:

- **A small typed modelling language** (WML) with processes, guarded atomic actions, bounded
  domains, invariants, `eventually`/`leadsto` and explicit weak/strong fairness, with
  line:column diagnostics and no way to run code.
- **Breadth-first exploration** with exact canonical state keys, so every invariant or
  deadlock counterexample is a shortest one; hard caps on states, edges, depth, time and heap,
  and an `INCOMPLETE` verdict instead of a false "safe".
- **Fairness-aware liveness** with TLA+ semantics (stuttering, WF/SF), SCC decomposition and
  Emerson–Lei refinement, producing replayable lassos. The starvation examples show weak
  fairness failing and strong fairness succeeding for exactly the textbook reason.
- **An independent replay evaluator** that re-derives every witness from the AST without
  touching the explorer's compiled code path.
- **TLC as a second opinion.** Models export to TLA+; the pinned TLC release runs in a
  network-less, capped container; every TLC counterexample is mapped back and replayed.
  Across 34 models, **150/150 comparisons agree**: same state counts, same verdicts, same
  shortest witness lengths.
- **Tamper-evident receipts** that are verified by recomputation: digest, source hash,
  independent replay and a full re-run.
- **A visual front end** — a dark "logic cathedral" where the reachable state graph fills the
  screen and the witness is a gold thread — plus process lanes that show which precondition
  enabled each step and where a stale read happened, with table and keyboard equivalents for
  everything.

**Numbers.** 35 executable models in 17 scenarios; 110 unit/integration tests and 15 browser
tests (including all six acceptance journeys, axe accessibility, mobile and XSS); 160,000
states and 608,000 transitions explored in under a second on an M5 Pro laptop.

**What I'd say in an interview.** The interesting engineering was not the BFS — it was making
every claim falsifiable: shortest-witness minimality is tested against all violating states,
the receipt verifier assumes a forger who recomputes the hash, liveness refuses to answer on an
incomplete graph, and the TLC comparison counts a disagreement if TLC's own trace fails to
replay.

**Limits I'd name first.** Finite, hand-written models; atomicity is an assumption; no
symbolic or partial-order reduction; nothing checks that code matches the model.
