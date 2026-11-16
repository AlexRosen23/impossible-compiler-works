# THE IMPOSSIBLE COMPILER WORKS: features

A laboratory with two wings that check each other. The **Compiler wing** is FOLIO, a small typed diagram language
with a real compiler, a bytecode VM, an independent reference interpreter used as an oracle, a fuzzer and an
eight-mode browser IDE. The **Witness wing** is an explicit-state model checker for small concurrent models: it
finds the shortest schedule that reaches a bad state, or says honestly that it could not finish. Between them, the
Witness wing model-checks the Compiler wing's optimizer. It is for people who want to see a compiler and a model
checker work, step by step, with evidence they can re-run. *Formerly Paper Tiger Compiler Works and The Impossible Witness.*

**This is the source-of-truth features list.** Every PR that adds, changes, removes or switches off something a person
can see or use updates this file in the same PR (see "Keeping this file true").

- **Repo:** AlexRosen23/impossible-compiler-works (public)
- **Status:** v0.2.0, runs on your own machine (loopback only); nothing is deployed · **`main`:** `01d5928` (2026-11-15)
- **Last updated:** 2026-11-15, written from the code, README, docs and tests.

**Status words** (a feature with no status word is live):
| Word | Means |
| --- | --- |
| *Live* | on `main` and working |
| *Off by default* | built, behind a flag or setting |
| *Needs Java or Docker* | works only when one of them is installed |
| *Planned* | named as future work, not built |

## At a glance

| | |
| --- | --- |
| Stack | TypeScript run directly by Node 24+ (type stripping, no build step for servers); React 19, Vite, CodeMirror 6 for the UI; `node:sqlite` for storage |
| Wings | Witness wing (root `src/`, `web/`, `examples/`) · Compiler wing (`wings/compiler/`) · cross-feature (`bridge/`) |
| Ports | UI `5720` (Witness at `/`, Compiler at `/compiler/`) · API `5721` (Compiler API at `/engine/compiler`) · Playwright `5726`/`5727` |
| Code size (TypeScript lines, counted 2026-11-15) | Witness core and server 4,510 · Witness UI 2,019 · Compiler core 4,457 · Compiler server 493 · Compiler UI 1,492 · bridge 323 |
| Witness models | 35 `.witness` files in 17 teaching scenarios |
| FOLIO programs | 13 examples + 1 fault-lab seed + 14 failure cases |
| Tests (per README) | Witness 112 · Compiler 126 · bridge 11 · browser journeys 27 |
| Evidence | 150/150 TLC comparisons agree over 34 models · 4,000 fuzz programs, 0 divergences · every optimizer pass order of 14 seeds checked |
| PRs merged | 6 (history of both original apps was merged into this repo on 2026-11-13) |
| Accounts, cloud, keys | none |

## Contents
1. What it is and who it's for
2. How to run it
3. Architecture at a glance
4. Features (Witness wing, Compiler wing, cross-feature, shell, static demo)
5. Integrations
6. Data and privacy
7. Tests and evidence
8. Known limits and gaps
9. Change log

## 1. What it is and who it's for

