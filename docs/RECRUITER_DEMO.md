# The 90-second walkthrough

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

Start: `scripts/dev`, open http://127.0.0.1:5720, click **Start the 90-second journey**.
The guided panel (bottom right) drives every step with real runs; the clock shows elapsed
time. The E2E test `the guided 90-second journey runs end to end` completes it in about 22 s
of machine time; with a person reading, plan on 90 s.

| t | click | what you see | what to say |
|---|---|---|---|
| 0:00 | **Run the checker** (model: inventory reservation, broken) | the graph grows step by step; one vermilion node; verdict VIOLATION FOUND; witness 4 steps | "Two checkout workers, one unit of stock. The checker explored all 11 reachable states and found a bad one." |
| 0:15 | **Step through the witness** | the gold thread lights up step by step; the Theater shows A.check, B.check, A.reserve, B.reserve and the interference window "B read stock at step 2; A changed it at step 3…" | "Breadth-first search, so this is the shortest possible schedule: both see stock, both reserve." |
| 0:35 | **Load the fix and re-check** | repaired model (atomic compare-and-reserve); graph shrinks to 5 states; all properties VERIFIED_BOUNDED; "exhaustive (no cap hit)" | "Not a proof of the product — every state of *this* finite model." |
| 0:45 | **Compare the two runs** | 11 → 5 reachable states, 1 → 0 bad states | "The red path disappears because the transition relation changed." |
| 0:55 | **Run TLC** | ~6 s; "TLC AGREES on 5/5 comparisons", identical state count | "An independent model checker, pinned and sandboxed, agrees." |
| 1:10 | **Verify and tamper** | untouched receipt VALID; same receipt with the verdict edited REJECTED | "The receipt is re-derived, not trusted: digest, independent replay and a full re-run." |

Fallbacks: if TLC is unavailable the TLC step shows `INTERNAL_ONLY` with the reason — say so;
the CLI demo (`scripts/demo`) shows the same slice in a terminal in under a second.
