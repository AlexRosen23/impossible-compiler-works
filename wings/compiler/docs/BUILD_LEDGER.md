# Build ledger

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Compiler wing (formerly PAPER TIGER COMPILER WORKS). Ports and commands for the combined app are in the [root README](../../../README.md); older mentions of ports 5580/5581/5590 describe the standalone app.

Every phase, the commands that were run and what they produced. Statuses use `WORKING_AND_TESTED`, `PARTIAL`,
`FAILED`, `NOT_BUILT`, `OWNER_ACTION`. Machine: Apple M5 Pro, 18 cores, macOS (Darwin 27.0.0), Node v24.14.0.
Branch `feat/v0.1-compiler-works`.

## Phase 0: audit and language contract (2026-11-12)
- Checked: no `paper-tiger-compiler-works` folder locally, `gh repo view AlexRosen23/paper-tiger-compiler-works`
  → "Could not resolve to a Repository". Read the header of Constellation `server/agentwork/compiler.ts` (the
  Mission Compiler). Rule Box and Prompt Loom were not found anywhere. Write-up: [EXISTING_WORK_AUDIT](EXISTING_WORK_AUDIT.md).
- Repo: `new-github-project.sh … --local-only` (gitleaks hooks, baseline .gitignore, first commit 4ec7c4b).
- Contract frozen as code tables first (`core/limits.ts`, `builtins.ts`, `primitives.ts`, `DIAGNOSTIC_CODES`),
  then written up in [FOLIO_LANGUAGE_SPEC](FOLIO_LANGUAGE_SPEC.md) and aligned to tests.
  **Honest note:** the brief asked for the spec document before implementation. Here the code tables came
  first and the prose spec followed the vertical slice; the spec is generated from and checked against them.

## Phase 1–3: parser, static semantics, IR/VM: `WORKING_AND_TESTED`
- First vertical slice (`node scripts/folio.ts examples/01-rainfall-almanac.folio --opt --ir`): all 7 stages
  ok, VM scene hash `1cc2a47a7c29ca5e` = reference interpreter, `AGREE`. The brief's sample program is
  accepted as written.
- **Bug found by the examples:** `size`/`from` were keywords, so named arguments `size:` and `from:` failed in
  10 of 13 examples. Fixed by making `size`, `frames`, `background`, `from` contextual words (test added).
- **Bug found by tests:** five failure-corpus header columns were my own miscounts. Each was re-counted by
  hand against the source line and the compiler's spans were correct. Headers fixed, not code.
- **Bug found by the replay proof:** `VMRun.run(0)` changed status from `ready` to `running` without
  executing, so replay to step 0 hashed differently. Fixed.
- **Bug found by the replay proof:** forward restore of a scene snapshot truncated the command list to a
  saved length, padding it with holes. Snapshots now copy the command references (`core/scene-snap.ts`).

## Phase 4: browser IDE: `WORKING_AND_TESTED` (with `PARTIAL` items below)
- `npm run build` → `dist/` (one 500+ kB chunk warning, accepted for a local tool).
- Verified in the in-app browser at 1512×900 and 800×600: every mode renders real data; no console errors.
- The desktop preview tool could not start dev servers (its per-folder limit was taken by other sessions), so
  verification used the production mode: `PT_STATIC=1 node server/index.ts` on 127.0.0.1:5580.

## Phase 5: optimization lab: `WORKING_AND_TESTED`
- Passes: constfold (with propagation), dce (unreachable blocks, dead stores, unused non-faulting results,
  block merging), cse (local value numbering, load reuse, copy propagation). The IR verifier runs after each.
- **Gap found in the browser:** the Lowering Floor showed `%6 = mov %5` surviving (register copies were not
  propagated). Added copy propagation to cse. Optimizer bench: −26.6% → −29.3% VM instructions.
- `WARMUP=10 RUNS=41 npm run bench` (interleaved off/on), from `evidence/benchmarks.json` (2026-11-12T16:45:04.400Z, commit at run time 9f5ffd9); median speed-up ×1.05–×1.27:

