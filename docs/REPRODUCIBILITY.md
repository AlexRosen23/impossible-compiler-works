# Reproducibility

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

## Determinism

Given the same source and bounds, the explorer produces the same state ids, edges, witnesses
and trace hashes (BFS with a fixed action order; exact canonical keys; no randomness, no
threads in the search). The only non-deterministic bound is `timeLimitMs`: a time-capped run
may stop at a different state count, and the verifier says so.

## Receipt contents (`impossible-witness/receipt`, schema version 1)

| field | content |
|---|---|
| `model` | name, title, language `WML/1`, **full source**, `sourceSha256`, variables with domains, property definitions, fairness |
| `checker` | engine `witness-bfs@0.1.0`, exploration order, replay evaluator version, Node version |
| `bounds` | the exact caps used |
| `result` | verdict, complete/partial, cap reason, state/edge counts, depth, deadlocks, per-property status + trace hash + trace length |
| `witnesses` | every counterexample: steps (action + full state), loop start / stutter for lassos, the bad write for domain violations, `traceHash` |
| `replay` | the independent replay outcome for each witness |
| `tlc` | when run: TLC version, jar SHA-256, runtime, per-property TLC results and the comparison |
| `runtime` | elapsed ms, peak heap, platform, CPU model |
| `git` | commit and dirty flag of the checker that produced it |
| `limitations` | the limitations that apply to this run |
| `digest` | SHA-256 of the canonical JSON (sorted keys) of everything else |

## Verification (`node src/cli/witness.ts verify r.json`, `POST /api/receipts/verify`)

1. schema name and version (incompatible versions are rejected);
2. structure and size;
3. **digest** recomputed — any edit after issue is detected;
4. **source hash** — the embedded model is the one that was checked;
5. the source compiles;
6. every witness is **replayed** by the independent evaluator and its trace hash recomputed;
7. the model is **re-checked from scratch** with the recorded bounds: verdict, completeness,
   cap, state and edge counts, and every property status and trace hash must match.

A forger who edits a verdict and recomputes the digest is still caught by steps 6–7 (tested).
State hashes alone are not treated as verification.

## Commands

```bash
scripts/setup                 # deps + pinned TLC (checksum-verified)
scripts/test                  # typecheck + 110 unit/integration tests
scripts/test --e2e            # + 15 Playwright browser tests (needs a free 5722/5723)
scripts/test --tlc            # + TLC corpus (writes evidence/tlc-crosscheck.md)
scripts/demo                  # headless vertical slice → evidence/demo/
scripts/reproduce             # re-verify every receipt under evidence/ (fails on tampering)
node scripts/corpus.ts --bench
```

`scripts/reproduce` treats files named `*TAMPERED*` as negative controls: they must be rejected.

## Evidence in the repository

- `evidence/demo/` — receipts for the slice (broken, repaired, capped) and a tampered copy.
- `evidence/tlc-crosscheck.{md,json}` — the TLC corpus.
- `evidence/benchmarks.{md,json}` — measured runs with machine, commit and command.
- `evidence/screenshots/` — real browser captures from the E2E run.
- `evidence/e2e-run.log`, `evidence/unit-test-run.log` — test transcripts.
