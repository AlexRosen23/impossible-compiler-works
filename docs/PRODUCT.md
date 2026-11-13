# Product: the Witness wing

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

**One question:** *can this system ever reach a state that should be impossible?*

A visual formal-methods laboratory. You describe a small concurrent system as a finite model;
the checker explores **every** reachable state and either returns the **shortest schedule**
that reaches a bad state — a witness you can step through, replay independently, cross-check
with TLC and seal in a tamper-evident receipt — or reports that no violation exists *in that
bounded model*, or honestly says `INCOMPLETE`.

## Who it is for

- **Novices**: "two threads share one counter" makes interleaving visible in four steps.
- **Engineers** reviewing a protocol (reservations, retries, leases, queues, two-phase commit)
  who want to see the exact schedule that breaks an assumption and confirm a fix changes the
  reachable state space.
- **Reviewers / recruiters**: a 90-second guided journey (`RECRUITER_DEMO.md`).

## The eight rooms (all built)

| room | what it does | where |
|---|---|---|
| **A. Possibility Chamber** | canvas graph of every reachable state; layouts: breadth-first layers, shortest witness, condensed SCCs; colours for initial / witness / violating / deadlock / terminal / unexplored; logical-step columns; click or keyboard to inspect | `web/src/components/Graph.tsx`, `Rail.tsx` |
| **B. Specification Desk** | WML editor with highlighting and live line:column diagnostics, bounds, revision notes, content-addressed revision history and diffs | `Editor.tsx`, Revisions tab |
| **C. Interleaving Theater** | process lanes × logical steps; the guard that enabled each step and every variable change; read/write sets; interference windows (stale reads, lost updates, check-then-act) derived from real steps; scrubber; schedule processes one at a time over the explored relation; save and replay schedules | `Theater.tsx` |
| **D. Invariant Hall** | per-property status (`VERIFIED_BOUNDED`, `VIOLATED`, `INCOMPLETE`, `UNSUPPORTED`, `NOT_RUN`, `ERROR`) with evidence text; mutation testing of the model | `Panels.tsx` |
| **E. Temporal Observatory** | `eventually` / `leadsto` under explicit WF/SF; SCC statistics; lassos with loop marker; fairness switches that edit the model; why reachability is not liveness | `Panels.tsx`, `liveness.ts` |
| **F. Witness Archive** | immutable runs; aligned comparison of two runs; receipt export / verify / tamper demonstration; HTML report export; annotations | `Archive.tsx` |
| **G. Model Bazaar** | 17 scenarios (35 executable models) by concept, novice to advanced | `Bazaar.tsx`, `examples/` |
| **H. Proof Observatory** | generated TLA+ module and config; sandboxed TLC run; per-property comparison table; `INTERNAL_ONLY` when TLC is missing | `Panels.tsx`, `core/tla` |

## Honesty rules (enforced in code and tests)

- No verdict is computed or hard-coded in the UI; the example catalog contains no verdicts
  (a test checks this).
- A capped run is `INCOMPLETE`, never safe; liveness gets no verdict on an incomplete graph.
- Every witness is replayed by an independent evaluator before it is shown in a receipt.
- "Verified" always carries "in the bounded model"; the limitations are printed on every result.
- What was checked by the internal engine and what by TLC is labelled per property.

## Out of scope

Proving production systems correct, symbolic model checking, code-to-model extraction,
connecting to or reading any live system (existing projects are only inspiration; see
`EXISTING_WORK_AUDIT.md`).