| example | VM instructions off → on | median ms off → on | × |
|---|---|---|---|
| 01-rainfall-almanac | 1,571 → 1,407 (−10.4%) | 0.084 → 0.076 | 1.10 |
| 02-rainfall-ledger | 2,013 → 1,743 (−13.4%) | 0.109 → 0.098 | 1.11 |
| 03-orrery | 33,060 → 26,760 (−19.1%) | 1.413 → 1.138 | 1.24 |
| 04-spiral-garden | 57,140 → 48,735 (−14.7%) | 2.227 → 2.029 | 1.10 |
| 05-rain-trace | 2,611 → 2,368 (−9.3%) | 0.144 → 0.129 | 1.12 |
| 06-lissajous | 1,413,180 → 1,263,540 (−10.6%) | 51.187 → 48.686 | 1.05 |
| 07-ink-wheel | 4,471 → 3,802 (−15.0%) | 0.183 → 0.166 | 1.10 |
| 08-checker-press | 31,008 → 27,475 (−11.4%) | 0.743 → 0.665 | 1.12 |
| 09-station-map | 5,249 → 4,913 (−6.4%) | 0.164 → 0.153 | 1.07 |
| 10-type-specimen | 381 → 336 (−11.8%) | 0.020 → 0.019 | 1.05 |
| 11-clockwork | 79,440 → 64,200 (−19.2%) | 3.628 → 3.307 | 1.10 |
| 12-fibonacci-steps | 9,174 → 8,183 (−10.8%) | 0.198 → 0.185 | 1.07 |
| 13-optimizer-bench | 1,765,080 → 1,248,450 (−29.3%) | 42.258 → 33.310 | 1.27 |

  The machine was not idle (other sessions running). **Measurement bug found:** the first, non-interleaved
  run reported ×6.37 for example 01. It was JIT warm-up ordering ("off" always ran first). Interleaving fixed
  it. Run-to-run spread is about ±10% on sub-millisecond examples (example 01 measured ×1.01 in one
  interleaved run and ×1.10 in the next), so only the instruction counts are exact. Draw-heavy programs (06)
  gain least, because their time goes into the scene builder, not into the instructions the passes remove.

## Phase 6: debugging and failure gallery: `WORKING_AND_TESTED`
- Debugger: instruction / in / over / out / continue to line breakpoints, rewind via bounded checkpoints,
  `proveReplay`. Conditional breakpoints: `NOT_BUILT` (documented).
- Fault lab: `BAD_cse_commute_all` diverges on `examples/fault-lab-commute.folio`; the reducer shrinks
  629 → 228 characters (7 lines, `1 - b` vs `b - 1`).
- `npm run fuzz -- 2000` (see `evidence/fuzz-summary.json`): 4,000 runs, 4,000 agreeing, 0 divergent,
  0 rejected, 0 compiler crashes on 2,000 mutated sources.
  **Coverage fix:** at first only 7.8% of runs completed without a fault (random asserts nearly always
  failed; loop variables start at 0, so `/` and `%` divided by zero). I measured the fault sources (~98% of
  R001 were `/` or `%` by zero), then rebalanced the generator: mostly-true asserts and mostly non-zero
  divisors, keeping the unguarded forms. Now 1,694/4,000 (42%) complete cleanly and every fault class still
  appears (R001 866, R002 798, R003 434, R010 110, R008 98).

## Phase 7: project and workflow system: `WORKING_AND_TESTED`
- SQLite (`node:sqlite`) with numbered migrations; projects with versioned saves, optimistic concurrency
  (409 on a stale base), restore, fork, history with diff; content-addressed runs; bundle export and import
  (import must reproduce); 13 example programs + 14 failure cases + the fault-lab fixture.
- `npm run receipt -- examples/02-rainfall-ledger.folio` then `npm run reproduce -- evidence/receipts/02-rainfall-ledger/receipt.json evidence/receipts/02-rainfall-ledger/bytecode.json` → 13 PASS, exit 0.
- **Flaky test found:** a 600 kB body sometimes produced ECONNRESET instead of 413, because the server stopped
  reading mid-upload. The server now drains (bounded at 16× the cap) and answers 413 with `Connection: close`.
  The test passed 6 times out of 6 afterwards.

## Phase 8: studio polish: `WORKING_AND_TESTED` / `PARTIAL`
- `npm run e2e` → 9 passed (compile and run, helpful failure, optimizer, debugger, bad optimization,
  reproduce and tamper, save/reopen/history/conflict, mobile 390 px, accessibility basics and injection).
  Screenshots: `evidence/screenshots/01…07`.
- `PARTIAL`: Format refuses files with comments (the formatter is AST-based and would drop them); tablet and
  ultra-wide layouts exist in CSS but only phone and desktop are E2E-checked; reduced-motion CSS exists but is
  not E2E-checked; no automated axe audit (basic checks only).
