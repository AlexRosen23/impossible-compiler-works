# Tests and Evidence

What is tested, how to run it, the current results, where the evidence files are, and the status of each core
capability.

## 1. Commands

| Command | What it runs | Writes files? |
|---|---|---|
| `npm test` | Vitest over `tests/**/*.test.ts` (60 s per-test timeout) | no |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` over `core`, `server`, `tests`, `scripts`, `web`, configs | no |
| `npm run lint` | ESLint | no |
| `npm run e2e` | Playwright suite `e2e/ide.spec.ts` against a static server on port 5590 | builds `dist/`, uses `var/e2e.sqlite`, writes screenshots |
| `npm run check` | typecheck, lint, test, build | builds `dist/` |
| `npm run folio -- <file> [--opt] [--ir] [--bc]` | compile, print stages, IR, disassembly, run VM and reference, print `AGREE`/`DIVERGE` | no |
| `npm run fuzz -- [count] [startSeed]` | differential fuzz campaign (default 2,000 seeds from 1) | `evidence/fuzz-summary.json`, `evidence/fuzz-failures/` |
| `npm run bench` | VM timing, passes off vs on (`WARMUP`, `RUNS` environment variables; defaults 5 and 25) | `evidence/benchmarks.json` |
| `npm run receipt -- <file> [outDir]` | make a receipt and bytecode artifact | `evidence/receipts/<name>/` by default |
| `npm run reproduce -- <receipt.json> [bytecode.json]` | re-check a receipt in a fresh process; exit 0 only if every check passes | no |

## 2. Test files

### `tests/frontend.test.ts` (24 tests)

| Group | Covers |
|---|---|
| lexer (4) | token kinds, exact spans and decoded values (including `\u{1F42F}` and colour lower-casing); `L002`, `L001`, `L003`, `L004`, `L005` with positions in one pass; `S001` for oversized source and `L006` for an oversized literal; contextual words `size`, `frames`, `background`, `from` usable as names |
| parser (4) | precedence and associativity; expected-token messages and recovery to several errors; chained comparisons, missing scene (`P002`), two scenes (`P003`), 300-deep parentheses and 300 unary minuses (`S002`); no throw on 11 malformed inputs |
| checker (6) | parse vs check as separate stages; scoping, `W001`, `C007`; immutability (`C006`), purity (`C011`), mutual recursion (`C012`), scene inputs invisible in functions (`C001`); definite return (`C009`) and `W002`; operator, call, list, field and named-argument typing (`C002`, `C013`, `C018`, `C005`, `C004`, `C008`, `C003`, `C017`, `C019`); the type derivation trace |
| failure gallery (9) | each of the 8 compile-time failure programs in `examples/failures/` reports its expected first error code at the expected line and column (`C006`, `L004`, `C001`, `C009`, `P001`, `C012`, `C002`, `C003`); every expected code is documented |
| check() is total (1) | a program with many kinds of error does not make the checker throw |

### `tests/differential.test.ts` (21 tests)

| Group | Covers |
|---|---|
| examples (13) | each of the 13 example programs: VM equals reference interpreter (scene hash and fault) under 7 pass configurations, and no fault |
| runtime faults (6) | each of the 6 runtime-fault programs (`R003`, `R001` twice, `R005`, `R002`, `R004`): identical code, offset and frame in both executors under 7 configurations; the offset matches the line and column in the file header |
| seeded fuzzing (2) | 300 generated programs agree with no passes and with all safe passes, none rejected, more than 20 faulting runs; 300 token-mutated programs never produce an `ICE`, and any that compile agree |

### `tests/optimizer.test.ts` (12 tests)

| Group | Covers |
|---|---|
| constant folding (4) | folding and propagation; a faulting `div 1, 0` is kept and faults identically; `0 * -1` and `1 / -0` fault identically; `sqrt(-4)` is not folded; constant branches folded and dead blocks removed |
| dead code elimination (2) | unused faulting operations are kept (strict evaluation); unused non-faulting results and never-read stores are removed |
| CSE (2) | repeated pure computations and loads are reused; only `add`, `mul`, `eq`, `ne` are treated as commutative |
| fault lab (3) | the fault-lab program agrees under safe passes; `BAD_cse_commute_all` makes the VM diverge from the reference; the reducer shrinks the divergence to a program less than half the size that still diverges |
| reporting (1) | the optimizer bench has fewer IR instructions and fewer VM steps with passes on, the same scene, and the reference agrees |

### `tests/backend.test.ts` (14 tests)

| Group | Covers |
|---|---|
| SHA-256 (1) | the local SHA-256 equals `node:crypto` on 7 inputs (empty, block boundaries 55/56/64, Unicode, 10,000 characters) |
| IR verifier (2) | lowered and optimized IR of every example verifies; an injected non-dominating use and a duplicate definition are rejected |
| bytecode verifier and loader (4) | compiler output verifies; unknown opcode, out-of-range jump and constant, stack-discipline violation, running past the end, and injected recursion are rejected; tampered, wrong-version and non-bytecode inputs are rejected before verification, a JSON round trip loads, a re-signed broken module is still rejected; compilation is deterministic (bytecode hash and every stage output hash) for every example |
| VM limits (2) | fuel exhaustion is a bounded `R006`; `validateScene` accepts a real scene and rejects an injected `url(javascript:...)` colour and a NaN transform |
| debugger (3) | instruction step, breakpoint, step in, step over, breakable lines; replay proof equal at 8 step positions and final state unchanged after rewind; bounded checkpoints on a 20,000-iteration loop |
| receipts (2) | a receipt reproduces from scratch including the oracle; edited fields, source, fixtures or bytecode artifact are detected |

### `tests/server.test.ts` (7 tests)

In-process server on an ephemeral port with an in-memory database.

| Group | Covers |
|---|---|
| read-only contract (3) | `/health`, `/capabilities`; a run is recorded, content-addressed (a second identical run deduplicates) and served by `/runs` and `/runs/{id}`; bad and unknown run ids; compile errors return 422 with diagnostics |
| API safety (2) | non-loopback `Host` refused (421); body over the cap (413), non-JSON (400), unknown pass (400), path-like fixture names in list and table form (400) |
| projects (1) | save, stale save refused with 409, restore, fork |
| export/import (1) | an exported bundle imports; a bundle with an edited bytecode constant or edited source is refused (422) |

### `tests/regressions.test.ts` (10 tests)

Added after the documentation review of 2026-11-12.

| Group | Covers |
|---|---|
| review findings (7) | `-0` survives constant folding, the constant pool and CSE keys; a deep non-recursive call chain is rejected statically with `S004`; fuel exhaustion is reported as `vm-resource-limit`, not a divergence; a receipt cannot raise host limits; deeply nested blocks give `S002`, not an `ICE`; `validateScene` rejects a bad background, opacity and point coordinate; a `let` shadowing a function name does not take the call's resolution |
| shared output device and built-ins, unit tests (3) | colour clamping and rounding, `hsl`, `mix` and `alpha` on known values; `noise` determinism and range, `fmt` digit clamping, non-finite results fault; scene-builder transform composition (translate, rotate, scale), opacity multiplication and limits |

### `tests/security.test.ts` (24 tests)

One reproduction per finding of the pre-release red team (`SECURITY.md` section 5), each of which crashed, hung or
misreported before its fix: an exponential call tree stops on `R013` in both executors within seconds and agrees;
work the VM folds away stops the reference interpreter on `R014` and is reported as `reference-resource-limit`;
whole-run fuel in both executors; scene size per frame and per run (`R005`) for the out-of-memory path program and
the long-text program, with both executors stopping at the same frame; a 3,000-term chain gives `S002`, not an
exception; nesting summed across calls gives `S005`; `toString`, `valueOf`, `constructor`, `hasOwnProperty` and
`__proto__` work as function names and agree; 2,600 checker errors stop at `maxErrors` with `S006` in well under
3 s, and 20,000 lexer errors stop too; an unpaired surrogate gives `L008`; nine crafted bytecode modules are
rejected with messages, never exceptions, and a 2,000-function chain is checked without host recursion; ten
malformed receipts fail a check without throwing; `-0` and `0` fixtures give one scene hash; `validateScene`
rejects prototype names, unknown arguments and oversized scenes; `npm run fuzz -- --help` leaves the evidence
untouched.

The server suite (`tests/server.test.ts`, now 15 tests) adds the network side: cross-site and cross-origin
requests are refused with 403 before any work; a hostile program records in seconds while `/health` keeps
answering; a 20,000-pass receipt is rejected at once; the fixture name `constructor` is a 404; old runs are
pruned to the cap; the job runner stops a job past its time limit, survives a job that exhausts its heap, and
answers busy when its queue is full. The E2E suite adds one test: a crafted project deep link never makes the
IDE request another API path.

### `tests/docs.test.ts` (2 tests)

`TYPE_SYSTEM.md` has a table row for every code in `DIAGNOSTIC_CODES`; `FOLIO_LANGUAGE_SPEC.md` names every
runtime fault code, every built-in as `name(` and every primitive.

### `tests/helpers.ts`

Not a test file. Loads examples, failure cases (parsing the `// expect: CODE @ line:col` or
`// expect-fault: ...` header) and fixtures, and defines the observable `outcome` (scene hash plus fault code,
offset and frame) and `differential(source, passes)`.

