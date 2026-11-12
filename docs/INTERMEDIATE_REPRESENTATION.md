# Intermediate Representation

Version: `folio-ir/0.1` (`IR_VERSION`). Implementation: `core/ir.ts` (data types, printer, encoding),
`core/lower.ts` (AST to IR), `core/irverify.ts` (verifier, dominators, reachability, call-graph check).

## 1. Design

The IR is a typed, register-based three-address code organised in basic blocks.

- **Registers are single-assignment.** Each register has exactly one defining instruction, and that definition
  dominates every use. The verifier checks both properties after lowering and after every optimization pass.
- **No phi nodes. Merging values live in slots.** A value that can come from more than one control-flow path
  (a `var` binding, a loop counter, the result of `and`/`or`) is kept in a numbered frame slot and accessed with
  `load` and `store`. Slots are mutable; registers are not.
- **Every instruction carries a stable id and the source span it came from.** Ids are unique across the whole
  module; spans flow into the bytecode debug tables, so the debugger and fault reports map back to source.

Why slots instead of phis: FOLIO's mutable state is small and explicit (only `var` bindings, loop cursors and
short-circuit temporaries), and the lowering is deliberately naive so the optimizer's effect is visible. With
slots, lowering needs no SSA construction (no dominance frontiers, no renaming), the stack-machine code
generator maps slots directly onto VM frame slots, and the passes that exist (constant folding, local CSE,
dead-store and dead-code removal) do not need to reason about phi semantics. The cost is that the optimizer
cannot see through slots: a value stored in one block and loaded in another is opaque to constant propagation
and to CSE. Registers still give the useful SSA property for everything that does not merge: a register's value
never changes, so substituting one register for another is always safe once dominance holds.

## 2. Module structure

| Type | Fields |
|---|---|
| `IRModule` | `version`, `scene` (title, width, height, frames, background), `data` (dataset names and types, indexed by `global`), `functions`, `main` (index of the scene function), `nextInstrId` |
| `IRFunction` | `name`, `nparams`, `slots`, `nregs`, `blocks` (first block is the entry), `ret` (result type, `null` for the scene), `regTypes` |
| `Slot` | `name`, `type`, `kind`: `param`, `var`, `loop`, `hidden` or `input` |
| `BasicBlock` | `id`, `label`, `instrs`, `term` (exactly one terminator) |
| `Instr` | `id`, `op`, `dst` (register or `null`), `args` (operands), `meta`, `span`, `type` |
| `Operand` | `%n` (register) or a constant value |

User functions come first in declaration order; the scene function is last and is `main`. In a user function the
first `nparams` slots are the parameters. In the scene function slot 0 is `time` and slot 1 is `frame` (kind
`input`); the VM writes them before execution. `WIDTH`, `HEIGHT`, `PI` and `TAU` are lowered to constants.
Hidden slots are named after their purpose: `i.end` (range end), `x.list` and `x.index` (list iteration),
`and#13` / `or#13` (short-circuit result of AST node 13).

## 3. Operations

| Op | Operands | Result | Meta | Pure | Can fault | Notes |
|---|---|---|---|---|---|---|
| `mov` | 1 | yes | `binding` | yes | no | a `let` binding |
| `add` `sub` `mul` `div` `mod` | 2 | Number | | yes | `R001` | |
| `neg` | 1 | Number | | yes | no | |
| `concat` | 2 | String | | yes | `R009` | `+` on Strings |
| `lt` `le` `gt` `ge` | 2 | Boolean | | yes | no | |
| `eq` `ne` | 2 | Boolean | | yes | no | structural equality (`valueEquals`) |
| `not` | 1 | Boolean | | yes | no | |
| `callb` | n | yes | `name` | yes | yes, unless the built-in is in `NONFAULTING_BUILTINS` | built-in call |
| `callf` | n | yes | `name` | no | treated as yes | user-function call; never folded, removed or reused |
| `list` | n | List | | yes | no | list literal |
| `index` | 2 | element | | yes | `R002` | |
| `field` | 1 | Number | `field` | yes | no | |
| `len` | 1 | Number | | yes | no | used by list-loop lowering (a source-level `len(xs)` is `callb len`) |
| `global` | 0 | List | `global`, `name` | yes | no | read a dataset |
| `load` | 0 | yes | `slot` | no | no | |
| `store` | 1 | none | `slot` | no | no | |
| `draw` | one per primitive parameter | none | `kind` | no | `R005`, `R010` | arguments in the primitive's declared order, defaults filled in |
| `gpush` | 4 | none | | no | `R011` | translate, rotate, scale, opacity |
| `gpop` | 0 | none | | no | no | |
| `assert` | 1 | none | `message` | no | `R003` | |
| `tick` | 0 | none | | no | `R004` | one loop iteration |
| `rangechk` | 2 | none | | no | `R008` | both range bounds are whole numbers |