- **Learners** who want to see two threads corrupt a counter, or watch a compiler turn text into pixels, one stage at a time.
- **Engineers and reviewers** who want an exact failing schedule (Witness wing) or exact IR, bytecode and type derivations (Compiler wing).
- **Hiring reviewers**: a 90-second guided journey in each wing (`docs/RECRUITER_DEMO.md`, the Compiler wing's tour).
- It is **not** a tool to prove production software correct. A verdict covers one finite model, or one program with its fixtures and limits. Every result says so.

## 2. How to run it

**Needs:** Node 24 or newer. Docker or Java is optional and only used for the TLC cross-check. No accounts, no keys.

```bash
scripts/setup     # npm ci + pinned TLC v1.7.4 jar (HTTPS, SHA-256 checked); WITNESS_SKIP_TLC=1 skips the jar
scripts/doctor    # what this machine can do: Node, deps, TLC, whether ports 5720/5721 are free
scripts/dev       # API on 127.0.0.1:5721 + Vite UI on 127.0.0.1:5720 (hot reload)
scripts/start.sh  # production-style: build the UI once, serve UI + API from one proxy
scripts/test      # gate (see section 7); flags --e2e, --tlc, --fuzz
scripts/reproduce # re-check every shipped receipt of both wings
scripts/demo      # headless demo of the Witness slice (broken model, witness, fix, receipt, tamper)
```

- Open `http://127.0.0.1:5720/` for the Witness wing and `http://127.0.0.1:5720/compiler/` for the Compiler wing.
- Everything binds to `127.0.0.1` only. Without Java or Docker everything works except TLC, which is then labelled `INTERNAL_ONLY`.
- Environment variables (names only): `WITNESS_PORT` (API, default 5721), `WITNESS_WEB_PORT` (UI, default 5720), `WITNESS_SKIP_TLC`, `API_PORT` and `WEB_PORT` (used by `scripts/start.sh`).
- npm scripts (`package.json`): `dev`, `server`, `web`, `build:web`, `typecheck`, `test`, `test:witness`, `test:compiler`, `test:bridge`, `lint`, `witness`, `folio`, `fuzz`, `bench`, `compiler:reproduce`, `compiler:receipt`, `pass-check`.

### Command line

| Command | What it does |
| --- | --- |
| `node src/cli/witness.ts check <model.witness> [--max-states N] [--max-depth N] [--time-ms N] [--receipt out.json] [--json]` | check a model; print verdict, state and edge counts, per-property status and the witness steps; optionally write a receipt |
| `node src/cli/witness.ts verify <receipt.json> [--no-rerun]` | verify a receipt: digest, source hash, independent replay and (unless `--no-rerun`) a full re-run; exits non-zero when rejected |
| `node src/cli/witness.ts export-tla <model.witness> [--out dir]` | write the generated TLA+ module and TLC config files |
| `node src/cli/witness.ts tlc <model.witness> [--receipt out.json]` | cross-check with TLC *(needs Java or Docker)* |
| `node src/cli/witness.ts doctor` | report whether TLC can run here |
| `npm run folio -- <file.folio> [--opt] [--ir] [--bc]` | compile a FOLIO program; print the stage table, optionally the optimized IR and the disassembly; run the VM and the reference interpreter and print `AGREE` or `DIVERGE` |
| `npm run fuzz -- [count] [startSeed]` | differential fuzz campaign (default 2,000 seeds); writes `wings/compiler/evidence/fuzz-summary.json` |
| `npm run bench` | VM benchmark with optimizations off and on; writes `wings/compiler/evidence/benchmarks.json` |
| `npm run compiler:receipt -- <file.folio> [outDir]` | write a Compiler wing receipt and bytecode artifact |
| `npm run compiler:reproduce -- <receipt.json> [bytecode.json]` | re-check a receipt in a fresh process |
| `npm run pass-check -- <seeds...> [--mutant]` | the cross-feature: check every optimizer pass order of the named FOLIO seeds |

## 3. Architecture at a glance

```
browser (React + Vite, 127.0.0.1:5720)   one shared shell, two apps: "/" and "/compiler/"
  |  /api  /health  /capabilities  /runs  /engine/compiler
  v
one API process (node:http, 127.0.0.1:5721)
  |-- Witness API   SQLite (WAL): models, immutable revisions, runs, annotations; durable queue -> worker threads
  |-- Compiler API  mounted at /engine/compiler (the former Paper Tiger server): projects, versions, runs, receipts
  v
worker threads (heap and wall-clock limits; terminate = cancel)
```

| Folder | What is there |
| --- | --- |
| `src/core/syntax`, `model`, `engine`, `replay`, `receipt`, `tla` | Witness wing: WML lexer/parser/printer, compiler and mutation, evaluator, BFS explorer, liveness, independent replay, receipts, TLA+ exporter and TLC adapter |
| `src/server`, `src/cli` | Witness API, queue worker, HTML report, diff, loopback proxy; the `witness` CLI |
| `web/src`, `web/shell` | Witness UI and the shared shell bar |
| `examples/` | 35 WML models and `catalog.json` (teaching text only, no verdicts) |
| `wings/compiler/core` | FOLIO: lexer, parser, checker, lowering, IR and verifier, optimizer, code generator, bytecode and verifier, VM, reference interpreter, debugger, fuzzer, reducer, receipts, SHA-256 |
| `wings/compiler/server`, `web` | Compiler API (SQLite projects, jobs, static serving) and the IDE |
| `wings/compiler/examples` | 13 FOLIO programs, the fault-lab seed, 14 failure programs, 4 fixture datasets |
| `bridge/` | the cross-feature (`pass-orders.ts`) and its tests |
| `evidence/`, `wings/compiler/evidence/` | receipts, TLC corpus, benchmarks, screenshots, fuzz summary |
| `docs/`, `wings/compiler/docs/` | 18 Witness docs and 15 Compiler docs (specs, limits, security, build ledgers) |

Design choices on record: TypeScript throughout with no build step for servers (Node type stripping, so erasable
syntax only); the replay evaluator and the reference interpreter are kept independent of the engines they check.

## 4. Features

### A. Witness wing: the model language (WML)

- **WML models** *(live)*: a small typed language with no loops, functions, I/O or strings in expressions, so a model can never run code. A model has `var`, `process` templates (several instances from one template), guarded atomic `action`s with parameters, `terminal` states, `invariant`s, `liveness` properties and `fairness` declarations. `docs/MODEL_LANGUAGE.md`, `src/core/syntax`
- **Type checks with line:column diagnostics** *(live)*: int ranges, bool and enums; assignments must fit the target; misspelled enum literals are errors; each variable is assigned at most once per action. Errors are `E1xx` (syntax) and `E2xx` (meaning); warnings are `W2xx`. `src/core/model/compile.ts`
- **Hard language limits** *(live)*: source 64 KiB, 20,000 tokens, 64 state variables, 16 processes, 2,000 action instances, 100,000 initial states, expression depth 64, range width 1,000,000.
- **Refusal instead of approximation** *(live)*: unsupported temporal forms (`always`, `until`, nested `eventually`) are rejected with "Unsupported liveness form".
- **Formal step semantics** *(live)*: written down in `docs/TRANSITION_SEMANTICS.md`.

### B. Witness wing: the checker

- **Breadth-first exploration with canonical states** *(live)*: every reachable state is explored exactly; the first violating state found is at the shortest distance, so the witness is the shortest schedule. `src/core/engine/explore.ts`, `docs/SEARCH_ALGORITHMS.md`
- **Safety checks** *(live)*: `invariant`s on every reachable state, implicit **DeadlockFreedom** (a stuck non-terminal state), implicit **TypeOK** (no write outside a declared domain).
- **Honest per-property verdicts** *(live)*: `VERIFIED_BOUNDED`, `VIOLATED`, `INCOMPLETE`, `UNSUPPORTED`, `NOT_RUN`, `ERROR`. Run verdicts are `VIOLATION_FOUND`, `NO_VIOLATION_IN_BOUNDED_MODEL`, `INCOMPLETE`, `ERROR`. The word "safe" is never used. `docs/SAFETY_PROPERTIES.md`
- **Bounds that stop with `INCOMPLETE`** *(live)*: caps on states, edges, depth, time and heap (run options with hard maxima). A capped run is never reported as safe.
- **Liveness under fairness** *(live)*: `eventually q` and `p leadsto q`, checked over strongly connected components of a complete graph, with weak and strong fairness on a process or one action family. Counterexamples are lassos (a prefix plus a loop, or a stop-forever state). On an incomplete graph liveness is `INCOMPLETE`. `src/core/engine/liveness.ts`, `docs/LIVENESS_AND_FAIRNESS.md`
- **Independent replay of every witness** *(live)*: a separate AST evaluator re-derives each step before the witness reaches a receipt. `src/core/replay`
- **Mutation testing of a model** *(live)*: drops or negates a guard, drops one assignment, drops or weakens fairness; a mutant is "killed" when a property the baseline held becomes violated. Survivors point at weak properties. `src/core/model/mutate.ts`
- **TLA+ export and TLC cross-check** *(Needs Java or Docker)*: generates a TLA+ module and configs from the checked model, runs the pinned TLC v1.7.4 (SHA-256 verified before every run) in a sandbox, compares state counts and each property, and re-derives every TLC counterexample with the independent replay evaluator. When TLC is missing the label is `INTERNAL_ONLY`. `src/core/tla`, `docs/TLC_COMPATIBILITY.md`
- **Receipts** *(live)*: a JSON record pinning source, bounds, versions, results and hashes. Verifying re-computes the digest and source hash, replays every witness independently and re-runs the whole check. A receipt with an edited verdict is rejected. Receipts are tamper-evident, not signed. `src/core/receipt`, `docs/REPRODUCIBILITY.md`

### C. Witness wing: the service

- **Runs are jobs** *(live)*: `check`, `tlc` and `mutation` runs go through a durable queue in SQLite and run on worker threads (heap up to 2 GiB, 10-minute wall clock). Progress is posted every 4,096 states. Cancel terminates the worker (and stops our own TLC containers).
- **Crash recovery** *(live)*: a run whose worker died is re-queued once, then failed with an explicit error; the same on server restart.
- **Immutable history** *(live)*: revisions are content-addressed and never edited; a run moves `queued -> running -> done | failed | cancelled` once; annotations are separate rows.
- **Storage caps** *(live)*: 500 models, 300 revisions per model, 5,000 runs, 512 MiB database; beyond that the API answers 507.
- **API routes** *(live)*: `GET /api/catalog`, `/api/models`, `/api/models/:id`, `/api/models/by-slug/:slug`, `POST /api/models`, `POST /api/models/:id/revisions`, `GET /api/revisions/:id`, `GET /api/diff?a&b`, `POST /api/compile`, `POST /api/runs`, `GET /api/runs`, `/api/runs/:id`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/receipt`, `/api/runs/:id/report.html`, `/api/runs/:id/tla`, `POST /api/runs/:id/annotations`, `POST /api/receipts/verify`, `GET /api/tlc`, and `POST /api/bridge/pass-orders` (the cross-feature).
- **HTML report export** *(live)*: a self-contained report per run, with every dynamic string escaped and the receipt embedded as inert JSON.

### D. Witness wing: the eight rooms (UI)

| Room | What it does | Code |
| --- | --- | --- |
| A. Possibility Chamber | canvas graph of every reachable state; layouts: breadth-first layers, shortest witness, condensed SCCs; colours for initial, witness, violating, deadlock, terminal and unexplored; reveal by logical step; pan, zoom, hit-testing and keyboard navigation; draws at most 5,000 states / 40,000 edges and says so when it truncates | `web/src/components/Graph.tsx`, `Rail.tsx` |
| B. Specification Desk | WML editor with highlighting and live line:column diagnostics, bounds, revision notes, content-addressed history and diffs | `Editor.tsx`, Revisions tab |
| C. Interleaving Theater | process lanes by logical step; the guard that enabled each step; every variable change; read/write sets; interference windows (stale reads, lost updates, check-then-act) derived from real steps; scrubber; pick which process moves next over the explored relation; save and replay schedules | `Theater.tsx` |
| D. Invariant Hall | per-property status with evidence text; mutation testing | `Panels.tsx` |
| E. Temporal Observatory | `eventually` / `leadsto` under explicit fairness; SCC statistics; lassos with a loop marker; fairness switches that edit the model; why reachability is not liveness | `Panels.tsx`, `liveness.ts` |
| F. Witness Archive | immutable runs; aligned comparison of two runs; receipt export, verify and tamper demonstration; HTML report export; annotations | `Archive.tsx` |
| G. Model Bazaar | 17 scenarios (35 models) by concept and level | `Bazaar.tsx`, `examples/` |
| H. Proof Observatory | generated TLA+ module and config; sandboxed TLC run; per-property comparison table | `Panels.tsx`, `src/core/tla` |

- **The 90-second guided journey** *(live)*: a panel with a clock that runs real checks: broken inventory model, shortest witness, repaired model, run comparison (11 to 5 states), TLC, then receipt verify and tamper. `docs/RECRUITER_DEMO.md`
- **Accessibility and mobile** *(live)*: keyboard graph navigation, a table fallback for the graph, reduced-motion support, axe checks (CodeMirror excluded from the scan), phone-width layouts (screenshots `evidence/screenshots/07-mobile.png`, `13a-*`, `13b-*`).

### E. Witness wing: the model catalog (17 scenarios, 35 models)

Each scenario has a broken and a repaired model unless noted. Titles come from `examples/catalog.json`; verdicts are never stored there.

| Scenario | Level | Idea |
| --- | --- | --- |
| Two threads share one counter | novice | non-atomic increment loses an update (`counter-race`, `counter-atomic`) |
| Two checkouts, one unit in stock | novice | double reservation (`inventory-race`, `inventory-atomic`) |
| Concurrent transfers | intermediate | conservation of money (`bank-transfer-race`, `bank-transfer-atomic`) |
| A lock built from a plain flag | novice | check-then-set vs test-and-set (`mutex-*`) |
| Two locks in opposite order | intermediate | deadlock and the lock-order fix (`lock-order-*`) |
| At-least-once delivery | intermediate | duplicate side effects and idempotency (`queue-*`) |
| Bounded buffer | novice | capacity and progress (`producer-consumer-*`) |
| Why liveness needs fairness | novice | reachable is not inevitable (`bounded-counter`, `bounded-counter-unfair`) |
| Starvation | advanced | unfair vs weak vs strong fairness (`starvation-*`) |
| Livelock vs Peterson | advanced | a fair livelock; Peterson's algorithm (`polite-livelock`, `peterson`) |
| Leader leases and fencing tokens | advanced | split brain (`lease-*`) |
| Reordered messages | intermediate | last write wins (`reorder-*`) |
| Cache-aside | intermediate | the stale refill (`cache-*`) |
| Retries | intermediate | duplicate authorization (`retry-*`) |
| Two-phase commit | advanced | presumed commit vs presumed abort (`two-phase-*`) |
| Three dining philosophers | intermediate | deadlock and ordering (`dining-philosophers-*`) |
| State explosion | intermediate | honest `INCOMPLETE` (`state-explosion`, `benchmark-grid`) |

### F. Compiler wing: the FOLIO language

FOLIO is a typed language for generative diagrams and small time-based visual stories. It cannot touch files, the
network or the DOM. A program is some `fn`s, some `data` declarations and exactly one `scene`.

```
source -> tokens -> AST -> typed AST -> register IR -> optimized IR -> verified bytecode -> bounded VM -> scene
                                          \------ independent AST reference interpreter (the oracle) ------/
```

- **Types** *(live)*: `Number` (finite IEEE-754 double), `Boolean`, `String`, `Color`, `Point`, `List<T>`. No generics, no implicit conversions, no null. `docs/TYPE_SYSTEM.md`
- **Statements** *(live)*: `let`, `var`, assignment, `if`/`else`, `repeat x in <range or list>`, `return`, `assert`, `group`, and drawing calls. Scene inputs: `WIDTH`, `HEIGHT`, `time`, `frame`; constants `PI`, `TAU`.
- **Drawing** *(live)*: `circle`, `rect` (with `corner`), `line`, `path` (open or closed), `text`; colours as `#hex`, `rgb`, `rgba`, `hsl`, `mix`, `alpha`.
- **Built-ins** *(live)*: `sin cos tan sqrt abs floor ceil round sign exp log min max pow atan2 noise clamp lerp point dist rgb rgba hsl mix alpha len str fmt`, all pure. `noise` is a fixed hash, so runs are reproducible. `wings/compiler/core/builtins.ts`
- **Datasets** *(live)*: `data name: List<Number> from "fixture"` binds read-only fixtures (rainfall, months, press inks, stations).
- **Deliberate limits** *(live)*: no recursion (`C012`), loops only over a range or an existing list, functions are pure (no drawing, no `time`), one scene per program, strings at most 1,000 UTF-16 units, call chains at most 63 deep. Every program terminates. `wings/compiler/docs/LIMITATIONS.md`
- **Diagnostics with codes** *(live)*: lexer `L`, parser `P`, checker `C`, structural `S`, runtime fault `R` codes, each with an exact span, a plain message and often a hint. The parser recovers and reports several errors. `wings/compiler/docs/FOLIO_LANGUAGE_SPEC.md`
- **Formatter** *(live)*: prints canonical source. `core/format.ts`

### G. Compiler wing: the compiler and VM

- **Front end** *(live)*: hand-written lexer and recursive-descent parser; checker with lexical scopes, typing, definite-return analysis and a recursion check. `core/lexer.ts`, `parser.ts`, `checker.ts`
- **Register IR** *(live)*: basic blocks with single-assignment registers; an IR verifier (single definition, dominance, arity, slots) runs after every pass. `core/lower.ts`, `ir.ts`, `irverify.ts`
- **Three optimization passes** *(live)*: constant folding with propagation, dead-code elimination, and common-subexpression elimination with copy propagation. Each has written legality rules; faulting operations are kept so the same fault happens in the same frame. `core/optimize.ts`, `wings/compiler/docs/OPTIMIZATION_CORRECTNESS.md`
- **Bytecode** *(live)*: stack bytecode with a SHA-256 content hash and a verifier for opcodes, operands, jump targets and stack depth. `core/bytecode.ts`
- **Sandboxed VM** *(live)*: fuel per frame (20,000,000) and per run (200,000,000), stack and call-depth limits, scene-size limits, no host access beyond pure built-ins. `core/vm.ts`, `limits.ts`, `wings/compiler/docs/VM_AND_SANDBOX.md`
- **Reference interpreter (the oracle)** *(live)*: a tree-walking evaluator that shares no evaluation code with the IR, optimizer or VM. Every run compares the scene hash of the VM with the oracle's, and the fault if any. `core/interpreter.ts`
- **Step debugger with time travel** *(live)*: line breakpoints, step/over/out, call stack, locals, operand stack, registers, watches, checkpoints and a "prove replay" check that a rewound state and a fresh replay hash the same. One frame per session. `core/debugger.ts`, `wings/compiler/docs/DEBUGGER_DESIGN.md`
- **Differential fuzzer and reducer** *(live)*: a seeded, type-directed program generator plus a token mutator; compares VM and oracle under several pass configurations; the reducer shrinks a diverging program to a smaller one that still diverges. `core/fuzz.ts`, `reduce.ts`
- **Fault lab** *(live)*: `BAD_cse_commute_all`, a deliberately wrong pass that treats subtraction as commutative; the oracle catches it on `fault-lab-commute.folio`.
- **Receipts** *(live)*: run receipts pin source, fixtures, versions, hashes and limits; `reproduce` recompiles and re-runs in a fresh process and rejects tampering with the hash, source or bytecode. `core/receipt.ts`
- **Compiler API** *(live)*, under `/engine/compiler`: read-only `GET /health`, `/capabilities`, `/runs`, `/runs/:id`; `GET /api/corpus`, `/api/fixtures`, `/api/runs/:id/bytecode`, `/api/runs/:id/bundle`; `POST /api/runs`, `/api/reproduce`, `/api/import`; projects with `GET/POST /api/projects`, `GET /api/projects/:id`, versions, restore and fork. Saving uses optimistic concurrency (a stale save gets 409). Imported bundles must reproduce before they are accepted. One job at a time, 15 s and 512 MB each.

### H. Compiler wing: the IDE (eight modes)

| Mode | What is real |
| --- | --- |
| A. Editorial | CodeMirror editor with highlighting from the real lexer, checker-backed diagnostics, scope-aware completion, type hovers, Format, save/fork/history/diff/restore, deep links; live pipeline rail with per-stage timing and hashes; scene canvas with frame scrubber and a per-frame VM = reference verdict |
| B. Syntax Furnace | token stream with spans; AST explorer synced to the editor selection; grammar rail from the spec |
| C. Type Observatory | scopes, symbols, uses, function signatures, call graph, datasets, and the type-derivation trace |
| D. Lowering Floor | IR before or after passes, a layered CFG with true/false/back edges, bytecode with stack effects, constant pool, content hash, verification status |
| E. Optimization Duel | pass toggles, struck-through removals, rewritten operands, pass log, equivalence over all frames, an in-browser interleaved timing, the recorded benchmark table, and **Every pass order** (the cross-feature) |
| F. Bytecode Theater | the real VM stepped by instruction, line, over and out; breakpoints; stacks, locals, registers, watches; time travel |
| G. Failure Gallery | 14 curated failures checked live, the fault lab and reducer, a tampered-bytecode demo, in-browser differential fuzzing |
| H. Proof Cabinet | server-recorded content-addressed runs; receipts; reproduce; tamper tests; bundle export and import |

- **Guided tour** *(live)*: eight steps, one per mode, loading a real example at each. `wings/compiler/web/src/Tour.tsx`
- **Examples** *(live)*: 13 programs (rainfall almanac and ledger, orrery, spiral garden, rain trace, Lissajous, ink wheel, checker press, station map, type specimen, clockwork, Fibonacci steps, optimizer bench). In each, the optimized VM output is byte-identical to the oracle's.
- **14 failure programs** *(live)*: each declares the diagnostic or fault it must produce and its exact position: lexical error, parse error, type mismatch, wrong arity, missing binding, missing return, immutable assign, recursion, assertion failure, divide by zero, index out of range, non-finite built-in, draw exhaustion, runaway loop.

### I. Cross-feature: the Witness wing checks the optimizer

- **Every pass order, model-checked** *(live)*: for a FOLIO seed, `bridge/pass-orders.ts` applies each pass in every order and repetition with the real `optimize()`, treats each distinct IR module (by SHA-256) as a state, labels it `agree`, `diverge`, `vm-fault` or `invalid` against the oracle, emits the graph as a WML model and lets the Witness engine check `OptimizedMatchesReference`. A violation is the shortest pass sequence that reaches a wrong program, with an independent replay and a standard receipt. A cap of 48 modules would turn the result into `INCOMPLETE`; it is not reached for any shipped seed (8 to 16 modules). `docs/CROSS_FEATURE_PASS_ORDERS.md`
- **Results (recorded)**: all 14 shipped seeds with `constfold, cse, dce` show `NO_DIVERGENCE_IN_ANY_PASS_ORDER`; with the wrong pass added, 13 seeds still show none and `fault-lab-commute` shows `DIVERGENCE_FOUND` with the shortest sequence `BAD_cse_commute_all`.
- **Evidence that regenerates** *(live)*: `evidence/bridge/` must regenerate byte for byte (a test checks it).
- **Endpoint** *(live)*: `POST /api/bridge/pass-orders` takes only a shipped seed name and `safe` or `mutant`, never source text.

### J. Shared shell and static demo

- **One shell** *(live)*: the same top bar in both wings with the name, the tagline, links between wings and the "Formerly Paper Tiger Compiler Works and The Impossible Witness" line. `web/shell/ShellBar.tsx`
- **One `/health`** *(live)*: names the app, its former names, and the status of each wing.
- **Static browser demo** *(Off by default; build with `VITE_DEMO=1`)*: the Compiler wing runs offline in the page; the Witness wing's checker runs in a Web Worker with an in-browser adapter and in-memory store. Nothing is sent anywhere. The TLC cross-check, project save/history/fork, the Proof Cabinet and the pass-order panel say they need the full app. The exact build command is not documented in the README (unverified). `web/src/demo`, PR #6

## 5. Integrations

- **TLC (TLA+ model checker)**, v1.7.4, MIT licence, downloaded once by `scripts/setup` with a SHA-256 check; run in a network-less, read-only container or on host Java. `THIRD_PARTY_NOTICES.md`
- **Read-only contract**: `GET /health`, `/capabilities`, `/runs`, `/runs/:id` on both wings, for an external dashboard to show liveness and the latest runs. They are GET-only, loopback-only and side-effect free. The Witness contract exposes slug, sanitised title, kind, status, verdict, counts and timestamps, never source, file paths or annotations.
- **GitHub Actions**: `.github/workflows/ci.yml` (Linux runner, actions pinned to commit SHAs) is in the repo; Actions are disabled on the repository.
- No other external services.

## 6. Data and privacy

- **Stored locally:** the Witness SQLite database (models, revisions, runs, annotations) and the Compiler SQLite database (projects, versions, runs). Both are git-ignored.
- **Synthetic data only:** all 35 models and 13 FOLIO programs are hand-written teaching examples; the four fixture datasets are small shipped files (`wings/compiler/examples/fixtures/README.md`). No real system was read or connected.
- **What leaves the machine:** nothing at run time. The only network use is `scripts/setup` downloading the pinned TLC jar (HTTPS only).
- **Network exposure:** binds `127.0.0.1` only; a non-loopback `Host` gets 421 (DNS-rebinding guard); cross-site requests get 403; POST bodies must be declared JSON (415 otherwise); bodies are capped (512 KiB in the Witness API) and over-deep JSON is refused. No authentication: do not expose the ports.
- **Untrusted input is data:** WML has no code; FOLIO is never JS-evaluated; fixture names are not paths; scene output is validated; bytecode is verified; imported bundles and receipts must reproduce.
- **Secrets:** none needed. Vulnerability reports go through GitHub private vulnerability reporting (`SECURITY.md`). Threat model, controls and the public-release red team (findings R1 to R7, all fixed with tests): `docs/SECURITY.md`, `wings/compiler/docs/SECURITY.md`.

## 7. Tests and evidence

Counted from source on 2026-11-15, not run. The README states the suite sizes below; the per-file `test(` counts in
source are lower because some tests are generated in loops.

| Suite | Command | Size |
| --- | --- | --- |
| Gate | `scripts/test` | typecheck (3 projects), ESLint (Compiler wing), all suites below, then `scripts/reproduce` |
| Witness wing | `npm run test:witness` | 112 (README); test files: explore, parser, examples, mutation, receipt, replay, liveness, tla, server, browser-core, legacy-receipts |
| Compiler wing | `npm run test:compiler` | 126 (README); files: frontend, differential, optimizer, backend, regressions, security, server, static, docs |
| Bridge | `npm run test:bridge` | 11 (README): `pass-orders`, `combined-server` |
| Browser journeys | `scripts/test --e2e` | 27 (README): 15 Witness journeys, 10 Compiler tests, 2 combined-shell tests; Playwright on 5726/5727 |
| Live TLC corpus | `scripts/test --tlc` | the whole Witness corpus against TLC |
| Fuzz | `scripts/test --fuzz` | 2,000 differential programs |

**Recorded evidence (with source):**
- TLC cross-check: 150/150 comparisons agree across 34 models (verdicts, state counts, lassos re-derived by the independent replay), generated 2026-11-13. `evidence/tlc-crosscheck.md`
- Fuzz campaign: 4,000 runs, 4,000 agree, 0 divergent, 0 rejected, 0 compiler crashes on mutations; 1,694 completed without a fault. `wings/compiler/evidence/fuzz-summary.json`
- Pass orders: see section 4.I. `evidence/bridge/`
- Receipts: Witness receipts under `evidence/demo/` (including a deliberately tampered one that must be rejected) and three Compiler receipts under `wings/compiler/evidence/receipts/`; legacy receipts of both original apps still verify (`tests/legacy-receipts.test.ts`).
- Checker speed (one machine, measured while other work ran, so orders of magnitude): about 73,000 states/s on the smallest model up to about 481,000 states/s on a 1,000-state model; a 160,000-state grid in about 853 ms. `evidence/benchmarks.md`
- Security scans recorded in `docs/SECURITY.md`: `npm audit` 0 vulnerabilities, trivy 0 findings, gitleaks clean on history and tree.
- Screenshots: 21 images in `evidence/screenshots/` plus more under `wings/compiler/evidence/screenshots/`.

## 8. Known limits and gaps

- **Models, not systems.** Atomicity of each action is an assumption; there is no real time; no check that code matches the model. `docs/LIMITATIONS.md`
- **Finite and small.** Explicit-state search stores every state; there is no symbolic search, symmetry or partial-order reduction. Beyond a cap the answer is `INCOMPLETE`.
- **Liveness** supports only `eventually` and `leadsto`, with weak/strong fairness on processes or action families; lassos are not minimal; no liveness on incomplete graphs.
- **Independence is partial.** The replay evaluator shares the parser with the explorer; TLC is fully independent but checks only what the exporter emits. The FOLIO oracle shares the front end, built-ins and scene builder with the VM.
- **Pass-order check** covers the 14 shipped seeds, their fixtures and default limits, and the three passes that exist. It is not a proof the optimizer is right for all programs.
- **Receipts** are tamper-evident by recomputation, not signed; they prove nothing to someone who does not re-verify.
- **FOLIO is teaching-size**: no recursion, modules, list building at run time or nested lists. Floating-point results are reproducible for one toolchain build, not claimed bit-equal across engines or platforms.
- **Debugger:** line breakpoints only, one frame per session, debugs the VM and not the oracle.
- **Graph drawing** is capped at 5,000 states; counts and verdicts cover everything.
- **Single user, loopback only, no authentication.**
- **TLC** needs Java or Docker; otherwise `INTERNAL_ONLY`.
- **Static demo:** the exact build command is not documented; TLC, saved projects and receipts storage are unavailable in it.
- Not built (named as out of scope in the docs): symbolic engine, partial-order reduction, symmetry, Alloy.

## 9. Change log

| Date | PR | Change |
| --- | --- | --- |
| 2026-11-15 | #6 | static browser demo (`VITE_DEMO=1`): Compiler wing offline, Witness wing in a Web Worker; pure SHA-256 shared by both wings |
| 2026-11-13 | #5 | SECURITY.md: maintainer email as a reporting contact |
| 2026-11-13 | #4 | SECURITY.md: report through GitHub private vulnerability reporting |
| 2026-11-13 | #3 | THE IMPOSSIBLE COMPILER WORKS: Paper Tiger merged into `wings/compiler/` with history, one shell, one API and one Vite, the pass-order cross-feature, red-team fixes R1 to R7, MIT licence, third-party notices, security policy, outsider README |
| 2026-11-13 | #2 | pin GitHub Actions to commit SHAs |
| 2026-11-13 | #1 | THE IMPOSSIBLE WITNESS v0.1 merged: model checker, TLC cross-check, receipts, visual lab |
| 2026-11-12 | (history) | Witness wing built: WML, BFS explorer, liveness, replay, receipts, TLA+/TLC, 35 models, service, UI, 150/150 TLC agreement. Paper Tiger built the same day: FOLIO compiler, VM, oracle, fuzzer, IDE, receipts |

## Keeping this file true

- **Same PR, same change.** A PR that adds, changes, removes or switches off something a person can see or use updates this file in that PR.
- **Status moves with reality.** Change a status word when the thing changes; do not leave "Planned" on something built.
- **Only what is true.** No claim without code, a test, a doc or recorded evidence behind it. Unknown stays unknown.
- **Repo gates.** Keep `docs/BUILD_LEDGER.md` truthful; the example catalog never stores verdicts; evidence in `evidence/bridge/` must regenerate byte for byte; `scripts/test` must pass.
