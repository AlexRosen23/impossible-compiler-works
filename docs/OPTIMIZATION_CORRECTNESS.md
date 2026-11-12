# Optimization and Correctness

Implementation: `core/optimize.ts` (passes), `core/ir.ts` (op classification), `core/irverify.ts` (verifier),
`core/interpreter.ts` (oracle), `core/fuzz.ts` (generator and mutator), `core/reduce.ts` (reducer). Evidence:
`tests/optimizer.test.ts`, `tests/differential.test.ts`, `evidence/fuzz-summary.json`, `evidence/benchmarks.json`.

## 1. The correctness contract

An optimization is correct when, for every checked program and every frame, the optimized program produces the
same observable result as the unoptimized one and as the reference interpreter. "Observable" is defined by the
test helper `outcome` (`tests/helpers.ts`) and by the fuzz harness:

- the scene hash (SHA-256 of the canonical scene output, i.e. every draw command of every frame drawn before the
  run stopped), and
- the fault, if any: its code, its source offset (`span.start`) and its frame index.

So a pass must preserve not only the picture but also which fault happens, where, and in which frame. That rules
out the usual compiler licence to remove or reorder operations that might trap.

One exception is outside the contract: the VM's fuel limit (`R006`), a machine limit the reference interpreter
does not have. A run that stops on fuel is not compared; receipts record it as `oracle.status:
"vm-resource-limit"` instead of `agree` or `diverge` (`COMPILER_PIPELINE.md` section 5). The passes only remove or
simplify instructions, and in every benchmarked example the optimized program executes fewer VM instructions
(section 4); this is an observation, not a proved property.

Facts the passes rely on:

1. Every `Number` is finite at run time. Every arithmetic operator and numeric built-in result is checked; a
   non-finite result is fault `R001`. Literals and fixtures are finite. So NaN never flows as a value.
2. Evaluation order is left to right, strict, with short-circuit `and`/`or` (lowered to explicit branches).
3. Registers are single-assignment and their definitions dominate their uses (verified after every pass).
4. Values are immutable; slots are the only mutable state, and only `store` changes them. A `callf` cannot
   touch the caller's slots.
5. Ops are classified in `core/ir.ts`: `PURE_OPS` (no effect besides the result), `FAULTING_OPS` /
   `canFault` (may raise a fault), `COMMUTATIVE` (`add`, `mul`, `eq`, `ne`).

## 2. Passes and their legality preconditions

The pass driver (`optimize`) clones the module, runs each requested pass over every function, runs `verifyIR`,
and throws (recorded as `ICE`) if verification fails. Each pass reports instruction counts before and after and a
list of changes (kind, instruction id, detail) that the IDE and the CLI show.

### 2.1 `constfold`: constant folding and propagation

Blocks are visited in reverse post-order, so a register's definition is seen before its uses.

