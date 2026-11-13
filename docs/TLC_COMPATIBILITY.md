# TLC compatibility

## What is pinned

| item | value |
|---|---|
| TLC release | `tla2tools.jar` **v1.7.4** (TLC2 Version 2.19 of 08 August 2024, rev 5a47802) |
| source | https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar (MIT licence) |
| SHA-256 | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` (2,274,532 bytes) |
| how it gets here | `scripts/setup` downloads it to `tools/` (git-ignored) and refuses a checksum mismatch; the adapter re-checks the hash before every run |
| JVM | host `java` if one works; otherwise a JVM image already present on this Mac, pinned by digest: `quay.io/keycloak/keycloak@sha256:0aae0de7…cbce4` (Red Hat OpenJDK 21.0.11), run with `--pull never` |

GitHub publishes no digest for the v1.7.4 asset, so the SHA-256 above is trust-on-first-use:
recorded when it was first downloaded on 2026-11-12 and checked ever since. This Mac has no
host JDK (installing one is an owner decision), which is why the container route exists.

## Sandbox (src/core/tla/tlc.ts)

Each TLC run: a fresh temporary directory holding only the generated `.tla` and `.cfg`;
`spawn` with an argument vector (never a shell, no string interpolation); container with
`--network none --memory 768m --cpus 1 --pids-limit 256 --read-only --tmpfs /tmp
--cap-drop ALL --security-opt no-new-privileges`, the caller's uid, the jar mounted read-only;
`-Xmx512m -workers 1`; a 90-second hard timeout that `docker kill`s the named container
(`witness-tlc-<random>`); output capped at 4 MiB; the temp directory is deleted afterwards.
User text never reaches TLC except as WML identifiers (letters, digits, `_`) and integers,
because the TLA+ module is generated from the type-checked IR.

## Export (src/core/tla/export.ts)

- Variables → TLA+ variables (`A.pc` → `A_pc`; reserved words get a `_` suffix).
- `TypeOK` = every variable in its declared domain (enumerations become sets of strings).
- `Init` = per-variable `=` or `\in`.
- **One operator per action instance** (`A_send_m_1`), so TLC's trace labels map 1:1 to WML labels.
  Each is `guard /\ x' = e /\ … /\ UNCHANGED <<others>>`.
- `terminal p` → `Terminating == p /\ UNCHANGED vars`, added to `Next`, so TLC's deadlock check
  matches WML's "deadlock unless terminal".
- `Fairness` = conjunction of `WF_vars(op1 \/ …)` / `SF_vars(…)` over the covered instances;
  `Spec == Init /\ [][Next]_vars /\ Fairness`.
- Invariants → operators used with `INVARIANT`; liveness → `<>(q)` and `(p) ~> (q)` with `PROPERTY`.

## How the cross-check runs

TLC stops at the first error, so the adapter runs TLC once per question:

| config | cfg | compared with |
|---|---|---|
| `full` | `INVARIANT TypeOK`, `CHECK_DEADLOCK FALSE` | distinct-state count (if no error) and `TypeOK` |
| `deadlock` | `CHECK_DEADLOCK TRUE` | `DeadlockFreedom` |
| `inv:<I>` | `INVARIANT I`, `CHECK_DEADLOCK FALSE` | invariant `I`: verdict **and** shortest witness length |
| `live:<L>` | `PROPERTY L`, `CHECK_DEADLOCK FALSE` | liveness `L`: verdict |

TLC runs in `-tool` mode; `parseTlcOutput` reads the numbered message blocks (2110/2107
invariant, 2114 deadlock, 2116 temporal, 2217 state, 2218 stuttering, 2122 "Back to state",
2199 counts, 2262 version). Anything it cannot classify is `TLC_ERROR`, never a pass. Every TLC
counterexample is mapped back to WML variable names and **re-derived by the independent replay
evaluator** (including fairness on TLC's lassos); a replay failure makes that comparison
disagree.

## Results

`node scripts/corpus.ts --tlc` over all 34 teaching models: **150/150 comparisons agree**
(`evidence/tlc-crosscheck.md`): identical reachable-state counts on every model, identical
verdicts on every property, identical shortest invariant/deadlock witness lengths, and every
TLC trace replays. The 160,000-state benchmark model is excluded only to keep the corpus fast.

## Known, documented differences

1. **State counts with domain violations.** The internal explorer refuses to add an
   out-of-domain successor; TLC adds it and then reports `TypeOK`. Counts are compared only
   when the full run finishes without error. (No teaching model currently has a domain
   violation; the unit tests cover the case.)
2. **Lasso length.** Neither tool promises shortest liveness counterexamples, and they differ
   (e.g. `polite-livelock`: 12 internal vs 8 TLC steps). Only verdicts are compared; both lassos
   are replayed.
3. **Edges.** TLC's "states generated" counts the `Terminating` self-loops and duplicates;
   it is not compared with internal transition counts.
4. **Search order.** Both are breadth-first, but tie-breaking among equal-length witnesses can
   differ; witness *lengths* are compared, not the exact states.
5. **Semantics boundaries.** Only the WML fragment is exported; nothing is claimed about TLA+
   features WML lacks (sets, functions, records, `CHOOSE`, real-time).

## When TLC is unavailable

The app, tests and examples run without Java. The Proof Observatory shows `INTERNAL_ONLY`,
`/capabilities` reports the TLC checker as `INTERNAL_ONLY`, receipts carry
`tlc.available = false` with the reason, and the live-TLC unit test is skipped (the parser is
still tested against recorded TLC output in `tests/fixtures/tlc/`).
