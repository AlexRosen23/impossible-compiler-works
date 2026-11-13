# Limitations

What FOLIO 0.1 and its implementation do not do, and why. Deliberate language limits come first, then
implementation trade-offs, then known defects.

## 1. Deliberate language limits

| Limit | Consequence | Reason |
|---|---|---|
| No recursion (direct or mutual) | `C012`; also rejected on IR and bytecode | every program terminates; no unbounded host or VM stack |
| Loops only over a range or an existing list | no `while`, no `break`, no `continue` | termination; the iteration limit is the only runtime bound needed |
| No list construction at run time | no append, no comprehension, no `range()` value; lists come from literals (at most 1,000 items) or datasets | lists stay immutable values with statically bounded size |
| No nested lists | `List<List<T>>` is `C015` | keeps the type system and fixture validation small |
| Functions are pure | no drawing or `group` in a function (`C011`), no access to `time`, `frame`, `WIDTH`, `HEIGHT` | a function's result depends only on its arguments, constants and datasets; this is what lets the scene be re-evaluated per frame |
| Hence no user-defined drawing helpers | a reusable "draw a flower" routine cannot be written as a function; functions can only compute the numbers, and the scene draws | consequence of purity |
| No modules or imports | one file per program | no file-system access, simple hashing and reproduction |
| Single scene per program | `P003` | one program, one picture or animation |
| Call chains at most 63 functions deep from the scene | `S004` | keeps every checked program inside the VM's call-depth limit, so both executors accept the same programs |
| Blocks nested at most 200 deep, expressions at most 200 deep | `S002` | bounded parser recursion |
| Monomorphic types | no generics, no user types; only `len` accepts any list | keeps checking and diagnostics simple |
| No implicit conversions | `"n=" + 3` is `C002`; use `str` or `fmt` | |
| No exponent number syntax | `1e3` is `L007`; write `1000` | the formatter prints full decimal expansions for this reason |
| No randomness, no clock | `noise(a, b)` is a fixed hash; `time` comes from the frame index | reproducibility |
| No null | optional primitive colours use an internal "none" value that source cannot write | |
| Numbers are always finite | a NaN or infinity at run time is fault `R001` | determinism and simpler optimizer legality |
| Strings at most 1,000 UTF-16 code units | `L006`, `F002`, `R009` | bounded output |

## 2. Determinism scope

FOLIO numbers are IEEE-754 doubles evaluated with JavaScript arithmetic and the host's `Math` functions (`sin`,
`cos`, `pow`, `exp`, `log`, `atan2`, `hypot` and others). ECMAScript does not require these functions to be
correctly rounded, so results can differ between JavaScript engines, engine versions or platforms.

What is claimed: for one toolchain build, the same source, fixtures, pass list, limits and compiler version
produce the same bytecode hash, trace hash and scene hash every time, and the VM and the reference interpreter
agree (tests, fuzz campaign and receipts on Node v24.14.0, darwin 27.0.0, Apple M5 Pro).

What is not claimed: bit-equality across platforms, engines or Node versions. A receipt produced on one machine
may legitimately fail `reproduce` on another if a `Math` function rounds differently. Constant folding evaluates
built-ins at compile time, so a module compiled on one engine and executed on another would mix two
implementations; receipts avoid this by always recompiling. The scene buffer quantizes numbers to 1e-4, which
hides many but not all last-bit differences.

## 3. Debugger limits

- Line breakpoints only. No conditional breakpoints, hit counts, watch expressions, column breakpoints or data
  breakpoints.
- One frame per session. Variables appear as raw slots and registers.
- Debugs the VM, not the reference interpreter.

## 4. Implementation trade-offs

| Area | Trade-off |
|---|---|
| Lowering | deliberately naive (every read of a `var` is a `load`, every `let` a `mov`) so the optimizer's effect is visible; costs VM instructions when optimization is off |
| IR | slots instead of phi nodes: no SSA construction needed, but constant propagation and CSE cannot see through slots across blocks |
| Optimizer | three simple passes (CSE is per block; only its copy propagation crosses blocks); no global value numbering, loop-invariant code motion, inlining or store-to-load forwarding; conservative about which built-ins can fault and never removes user-function calls |
| Code generator | every IR result goes through a register (`STORER`/`LOADR`); no stack scheduling or peephole pass |
| VM | a `switch` interpreter that checks fuel, updates a trace fingerprint and catches faults on every instruction; optimization gains in wall time are therefore small (median ×0.74 to ×1.27 in the recorded run, mostly within noise, `OPTIMIZATION_CORRECTNESS.md`) |
| Oracle independence | the reference interpreter shares the front end, built-ins, primitive table, value helpers and scene builder with the VM; bugs there are invisible to differential testing, which is why the shared built-ins and scene builder have direct unit tests in `tests/regressions.test.ts` |
| Fuel | each executor has its own (VM: 20,000,000 instructions per frame, 200,000,000 per run; reference interpreter: the same in evaluation steps); a legal program can exhaust one where the other finishes, reported as `oracle.status: "vm-resource-limit"` or `"reference-resource-limit"` |
| Fuzzer coverage | about 58% of campaign runs end in a fault (mostly `R001` and `R002`; 1,694 of 4,000 complete without one); happy-path drawing is exercised less than fault paths; `path`, datasets, list-typed variables and non-`Number` function signatures are not generated |
| Bytecode verifier | structural, not typed (whole-number operands, table sizes and headers are checked; value types are not); safe only because external bytecode is never executed |
| Server | one compile worker (jobs run one at a time, 15 s and 512 MB each); no authentication; no deletion API (old runs are pruned past 2,000) |
| IDE | compiles and runs on the page's main thread; a hostile project can make the tab slow for a few seconds before a limit stops it |
| Benchmarks | one machine, not idle-controlled; medians only meaningful where they exceed the spread |

## 5. Known defects

No defect found by the documentation review is open. The review of 2026-11-12 reported nine findings (the `0`/`-0`
constant conflation, VM-only call-depth and fuel faults on valid programs, a static-mode crash on a malformed URL,
unclamped receipt limits, deep block nesting ending in an `ICE`, the unused `P004` code, gaps in `validateScene`,
a stale comment about unit tests for shared modules, and call resolution recorded against a shadowing `let` plus
the unused `maxTraceSteps` limit). All were fixed in code; the behavioural ones have regression tests in
`tests/regressions.test.ts`. The static-mode URL fix lives in `server/static.ts` (answers 400) and is covered by
`tests/static.test.ts`, together with path-traversal checks.

What remains by design rather than as a defect: fuel exhaustion can stop one executor on a legal program the other
finishes (`R006` in the VM, `R014` in the reference interpreter); receipts report this as `vm-resource-limit` or
`reference-resource-limit` (section 4).