| Transformation | Precondition |
|---|---|
| Substitute a known constant for a register operand | the register was folded to that constant (single assignment makes the substitution valid everywhere) |
| Fold an instruction to a constant | the op is pure and not `global`; it defines a register; every operand is a constant; and evaluating it with `evalPure` (the VM's own semantics from `core/ops.ts`) does not throw a fault |
| Remove `assert true` | the condition is the constant `true` |
| Remove `rangechk a, b` | both bounds are constant whole numbers |
| Replace `br c, T, F` with `jmp` | `c` is a constant |

Legality points:

- **Faulting operations.** If evaluating the operation would fault (`1 / 0`, `sqrt(-4)`, an out-of-range index),
  the fold is abandoned and the instruction stays, so the fault still happens at run time, at the same point,
  with the same span. Tested: `div 1, 0` and `callb sqrt(-4)` remain in the optimized IR, and the VM and the
  reference interpreter report the same `R001`.
- **Computing exactly what the VM computes.** Folding calls the same `evalPure` the VM calls, on the same
  JavaScript engine, so a folded value is bit-identical to the value the VM would have produced (including
  `-0` and built-in rounding). This is also why the determinism claim is per toolchain build: a module compiled
  on one engine and run on another would mix two `Math` libraries.
- **`-0` is preserved.** The fold computes `-0` where the VM would (for example `0 * -1` folds to `-0`), and the
  resulting constant keeps its sign everywhere downstream: constants are encoded with an explicit `{ neg0: true }`
  form (`core/values.ts`), so the code generator's constant pool, the CSE key and serialized bytecode all
  distinguish `-0` from `0`. Before that encoding existed, both the pool and the CSE key identified constants by
  canonical JSON, which writes `-0` as `0`, and a function with both constants after folding was miscompiled
  (observable through `atan2`). The bug was found by review while writing these documents, not by the fuzzer; it
  is fixed and guarded by a regression test in `tests/regressions.test.ts` (`VM_AND_SANDBOX.md` section 7).
- **NaN.** By fact 1 no NaN value exists to fold; an operation that would produce NaN faults and is not folded.
- **Evaluation order.** Folding never moves an instruction. Removing a successful, effect-free computation
  cannot change the order of faults or effects.

### 2.2 `dce`: dead code elimination

Four steps, in order:

| Step | Removes | Precondition |
|---|---|---|
| 1 | unreachable blocks | not reachable from the entry block |
| 2 | `store` instructions | the slot is never `load`ed anywhere in the function (parameters and inputs are written by the caller, not by stores) |
| 3 | instructions whose result is unused, repeated to a fixpoint | the op is pure and `canFault` is false |
| 4 | a block boundary (merges B into A) | A ends in `jmp B`, B is not the entry block or A itself, and A is B's only predecessor |

Legality points:

- **Strict evaluation is preserved.** An unused computation that can fault is kept. `let _unused = 1 / 0;` still
  faults `R001` after DCE (tested). Only operations that cannot fault are removed: arithmetic, `concat`,
  `index` and every built-in outside `NONFAULTING_BUILTINS` are never removed even when unused.
- **Conservatism.** `NONFAULTING_BUILTINS` leaves out `tan`, `atan2` and `len`, which cannot actually fault on
  finite input; they are simply never removed. `callf` is never removed (it is not in `PURE_OPS`), even though
  user functions are pure.
- **Effects are never removed:** `draw`, `gpush`, `gpop`, `assert`, `tick`, `rangechk`, `callf`, and `store` to a
  slot that is read somewhere.

### 2.3 `cse`: common subexpression elimination (local value numbering)

Within each basic block, independently:

- An eligible instruction is keyed by `op | builtin name | field | operand keys`, where a register operand's key
  is its number and a constant's key is its canonical JSON. For `add`, `mul`, `eq` and `ne` the operand keys are
  sorted first. If an earlier instruction in the block has the same key, every use of the later register is
  replaced by the earlier one and the later instruction is removed.
- Eligible ops: the pure ops except `mov`, `list` and `global` (so arithmetic, comparisons, `not`, `neg`,
  `concat`, `callb`, `index`, `field`, `len`). `callf` is never reused.
- Redundant loads: a `load` of a slot already loaded earlier in the block, with no `store` to that slot in
  between, reuses the earlier register. (A `store` followed by a `load` of the same slot is not forwarded.)
- Copy propagation: a `%d = mov %s` whose operand is a register is removed and every use of `%d`, anywhere in
  the function, is replaced by `%s`. It is reported as a change of kind `reused` with the detail
  `copy %d → %s (let name)`. (A `mov` of a constant is handled by `constfold`.)

Legality points:

- **Operands are equal values.** Registers are single-assignment and immutable, so two instructions with the same
  op and the same operand registers compute the same value (or the same fault). Loads are only reused while the
  slot is provably unchanged within the block.
- **Reusing the result of a faulting op is safe.** If the first copy faulted, execution stopped there and never
  reached the second copy; the fault code and span are those of the first copy, which is the one that runs first
  in the unoptimized program too. If the first copy succeeded, the second would have produced the same value.
- **Dominance.** The kept instruction is earlier in the same block, so it dominates the removed one and therefore
  every use of it; the global substitution keeps the dominance invariant, which `verifyIR` re-checks.
- **Copy propagation is global and safe.** `%s` and `%d` are single-assignment, so they hold the same value
  wherever `%d` is live; `mov` cannot fault and has no effect, so removing it changes neither faults nor their
  order; and the definition of `%s` dominates the `mov`, which dominates every use of `%d`, so the substituted
  uses are still dominated (re-checked by `verifyIR`).
- **Commutativity is per op.** IEEE addition and multiplication are commutative for every finite input
  (including signed zeros) and equality is symmetric. Subtraction, division, remainder and the ordered
  comparisons are not commuted (tested: `i - 1` and `1 - i` are not merged).
- **Signed zero in keys:** constant keys use the `{ neg0: true }` encoding, so `x + 0` and `x + -0` are never
  merged (section 2.1).

### 2.4 What the passes do not do

No global value numbering (CSE is per block; only copy propagation crosses blocks), no loop-invariant code
motion, no inlining, no store-to-load forwarding, no slot promotion to registers, no strength reduction and no
dead-code removal of user-function calls. The bytecode generator does no stack scheduling.

## 3. How correctness is checked

### 3.1 IR verification after every pass

`verifyIR` (structure, single definition, dominance; see `INTERMEDIATE_REPRESENTATION.md` section 5) runs after
lowering and after every pass; `tests/backend.test.ts` additionally checks lowered and optimized IR of every
example.

### 3.2 Differential tests across 7 pass configurations

`tests/differential.test.ts` compares the VM against the reference interpreter for every example and every
fault-gallery program under seven configurations:

```
[]  [constfold]  [dce]  [cse]  [constfold, dce]  [constfold, dce, cse]  [cse, constfold, dce, cse]
```

- 13 example programs: the observable outcome must be equal and fault-free under every configuration.
- 6 runtime-fault programs (`R001` twice, `R002`, `R003`, `R004`, `R005`): equal outcome under every
  configuration, and the fault's offset must land on the line and column stated in the file's header comment.

### 3.3 Seeded fuzzing in the test suite

Same file:

- 300 generated programs (seeds 1 to 300), each compiled with no passes and with all three safe passes; VM and
  reference must agree on every one, no program may be rejected by the checker, and more than 20 runs must end in
  a fault (so fault paths are exercised).
- 300 token-mutated programs: compilation must never produce an `ICE`; if a mutant happens to compile, VM and
  reference must agree.

The generator (`core/fuzz.ts`, `Generator`) is seeded with `mulberry32` and builds a well-typed AST directly:
0 to 2 functions of 1 or 2 `Number` parameters, a scene with 1 to 3 frames and 3 to 10 statements (`let`, `var`,
assignment, `if`/`else`, range and list `repeat`, `assert`, `circle`/`rect`/`line`/`text` with shuffled named
arguments, `group`), and expressions of types `Number`, `Boolean`, `String`, `Color` and `Point`. The AST is
printed by the formatter and goes through the real parser and checker.

To keep a useful share of runs fault-free, the generator biases towards valid operations while still producing
faulting ones: 70% of `/` and `%` divisors are written as `abs(e) + 1`; 85% of `sqrt` arguments are wrapped in
`abs`; 85% of `pow` exponents are a small constant 0 to 3; the literal `0` is chosen 5% of the time; and 75% of
`assert` statements check `e == e` for a copy of the same expression (which can only stop through a fault inside
`e`), the rest an arbitrary Boolean. (These biases are in the working tree at the time of writing; the comment in
`core/fuzz.ts` records that before the divisor guard about 98% of `R001` faults in the campaign came from `/` or
`%` by zero.)

It does not generate `path`, datasets, list-typed variables, string escapes beyond its fixed leaf set, or
non-`Number` function signatures.

### 3.4 Fuzz campaign (`npm run fuzz`)

`scripts/fuzz.ts` runs the same comparison for many seeds (default 2,000, starting at 1) under two
configurations (`none` and `constfold+dce+cse`), also checks that a mutated variant of each program never makes
the compiler throw or emit an `ICE`, reduces any divergence and writes it to `evidence/fuzz-failures/`.

Recorded result (`evidence/fuzz-summary.json`, regenerated on 2026-11-12 around 16:44 UTC from the working tree
at commit `9f5ffd9` plus the uncommitted review fixes, with CSE copy propagation and the generator biases
described above):

| Field | Value |
|---|---|
| seeds | 1 to 2000 |
| configurations | `none`, `constfold+dce+cse` |
| runs | 4,000 |
| agree | 4,000 |
| completed without fault | 1,694 |
| divergent | 0 |
| rejected by the checker | 0 |
| compiler crashes on mutations | 0 |
| duration | 18.28 s |
| Node | v24.14.0 |

Outcome distribution among the 4,000 agreeing runs:

| Outcome | Runs | Share of runs |
|---|---|---|
| no fault | 1,694 | 42.4% |
| `R001` non-finite number | 866 | 21.7% |
| `R002` bad index | 798 | 20.0% |
| `R003` assertion failed | 434 | 10.9% |
| `R010` negative size | 110 | 2.8% |
| `R008` bad range | 98 | 2.5% |

Honest reading: 2,306 of the 4,000 fuzz runs (about 58%) still end in a fault, most often `R001` and `R002`. Agreement on those runs is
strong evidence that faults are preserved exactly (same code, same offset, same frame) under optimization. Because
a faulting run stops early, its scene output is usually short, so happy-path drawing behaviour gets less coverage
than the run count suggests; the 1,694 fault-free runs are the direct evidence for it. `R004`, `R005`, `R006`,
`R007`, `R009` and `R011` were not observed in the campaign. The `evidence/fuzz-failures/` directory is empty.

Blind spots. The campaign did not find the three correctness issues the documentation review found: the `-0`
constant conflation (section 2.1), a non-recursive call chain deep enough to hit the VM's call-depth limit (now
rejected statically as `S004`), and fuel exhaustion in long legal loops (still a VM-only limit, now reported as
`oracle.status: "vm-resource-limit"`). The generator does not produce a `-0` constant next to a `0` constant
feeding a sign-sensitive built-in, never builds deep call chains, and its loops are too short to exhaust fuel.
Each of these now has a targeted test in `tests/regressions.test.ts`.