### `e2e/ide.spec.ts` (10 tests)

A Playwright suite for the browser IDE, run with `npm run e2e` against the production build in static mode: the
six required demonstrations, save and reopen with conflict handling, the phone layout, accessibility basics and
injection safety, and the deep-link check above.

## 3. Current results

Run on 2026-11-13 (UTC) on Node v24.14.0, darwin 27.0.0, at commit `c437b8f` plus the documentation updates in
the same branch (`chore/public-release-hardening`).

| Check | Result |
|---|---|
| `npx vitest run` | 9 files, 126 tests: frontend 24, differential 21, optimizer 12, backend 14, server 15, static 4, regressions 10, security 24, docs 2 |
| ESLint | exit 0, no findings |
| `npm run typecheck` (`tsc --noEmit`) | exit 0, no errors |
| `npm run reproduce` on all three committed receipts (with their bytecode artifacts) | 14 of 14 checks passed for each |
| `npm run e2e` | 10 tests passing |
| `npm run fuzz -- 2000` | 4,000 of 4,000 runs agree, 1,694 complete without a fault, 0 rejected, 0 compiler crashes on mutations |
| `npm audit` (production and development) | 0 vulnerabilities |

## 4. Evidence files

| Path | Content | Produced by |
|---|---|---|
| `evidence/fuzz-summary.json` | fuzz campaign summary: seeds, configurations, agreement, divergences, rejections, compiler crashes on mutations, fault distribution, duration | `npm run fuzz` |
| `evidence/fuzz-failures/` | reduced reproducers for any divergence or rejection (empty: none found) | `npm run fuzz` |
| `evidence/benchmarks.json` | per-example VM instruction counts and wall-time statistics, passes off and on, with environment | `npm run bench` |
| `evidence/receipts/02-rainfall-ledger/` | `receipt.json` and `bytecode.json` | `npm run receipt` |
| `evidence/receipts/04-spiral-garden/` | same | `npm run receipt` |
| `evidence/receipts/13-optimizer-bench/` | same | `npm run receipt` |
| `evidence/screenshots/` | IDE screenshots from the E2E suite | `npm run e2e` (not described here) |

