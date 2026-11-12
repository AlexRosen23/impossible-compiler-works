# Compiler Pipeline

Implementation: `core/pipeline.ts` (`compile`), with one module per stage. Execution (VM or reference
interpreter) is a separate step that runs only after a successful compile.

```
source ──lex+parse──▶ tokens + AST ──check──▶ symbols + types ──fixtures──▶ bound datasets
       ──lower──▶ IR ──optimize──▶ optimized IR ──codegen──▶ bytecode ──verify──▶ serialized bytecode + hash
                                                                           │
                       ┌───────────────────────────────────────────────────┤
                       ▼                                                   ▼
           runVM (core/vm.ts)                           interpret (core/interpreter.ts)
           bytecode → scene                              checked AST → scene  (the oracle)
```

## 1. Stages

| # | Stage name (`StageName`) | Module | Input | Output | Fails on |
|---|---|---|---|---|---|
| 1 | `lex+parse` | `lexer.ts`, `parser.ts` | source string | token list (including comments) and AST (`Program`) | any `L`, `P` or `S001`/`S002` error |
| 2 | `check` | `checker.ts` | AST | `CheckResult`: symbols, scopes, node types, resolutions, call graph, type trace, scene info | any `C` or `S003` error (warnings do not fail) |
| 3 | `fixtures` | `fixtures.ts` | `CheckResult` + host fixture table | map from dataset name to frozen value | any `F` error |
| 4 | `lower` | `lower.ts`, `irverify.ts` | AST + `CheckResult` | IR module (`IRModule`) | IR verifier error or IR call-graph cycle (reported as `ICE`) |
| 5 | `optimize` | `optimize.ts` | IR module + pass list | optimized IR module + one `PassReport` per pass | IR verifier error after any pass (thrown, recorded as `ICE`) |
| 6 | `codegen` | `bytecode.ts` | optimized IR | `BCModule` (stack bytecode, constant pool, debug tables) | only on an internal exception (`ICE`) |
| 7 | `verify` | `bytecode.ts` | `BCModule` | `SerializedBC` (module plus content hash) | bytecode verifier error (reported as `ICE`) |

The pipeline stops at the first stage that fails; later stages are not recorded. `CompileResult.ok` is true only
when all seven stages succeed. An exception thrown inside any stage is caught and recorded as a failed stage with
an `ICE` diagnostic ("internal compiler error in <stage>: ..."), so a compiler bug never crashes the host
process (`tests/differential.test.ts` checks that 300 mutated programs never produce an `ICE`).

The optimizer runs with the pass list given in `CompileOptions.passes`; the default is no passes. The safe
passes are `constfold`, `dce`, `cse` (`SAFE_PASSES`, in that order); `BAD_cse_commute_all` exists only for the
fault lab (`OPTIMIZATION_CORRECTNESS.md`). Passes run in the order given and may repeat.

## 2. StageRecord

Every stage appends one record to `CompileResult.stages`:

| Field | Meaning |
|---|---|
| `stage` | stage name from the table above |
| `compilerVersion` | `COMPILER_VERSION` (`0.1.0`) |
| `inputHash` | SHA-256 identifying the stage input (see section 3) |
| `outputHash` | SHA-256 of the canonical JSON of the stage output, or `null` when there is no output |
| `ok` | false if the stage produced at least one error |
| `diagnostics` | the stage's diagnostics (errors and warnings) |
| `ms` | measured wall time of the stage in milliseconds (rounded to 1 µs) |
| `summary` | one human-readable line, for example `154 tokens, 3 top-level items` |

Real output of `node scripts/folio.ts examples/04-spiral-garden.folio --opt` (timings vary per run):

```
  [ok ] lex+parse    3.469 ms  154 tokens, 3 top-level items
  [ok ] check        1.517 ms  15 symbols in 6 scopes, 57 typed expressions
  [ok ] fixtures     0.167 ms  0 dataset(s) bound
  [ok ] lower        2.687 ms  3 function(s), 9 blocks
  [ok ] optimize      1.77 ms  constfold: 56→52, dce: 52→51, cse: 51→47
  [ok ] codegen       0.65 ms  138 instructions, 16 constants
  [ok ] verify       0.746 ms  bytecode 2b8c36b558cc… verified
```

## 3. What is hashed

All hashes are SHA-256 (`core/sha256.ts`, a dependency-free implementation cross-checked against `node:crypto`
in `tests/backend.test.ts`) over canonical JSON (`canonicalJson`: object keys sorted, no whitespace, `-0`
written as `0`, `undefined` fields dropped, non-finite numbers rejected).