### 3.5 The fault lab: a deliberately wrong pass

`BAD_cse_commute_all` is CSE with a deliberate bug: it also treats `sub`, `div`, `mod`, `lt`, `le`, `gt` and `ge`
as commutative, so it "reuses" `a - b` for `b - a`. It is not in `SAFE_PASSES`; it runs only when named
explicitly (the server accepts it in a pass list and lists it under `faultLabPasses`).

The fixture `examples/fault-lab-commute.folio` draws two circles per iteration at `240 + (a - b) * 0.5` and
`240 + (b - a) * 0.5`. Under every safe configuration the VM and the reference interpreter agree. Under
`constfold, dce, BAD_cse_commute_all` the pass report shows the bad reuse (`#26 sub reuses %14`), the second
circle lands on the first one's position, and the scene hash differs from the reference interpreter's. The
oracle catches the miscompile without knowing anything about the pass.

### 3.6 Test-case reduction

`reduce(source, stillFails)` (`core/reduce.ts`) is greedy delta debugging over the AST. Each round it parses and
checks the current program, enumerates candidate edits in a fixed order, and keeps the first candidate that still
parses, still type-checks and still satisfies the predicate; it stops when no candidate does or after 3,000
attempts. Candidates: delete a statement; replace an `if` by its `then` statements; replace a `group` by its body;
shrink a loop's end bound to 1; replace an expression by a literal of its type (`1`, `true`, `""`, `#000000`);
replace a binary expression by its left or right operand. Candidates are printed back to source with the
formatter, so the result is a normal FOLIO program (comments are not preserved).