- `NOT_BUILT`: multi-file modules (single file, as the brief allows until module semantics exist).

## Phase 9: Constellation and portfolio: `PARTIAL` / `OWNER_ACTION`
- Read-only contract endpoints built and tested. The Constellation world itself is `OWNER_ACTION`: it would
  mean editing another repository, which this brief rules out without approval.
- Case study drafted in [PORTFOLIO_CASE_STUDY](PORTFOLIO_CASE_STUDY.md); not published (needs approval).

## Review findings (independent documentation review, fixed before the PR): `WORKING_AND_TESTED`
A second agent wrote the technical docs by reading the code and probing it, and reported nine defects. All
nine reproduced as failing tests first (`tests/regressions.test.ts`), then were fixed:
1. **`-0` miscompile under constfold.** The constant pool and the CSE key deduplicated `-0` with `0` (JSON
   writes both as `0`), so `atan2(0, x + -0)` changed meaning. Constants now encode `-0` as `{ neg0: true }`.
2. **VM-only limits could reject valid programs.** A 64-deep non-recursive call chain hit R007 only in the VM.
   This became a static rule (`S004`, longest call chain ≤ the call-depth limit). Fuel (R006) stays a VM-only
   machine limit; receipts and the IDE now report it as `vm-resource-limit` instead of a divergence.
3. **Static server crash** on malformed percent-encoding (`decodeURIComponent` threw): now 400.
4. **Imported receipts could raise limits** (unbounded server work): receipts may lower limits, never raise them.
5. **~2,000 nested blocks overflowed the parser stack** (an ICE): block nesting is now capped (S002).
6. **`P004` was documented but never emitted:** removed.
7. **`validateScene` gaps:** background colour, opacity range and point coordinates are now validated.
8. **A false comment** claimed unit tests for the shared built-ins and scene builder; those tests now exist.
9. **IDE-facing:** a `let` shadowing a function name stole the call's symbol resolution; unused `maxTraceSteps` removed.

Evidence was regenerated after the fixes: fuzz 4,000/4,000 agreeing (1,694 clean completions), benchmark
above, receipts with the new `oracle.status`, CLI reproduce 14/14 checks with exit 0, and a receipt with an
edited scene hash exits 1 (digest and scene-hash checks fail).

## Pre-release red team and hardening (0.2.0, 2026-11-12/13): `WORKING_AND_TESTED`

Before the repository went public, three independent reviewers attacked a live copy, each with its own scope (the
HTTP server; the compiler and VM sandbox; the browser IDE and supply chain). They found 15 issues and one
supply-chain item; the full table is `SECURITY.md` section 5. The two serious ones: an 11 KB program ran the
process out of memory (scene size was bounded only per frame and per command), and a 3.5 KB program with a
doubling call tree hung the reference interpreter, and with it the synchronous server, without bound. The
security document had claimed the interpreter's work was bounded; that claim was wrong and is corrected.

Every reproduction was written as a failing test first (`tests/security.test.ts`, 24 tests; 8 server tests; 1
E2E test) and then fixed: the reference interpreter got its own fuel (`R014`) and both executors a call limit
(`R013`); scene size got per-frame and per-run budgets; fuel got a whole-run budget; the checker got a static bound
on the interpreter's stack depth (`S005`); the parser measures expression height iteratively; the verifier never
throws; receipts are shape-checked; lookup tables have no prototype; the server runs every compile-and-run job on
a worker thread with a 15 s and 512 MB limit and refuses cross-site and cross-origin requests. One fix broke
itself on the first try: the new `S005` computation recursed through the call chain and overflowed on exactly the
programs it measures; it now weighs callees before callers.

After the fixes the fuzz campaign is unchanged (4,000 of 4,000 agree, 1,694 clean), instruction counts are
unchanged, all three receipts were regenerated at `c437b8f` and reproduce 14/14, and `npm audit` reports 0.
Versions: compiler 0.2.0, grammar `folio-grammar/0.2`, receipt `paper-tiger-receipt/0.2`.

## Repo and CI
- Repo `AlexRosen23/paper-tiger-compiler-works`, created private with Actions disabled before the first push.
  PR #1 (v0.1) was merged on the owner's approval on 2026-11-12. The owner asked for the repository to be made
  public after this hardening; it carries an MIT licence.
- `.github/workflows/ci.yml` is written but dormant: enabling Actions is `OWNER_ACTION`.