`PURE_OPS`, `FAULTING_OPS`, `NONFAULTING_BUILTINS` and `COMMUTATIVE` in `core/ir.ts` are the tables the
optimizer consults. `NONFAULTING_BUILTINS` is `sin cos abs floor ceil round sign min max clamp point rgb rgba hsl
mix alpha str fmt`: built-ins that cannot fault on finite input. The others (`tan sqrt exp log pow atan2 noise
lerp dist len`) are conservatively treated as able to fault.

### Terminators

| Terminator | Meaning |
|---|---|
| `jmp B` | unconditional jump |
| `br c, T, F` | jump to `T` if `c` is true, else `F` |
| `ret v` | return `v` from a user function (not allowed in the scene function) |
| `halt` | end of the scene body; also the (unreachable) end of a user function body |

## 4. Lowering rules (`core/lower.ts`)

The lowering is deliberately naive so that the optimizer's work is visible and measurable. It preserves
evaluation order exactly: left to right, named arguments in the order written, defaults appended afterwards.

| Source | IR |
|---|---|
| `let x = e;` | `%r = mov e` (binding `x` maps to `%r`) |
| `var x = e;` | `store $x, e` (binding `x` maps to slot `$x`) |
| `x = e;` | `store $x, e` |
| reading a `var`, parameter or loop variable | `load $slot` at every read |
| reading a dataset | `global` |
| `if c { A } else { B }` | `br c, then, else`; each branch ends with `jmp endif` |
| `repeat i in a..b { }` | `rangechk a, b`; store `a` into `$i` and `b` into `$i.end`; head block `load`, `load`, `lt`, `br`; body starts with `tick`; latch block `load $i`, `add 1`, `store $i` |
| `repeat x in xs { }` | store `xs` into `$x.list` and `0` into `$x.index`; head compares the index with `len`; body `tick`, `index`, `store $x`; latch increments `$x.index` |
| `a and b` / `a or b` | store `a` into a hidden Boolean slot, `br` to a block that evaluates `b` and stores it, join block `load`s the slot |
| `return e;` | `ret e` |
| drawing call / `group` | `draw kind(...)` / `gpush ...`, body, `gpop` |

Code emitted after a block has already been terminated (for example statements after a `return`) goes into a
fresh unreachable `dead` block; DCE removes it.

## 5. Verifier invariants (`core/irverify.ts`)

`verifyIR` runs in the `lower` stage and after every optimization pass. Any violation is a compiler bug and
fails compilation (`ICE`).

Module level:

- `main` is a valid function index.

Per function:

1. The function has at least one block; block ids are unique.
2. Every jump or branch target names an existing block.
3. Every register is defined at most once, and every defined register is in `0 .. nregs-1`.
4. `store draw gpush gpop assert tick rangechk` define no register; every other op defines one.
5. Fixed-arity ops have the right operand count (`mov` 1, binary ops 2, `neg`/`not` 1, `index` 2, `field` 1,
   `len` 1, `global` 0, `load` 0, `store` 1, `gpush` 4, `gpop` 0, `assert` 1, `tick` 0, `rangechk` 2).
6. `load` and `store` name an existing slot.
7. `callb` names a built-in and passes its exact parameter count; `callf` names a user function (not the scene)
   and passes its exact parameter count; `draw` names a primitive and passes one operand per parameter;
   `global` names an existing dataset.
8. `ret` does not appear in the scene function.
9. Dominance, over reachable blocks only: every register operand (including terminator operands) is defined,
   and its definition either comes earlier in the same block or lies in a block that dominates the use.
   Dominators are computed with the classic iterative set-intersection algorithm.

In addition the `lower` stage checks that the IR call graph is acyclic (`irCallGraphAcyclic`).

What the verifier does not check: operand types against `regTypes` or slot types, and the arity of `list`. Type
safety rests on the checker plus the lowering; the differential tests are the end-to-end check.

Negative tests (`tests/backend.test.ts`, "IR verifier") inject a use whose definition does not dominate it and a
duplicate definition and confirm both are rejected.

## 6. Annotated listing

Real output of `node scripts/folio.ts examples/04-spiral-garden.folio --ir` (no optimization), for:

```
fn petalRadius(i: Number, count: Number) -> Number {
  if i < count / 3 {
    return 2 + i * 0.04;
  }
  return 3 + sqrt(i) * 0.35;
}
```

```
fn petalRadius(i: Number, count: Number) -> Number  ; 11 regs, 2 slots
  entry0:
    %0 = load $0:i                              ; #5 @7:6
    %1 = load $1:count                          ; #6 @7:10
    %2 = div %1, 3                              ; #7 @7:10
    %3 = lt %0, %2                              ; #8 @7:6
    br %3, then1, endif2
  then1:
    %4 = load $0:i                              ; #9 @8:16
    %5 = mul %4, 0.04                           ; #10 @8:16
    %6 = add 2, %5                              ; #11 @8:12
    ret %6
  endif2:
    %7 = load $0:i                              ; #12 @10:19
    %8 = callb sqrt(%7)                         ; #13 @10:14
    %9 = mul %8, 0.35                           ; #14 @10:14
    %10 = add 3, %9                             ; #15 @10:10
    ret %10
```