On the fault-lab program with the predicate "VM and reference diverge under `BAD_cse_commute_all`", reduction
took 9 accepted steps and 87 attempts and shrank 629 characters to 245:

```
scene "Fault Lab: Commuted Subtraction" size 800 x 480 background #101013 {
  repeat i in 0..1 {
    let a = 1;
    let b = 200;
    circle(x: 1, y: a - b, radius: 10, fill: #8db7a2);
    circle(x: 1, y: b - a, radius: 10, fill: #b2534f);
  }
}
```

`tests/optimizer.test.ts` asserts that the reduced program still diverges, is less than half the original
length, and took at least one step. Because the procedure is deterministic, the same input always reduces to the
same output.

## 4. Performance

Source: `evidence/benchmarks.json`, produced by `npm run bench` (`scripts/bench.ts`).

Method: for each example, compile with no passes ("off") and with `constfold, dce, cse` ("on"); run `runVM` over
all frames; 10 warm-up iterations discarded, then 41 timed iterations per configuration. The two configurations
are interleaved (off, on, on, off, ...) inside one process so that JIT warm-up and machine drift affect both. VM
instruction counts are deterministic; wall times are not.

Environment, as recorded: Node v24.14.0, darwin 27.0.0, Apple M5 Pro, 18 cores, 48 GiB, commit
`9f5ffd9c17393b3b60f8e689c4469612c9a0725c` (includes CSE copy propagation; the run was made from the working tree
with the uncommitted review fixes), 2026-11-12T16:45:04.400Z. Recorded
note: "Wall time of runVM over all frames; off/on runs interleaved; single process; machine not idle-controlled
(other apps running)."