| Stage | `inputHash` | `outputHash` covers |
|---|---|---|
| `lex+parse` | SHA-256 of the raw source text (UTF-8) | the whole AST, including node ids and spans (spans are part of the AST's identity, so whitespace or comment edits change this hash) |
| `check` | the `lex+parse` output hash | `{ symbols, types, scene }` |
| `fixtures` | hash of the fixture table passed in | the list of bound dataset names |
| `lower` | the `check` output hash | the encoded IR module (`encodeModule`: constants in JSON-safe form) |
| `optimize` | hash of `{ irHash, passes }` | the encoded optimized IR module |
| `codegen` | the `optimize` output hash | the bytecode module; this equals the bytecode content hash |
| `verify` | the `codegen` output hash | `{ hash }` of the serialized bytecode, or `null` on failure |

The bytecode content hash (`bytecodeHash`) is SHA-256 of the canonical JSON of the module without its `hash`
field. It covers the format and version strings, scene header, dataset declarations, constant pool, every
function's code, slot names and the debug tables (spans and IR ids). Changing a source span therefore changes the
bytecode hash even if the instructions are identical.

## 4. Determinism

For a fixed source, fixture table, pass list, limits and compiler version, every `outputHash` and the bytecode
hash are identical across runs; only `ms` differs. `tests/backend.test.ts` ("compiles deterministically")
compiles every example twice and compares the bytecode hash and all stage output hashes. Reasons this holds:

- No stage reads a clock, random source, environment variable or file; the only clock use is `performance.now()`
  for the `ms` field.
- AST node ids, IR instruction ids, register numbers, slot numbers and block ids are assigned by counters in a
  fixed traversal order.
- Map iteration in the passes follows insertion order, which is fixed by the traversal.
- Hashes use canonical JSON, so object key order never matters.

What is not claimed: bit-identical results across JavaScript engines or platforms. Numeric built-ins use the
host's `Math` functions, and constant folding evaluates them at compile time with the same functions the VM uses
at run time. Determinism is claimed and tested for one toolchain build (Node 24.14.0 on the machine that produced
the evidence files). See `LIMITATIONS.md`.

## 5. After compilation: execution and receipts

- `runVM(bytecode, data, limits)` runs every frame (or one) and returns the scene, the first fault, per-frame
  step counts and a trace hash (`VM_AND_SANDBOX.md`).
- `interpret(program, check, data, limits)` runs the checked AST directly and returns the scene and the first
  fault. It is the oracle for differential testing (`OPTIMIZATION_CORRECTNESS.md`).
- `makeReceipt` (`core/receipt.ts`) compiles, runs the VM, runs the reference interpreter and records everything
  needed to reproduce the run:

| Receipt field | Content |
|---|---|
| `format` | `paper-tiger-receipt/0.1` |
| `versions` | compiler, grammar, IR, bytecode and scene format versions |
| `project`, `files`, `source`, `sourceHash` | the embedded source and its SHA-256 |
| `fixtures`, `fixtureHash` | the embedded fixture table and its canonical hash |
| `optimizations` | the pass list |
| `seed` | always `null` (FOLIO has no randomness) |
| `limits` | `fuelPerFrame`, `maxIterationsPerFrame`, `maxDrawsPerFrame`, `maxStack`, `maxCallDepth` |
| `bytecodeHash`, `traceHash`, `sceneHash` | results of the VM run |
| `fault` | `{ code, frame, line }` or `null` |
| `oracle` | the reference interpreter's scene hash and whether VM and reference agree (scene hash, fault code and fault offset) |
| `warnings` | warning codes with positions |
| `timingMs` | compile, VM and reference wall times |
| `commit`, `createdAt` | git commit of the compiler (if known) and creation time |
| `digest` | SHA-256 over every field except `timingMs`, `createdAt` and `digest` |

`reproduce(receipt, bytecode?)` re-derives everything that can be recomputed: format, digest, compiler and
bytecode versions, source hash, fixture hash, a fresh compile to the same bytecode hash, optional loading and
verification of an exported bytecode artifact and its hash, a VM re-run to the same trace and scene hashes, the
reference interpreter's scene hash, and VM/reference agreement. `npm run reproduce <receipt.json>
[bytecode.json]` prints one PASS/FAIL line per check and exits 1 if any fails. The committed evidence receipt
`evidence/receipts/02-rainfall-ledger/` passes all 13 checks (run on 2026-11-12, see `TEST_AND_EVIDENCE.md`).

## 6. Command-line entry points

| Command | Script | What it does |
|---|---|---|
| `npm run folio -- <file> [--opt] [--ir] [--bc]` | `scripts/folio.ts` | compile (with `SAFE_PASSES` when `--opt`), print diagnostics and stage records, optionally the IR listing and disassembly, run VM and reference, print `AGREE` or `DIVERGE` |
| `npm run receipt -- <file> [outDir]` | `scripts/receipt.ts` | write `receipt.json` and `bytecode.json` (default `evidence/receipts/<name>/`) |
| `npm run reproduce -- <receipt> [bytecode]` | `scripts/reproduce.ts` | re-check a receipt in a fresh process |
| `npm run fuzz -- [count] [startSeed]` | `scripts/fuzz.ts` | differential fuzz campaign; writes `evidence/fuzz-summary.json` |
| `npm run bench` | `scripts/bench.ts` | VM timing with passes off and on; writes `evidence/benchmarks.json` |