Receipts (regenerated 2026-11-12 around 16:45 UTC; all with passes `constfold, dce, cse`, `commit` field
`9f5ffd9` (the working tree also had uncommitted fixes), no fault, `oracle.status: "agree"`):

| Receipt | Bytecode hash (prefix) | Scene hash (prefix) |
|---|---|---|
| `02-rainfall-ledger` | `e71fe164b8dc` | `f66812f02eb9` |
| `04-spiral-garden` | `bba52f16f37d` | `304c9f705ab9` |
| `13-optimizer-bench` | `de3aaabc947c` | `722eb8b18e7a` |

The fuzz and benchmark numbers are quoted, with their interpretation, in `OPTIMIZATION_CORRECTNESS.md`
sections 3.4 and 4.

## 5. Status vocabulary

| Status | Meaning |
|---|---|
| `WORKING_AND_TESTED` | implemented and covered by automated tests that pass now |
| `PARTIAL` | implemented with a known gap or defect, or only partly tested |
| `FAILED` | implemented but currently failing its tests |
| `NOT_BUILT` | not implemented |
| `OWNER_ACTION` | needs a decision or an action by the owner |

## 6. Status of core capabilities

| Capability | Status | Basis |
|---|---|---|
| Lexer (tokens, spans, escapes, colours, comments, `L` codes) | `WORKING_AND_TESTED` | frontend lexer tests |
| Parser with recovery, precedence, non-associative comparisons, nesting limits | `WORKING_AND_TESTED` | frontend parser tests; block-nesting `S002` in regressions |
| Checker: scopes, types, definite return, recursion, call depth (`S004`), scene options | `WORKING_AND_TESTED` | frontend checker and failure-gallery tests; `S004` in regressions |
| Diagnostic code table matches documentation | `WORKING_AND_TESTED` | `tests/docs.test.ts` |
| Fixture binding (`F` codes) | `PARTIAL` | used by examples and server tests; no dedicated test for each `F` code |
| Lowering to IR and IR verifier | `WORKING_AND_TESTED` | backend IR tests, differential tests |
| `constfold` (including `-0` preservation) | `WORKING_AND_TESTED` | optimizer legality tests, differential tests, `-0` regression test |
| `dce` | `WORKING_AND_TESTED` | optimizer and differential tests |
| `cse` (with copy propagation) | `WORKING_AND_TESTED` | optimizer and differential tests, fuzz campaign |
| Fault lab (`BAD_cse_commute_all` caught by the oracle) | `WORKING_AND_TESTED` | optimizer fault-lab tests |
| Bytecode codegen, constant encoding, serialization, hash, verifier | `WORKING_AND_TESTED` | backend bytecode tests (verifier is structural, by design) |
| VM with per-frame and per-run fuel, call, stack and call-depth limits | `WORKING_AND_TESTED` | VM tests and `tests/security.test.ts`; fuel is each executor's own limit by design, reported as `vm-resource-limit` or `reference-resource-limit` |
| Bounded total work and memory of any run (call limit, scene size, both fuels, `S005`) | `WORKING_AND_TESTED` | `tests/security.test.ts` |
| Server jobs on a worker with time and heap limits; cross-site and cross-origin refusal; storage caps | `WORKING_AND_TESTED` | `tests/server.test.ts` |
| Reference interpreter (oracle) | `WORKING_AND_TESTED` | differential tests; shares built-ins, primitives, values and scene builder with the VM |
| Built-ins and scene builder (shared by both executors) | `WORKING_AND_TESTED` | direct unit tests in `tests/regressions.test.ts`, plus examples and fuzzing |
| Primitive table | `PARTIAL` | exercised by every example and the fuzzer; no dedicated unit test |
| `validateScene` | `WORKING_AND_TESTED` | backend and regression tests |
| Receipts, oracle status and `reproduce` (including the limits cap) | `WORKING_AND_TESTED` | backend, server and regression tests; 3 committed receipts reproduce |
| Debugger (stepping, line breakpoints, checkpoints, replay proof) | `WORKING_AND_TESTED` | backend debugger tests |
| Conditional breakpoints | `NOT_BUILT` | |
| Fuzzer, mutator and reducer | `WORKING_AND_TESTED` | differential and optimizer tests; campaign evidence |
| Server API, storage, migrations, projects, import/export | `WORKING_AND_TESTED` | server tests |
| Static-file serving (`PT_STATIC=1`), including the 400 for malformed URLs | `WORKING_AND_TESTED` | `tests/static.test.ts` (`server/static.ts`): CSP, SPA fallback, 400, path traversal; the E2E suite also runs in static mode |
| Cross-platform bit-identical results | `NOT_BUILT` | not claimed (`LIMITATIONS.md`) |
| Enabling CI (GitHub Actions) | `OWNER_ACTION` | Actions are off for this repository |

IDE: see BUILD_LEDGER.md.