| Example | VM instructions off → on | Reduction | Bytecode instrs off → on | Median ms off → on | Median speedup | SD ms off / on | Same scene |
|---|---|---|---|---|---|---|---|
| 01-rainfall-almanac | 1,571 → 1,407 | 10.4% | 89 → 63 | 0.084 → 0.076 | ×1.105 | 0.148 / 0.026 | yes |
| 02-rainfall-ledger | 2,013 → 1,743 | 13.4% | 222 → 183 | 0.109 → 0.098 | ×1.112 | 0.038 / 0.05 | yes |
| 03-orrery | 33,060 → 26,760 | 19.1% | 153 → 120 | 1.413 → 1.138 | ×1.242 | 0.227 / 0.269 | yes |
| 04-spiral-garden | 57,140 → 48,735 | 14.7% | 159 → 134 | 2.227 → 2.029 | ×1.098 | 0.436 / 1.021 | yes |
| 05-rain-trace | 2,611 → 2,368 | 9.3% | 246 → 217 | 0.144 → 0.129 | ×1.116 | 0.026 / 0.087 | yes |
| 06-lissajous | 1,413,180 → 1,263,540 | 10.6% | 204 → 184 | 51.187 → 48.686 | ×1.051 | 5.826 / 8.489 | yes |
| 07-ink-wheel | 4,471 → 3,802 | 15.0% | 169 → 138 | 0.183 → 0.166 | ×1.102 | 0.188 / 0.03 | yes |
| 08-checker-press | 31,008 → 27,475 | 11.4% | 242 → 206 | 0.743 → 0.665 | ×1.117 | 0.097 / 0.109 | yes |
| 09-station-map | 5,249 → 4,913 | 6.4% | 287 → 257 | 0.164 → 0.153 | ×1.072 | 0.073 / 0.031 | yes |
| 10-type-specimen | 381 → 336 | 11.8% | 96 → 81 | 0.02 → 0.019 | ×1.053 | 0.017 / 0.007 | yes |
| 11-clockwork | 79,440 → 64,200 | 19.2% | 135 → 96 | 3.628 → 3.307 | ×1.097 | 0.666 / 0.962 | yes |
| 12-fibonacci-steps | 9,174 → 8,183 | 10.8% | 175 → 152 | 0.198 → 0.185 | ×1.070 | 0.037 / 0.167 | yes |
| 13-optimizer-bench | 1,765,080 → 1,248,450 | 29.3% | 189 → 109 | 42.258 → 33.31 | ×1.269 | 3.924 / 2.598 | yes |

Plain statement of what this shows:

- The optimizer reduces executed VM instructions by 6.4% to 29.3%. The largest reduction is on
  `13-optimizer-bench`, which was written to contain foldable constants, a dead debug branch and repeated
  subexpressions.
- Wall-time gains are small: median speedups from ×1.05 to ×1.27. For 11 of the 13 examples the difference between
  the medians is smaller than the standard deviation of at least one configuration (for example `06-lissajous`:
  medians 51.187 and 48.686 ms, standard deviations 5.826 and 8.489 ms; `04-spiral-garden`: medians 2.227 and
  2.029 ms, standard deviations 0.436 and 1.021 ms), so those speedups are within noise. Only `03-orrery` and
  `13-optimizer-bench` show a median difference larger than both standard deviations.
- Wall times move between runs of the same code: an earlier run on the same commit 20 minutes before this one
  recorded ×1.008 for `06-lissajous` and ×1.334 for `13-optimizer-bench`. The instruction counts were identical.
- The per-instruction cost of this VM (a `switch` dispatch with fuel checks, fingerprinting and fault handling on
  every instruction) dominates, so removing instructions helps less than the instruction counts suggest.
- An earlier, non-interleaved version of the benchmark (all "off" runs, then all "on" runs) reported a ×6.4
  speedup on a sub-millisecond example. That number was an artefact of JIT warm-up ordering: the configuration
  measured second ran on already-optimized engine code. It is not in `evidence/` and should not be quoted. This is
  why the current script interleaves the configurations.
- No result is extrapolated; numbers come from one machine that was not idle-controlled.