Reading it: `$0:i` and `$1:count` are the parameter slots. Every read of `i` is a fresh `load` (naive lowering).
`#5` is the instruction id and `@7:6` the source line and column. The `if` without `else` becomes a `br` whose
false edge goes to `endif2`. The lowering always tries to close a function with `halt`, but a block that already
ends in `ret` keeps its terminator, so no `halt` appears here.

The scene's loop, unoptimized (`repeat i in 0..n` with `let n = 420;`), excerpt:

```
fn scene()  ; 26 regs, 4 slots
  entry0:
    %0 = mov 420    ; let n                     ; #16 @14:3
    rangechk 0, %0                              ; #17 @15:3
    store $2:i, 0                               ; #18 @15:3
    store $3:i.end, %0                          ; #19 @15:3
    jmp loop1
  loop1:
    %1 = load $2:i                              ; #20 @15:3
    %2 = load $3:i.end                          ; #21 @15:3
    %3 = lt %1, %2                              ; #22 @15:3
    br %3, body2, endloop4
  body2:
    tick                                        ; #23 @15:3
    %4 = load $2:i                              ; #24 @16:20
    %5 = callf golden(%4)                       ; #25 @16:13
    %6 = mov %5    ; let a                      ; #26 @16:5
    %7 = load $2:i                              ; #27 @17:18
    %8 = callb sqrt(%7)                         ; #28 @17:13
    ...
    %11 = div 800, 2                            ; #31 @19:10
    ...
    jmp next3
  next3:
    %24 = load $2:i                             ; #45 @15:3
    %25 = add %24, 1                            ; #46 @15:3
    store $2:i, %25                             ; #47 @15:3
    jmp loop1
  endloop4:
    halt
```

Slots 0 and 1 (`time`, `frame`) are not shown because this scene never reads them. `WIDTH / 2` has become
`div 800, 2` (constants, not yet folded).

The same function after `--opt` (`constfold`, `dce`, `cse`):

```
fn scene()  ; 26 regs, 4 slots
  entry0:
    store $2:i, 0                               ; #18 @15:3
    store $3:i.end, 420                         ; #19 @15:3
    jmp loop1
  loop1:
    %1 = load $2:i                              ; #20 @15:3
    %2 = load $3:i.end                          ; #21 @15:3
    %3 = lt %1, %2                              ; #22 @15:3
    br %3, body2, endloop4
  body2:
    tick                                        ; #23 @15:3
    %4 = load $2:i                              ; #24 @16:20
    %5 = callf golden(%4)                       ; #25 @16:13
    %6 = mov %5    ; let a                      ; #26 @16:5
    %8 = callb sqrt(%4)                         ; #28 @17:13
    %9 = mul %8, 10.5                           ; #29 @17:13
    %10 = mov %9    ; let d                     ; #30 @17:5
    %12 = callb cos(%6)                         ; #32 @19:22
    %13 = mul %12, %10                          ; #33 @19:22
    %14 = add 400, %13                          ; #34 @19:10
    %16 = callb sin(%6)                         ; #36 @20:23
    %17 = mul %16, %10                          ; #37 @20:23
    %18 = add 240, %17                          ; #38 @20:10
    %20 = callf petalRadius(%4, 420)            ; #40 @21:15
    %22 = div %4, 420                           ; #42 @22:35
    %23 = callb mix(#b2534fff, #bb9c67ff, %22)  ; #43 @22:13
    draw circle(%14, %18, %20, %23, none, 1)    ; #44 @18:5
    %25 = add %4, 1                             ; #46 @15:3
    store $2:i, %25                             ; #47 @15:3
    jmp loop1
  endloop4:
    halt
```

What changed and why:

- `constfold` folded `mov 420` and propagated `420` into its uses, folded `div 800, 2` to `400` and
  `div 480, 2` to `240`, and removed `rangechk 0, 420` because both bounds are constant whole numbers.
- `dce` merged `next3` into `body2` (its only predecessor jumps straight to it).
- `cse` replaced the repeated `load $2:i` in the merged block (#27, #39, #41, #45) with `%4`, because no `store`
  to `$2` happens in between.
- Not done: `%6 = mov %5` stays, because there is no copy propagation of registers. Instruction count went
  56 → 52 → 51 → 47 (the pass reports, which count instructions plus one per block terminator).

The draw shows how defaults are materialised: `circle` takes six operands in declared order, and the unspecified
`stroke` and `strokeWidth` become the constants `none` and `1`.

Block order in a listing is creation order, not control-flow order. In code with `and`/`or` the short-circuit
blocks are created after the loop's latch and exit blocks, so they print after them.
