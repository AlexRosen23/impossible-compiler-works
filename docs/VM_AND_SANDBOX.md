# Bytecode, Virtual Machine and Sandbox

Version: `folio-bc/0.1` (`BYTECODE_VERSION`). Implementation: `core/bytecode.ts` (opcodes, code generator,
serialization, loader, verifier, disassembler), `core/vm.ts` (the VM), `core/ops.ts` (operator semantics shared
with constant folding), `core/scene.ts` (the output device).

## 1. Bytecode format

A `BCModule` is plain JSON:

| Field | Content |
|---|---|
| `format` | `"folio-bc"` |
| `version` | `"folio-bc/0.1"` |
| `scene` | title, width, height, frames, background |
| `data` | dataset names and types (indexed by `GLOBAL`) |
| `consts` | constant pool, JSON-encoded values: a JSON scalar, `{neg0: true}`, `{color}`, `{point}` or `{list}` (section 7) |
| `functions` | one `BCFunction` per IR function |
| `main` | index of the scene function |

A `BCFunction` has `name`, `nparams`, `nregs`, `nslots`, `slotNames`, `code`, and two debug tables:

- `code` is a flat array of `[opcode, a, b]` triples; the program counter counts triples.
- `spans[pc]` is `[start, end, line, col]` of the source construct that produced the instruction.
- `ir[pc]` is the IR instruction id (`-1` for terminator glue).

Each VM frame has registers (`nregs`), slots (`nslots`) and an operand stack. Registers hold IR register values;
slots hold `var`s, loop state, parameters and, in the scene function, `time` (slot 0) and `frame` (slot 1).

### 1.1 Code generation

For each IR instruction the generator pushes the operands (`LOADR` for a register, `CONST` for a constant),
emits the operation, then `STORER` into the destination register if there is one. Terminators: `jmp` to the
next block in layout order is omitted; `br c, T, F` becomes push `c`, `JMPF F`, then `JMP T` unless `T` is the
next block; `ret v` becomes push `v`, `RET`; `halt` becomes `HALT`. The operand stack is therefore empty between
IR instructions, and its maximum depth is the largest operand count of a single instruction. There is no stack
scheduling: every intermediate result goes through a register (visible as `STORER %n` / `LOADR %n` pairs in the
disassembly below).

### 1.2 Opcodes and stack effects

`stackEffect(op, a)` in `core/bytecode.ts` is the single source for both the verifier and the disassembler.

| Opcode | Operands | Pops | Pushes | Effect |
|---|---|---|---|---|
| `CONST` | a = constant index | 0 | 1 | push `consts[a]` |
| `LOADR` | a = register | 0 | 1 | push register |
| `STORER` | a = register | 1 | 0 | pop into register |
| `LOADS` | a = slot | 0 | 1 | push slot |
| `STORES` | a = slot | 1 | 0 | pop into slot |
| `GLOBAL` | a = dataset index | 0 | 1 | push dataset |
| `ADD` `SUB` `MUL` `DIV` `MOD` | | 2 | 1 | arithmetic; `R001` if not finite |
| `CONCAT` | | 2 | 1 | string concatenation; `R009` if too long |
| `LT` `LE` `GT` `GE` `EQ` `NE` | | 2 | 1 | comparison / structural equality |
| `INDEX` | | 2 | 1 | list index; `R002` |
| `NEG` `NOT` | | 1 | 1 | |
| `FIELD` | a = field index (`x y r g b a`) | 1 | 1 | |
| `LEN` | | 1 | 1 | list length |
| `CALLB` | a = built-in index, b = argc | b | 1 | call a vetted built-in |
| `CALLF` | a = function index, b = argc | b | 1 (on return) | push a new VM frame; arguments go to slots `0 .. b-1` |
| `LIST` | a = item count | a | 1 | build an immutable list |
| `DRAW` | a = primitive index | parameter count of the primitive | 0 | append a draw command |
| `GPUSH` | | 4 | 0 | push a group transform |
| `GPOP` | | 0 | 0 | pop a group transform |
| `ASSERT` | a = message constant or -1 | 1 | 0 | `R003` if false |
| `TICK` | | 0 | 0 | count one loop iteration; `R004` |
| `RANGECHK` | | 2 | 0 | `R008` if a bound is not a whole number |
| `JMP` | a = target pc | 0 | 0 | |
| `JMPF` | a = target pc | 1 | 0 | jump if the popped value is false |
| `RET` | | 1 | 0 | return the popped value to the caller's stack |
| `HALT` | | 0 | 0 | end of the scene frame |

Disassembly excerpt (real output of `node scripts/folio.ts examples/04-spiral-garden.folio --opt --bc`),
function `golden`, which computes `i * 137.508 * PI / 180`:

```
golden:
     0  LOADS $0 (i)                         -0 +1  line 3
     1  STORER %0                            -1 +0  line 3
     2  LOADR %0                             -0 +1  line 3
     3  CONST 137.508                        -0 +1  line 3
     4  MUL                                  -2 +1  line 3
     5  STORER %1                            -1 +0  line 3
     6  LOADR %1                             -0 +1  line 3
     7  CONST 3.141592653589793              -0 +1  line 3
     8  MUL                                  -2 +1  line 3
     9  STORER %2                            -1 +0  line 3
    10  LOADR %2                             -0 +1  line 3
    11  CONST 180                            -0 +1  line 3
    12  DIV                                  -2 +1  line 3
    13  STORER %3                            -1 +0  line 3
    14  LOADR %3                             -0 +1  line 3
    15  RET                                  -1 +0  line 3
```

and the loop back-edge of the scene:

```
    68  DRAW circle                          -6 +0  line 18
    69  LOADR %4                             -0 +1  line 15
    70  CONST 1                              -0 +1  line 15
    71  ADD                                  -2 +1  line 15
    72  STORER %25                           -1 +0  line 15
    73  LOADR %25                            -0 +1  line 15
    74  STORES $2 (i)                        -1 +0  line 15
    75  JMP → 4                              -0 +0  line 15
    76  HALT                                 -0 +0  line 13
```

## 2. Serialization and content hash

`serialize(m)` returns the module plus `hash = SHA-256(canonicalJson(module without hash))`. Canonical JSON sorts
object keys, writes no whitespace and writes `-0` as `0`; it refuses non-finite numbers.

`loadBytecode(json, limits)` treats its input as untrusted and checks, in order:

1. it is an object with `format: "folio-bc"`;
2. `version` equals the VM's `BYTECODE_VERSION`;
3. the hash recomputed over the content equals the stored `hash` (a mismatch means the bytecode was modified
   after it was produced);
4. `verifyBytecode` finds no structural problem.

Only then is the module returned. The hash detects accidental or naive edits; it is not a signature (anyone can
recompute it after editing), which is why structural verification follows and why `tests/backend.test.ts`
re-signs a broken module and confirms the verifier still rejects it.

## 3. Bytecode verifier (`verifyBytecode`)

The verifier returns a list of problems for any input, however malformed, and never throws: its body runs inside a
guard that turns an unexpected exception into a "malformed module" problem.

Module checks: `functions`, `consts` and `data` are arrays; there are 1 to `maxSymbols` functions and bounded
constant and data tables; the scene header has a title of at most 1,000 characters, a size of 1 to 4,096 in each
direction, 1 to 240 frames and a `#RRGGBB[AA]` background; `main` is a valid index; every constant decodes.

Per function:

- the record is an object with a short name, and `code`, `spans`, `ir` and `slotNames` are arrays;
- `code` length is a multiple of 3; `spans` and `ir` have one entry per instruction; each span is four whole
  numbers; `slotNames` has one entry per slot;
- `nparams` is 0 to 64, `nslots` from `nparams` to `maxSymbols + 2`, `nregs` 0 to `maxBytecodeInstrs`; the scene
  function has at least 2 slots (`time`, `frame`);
- an abstract interpretation over the control-flow graph, starting at pc 0 with stack depth 0, visits every
  reachable instruction and checks:
  - control never runs past the end of the code;
  - every instruction is reached with one consistent stack depth;
  - the opcode exists, and both operands are whole numbers (a fractional or string operand is rejected before it can
    index a table);
  - operands are in range: constant index, register, slot, dataset index, built-in index with the exact
    argument count, function index (not the scene) with the exact argument count, `LIST` size at most
    `maxListLiteral`, field index, primitive index, `ASSERT` message is -1 or a string constant, jump targets are
    integers inside the function;
  - no stack underflow, and depth never exceeds `maxStack` (1,024);
  - `RET` only outside the scene function and with exactly one value on the stack;
  - `HALT` with an empty stack.

Whole-module checks: total instruction count at most `maxBytecodeInstrs` (200,000), and the `CALLF` call graph
is acyclic (checked by an iterative depth-first search, so a chain of thousands of functions cannot overflow the
host stack).

The verifier is structural, not a type checker. It does not check that a register is written before it is read
(registers start as `0`), or that operand values have the types an opcode expects (the VM itself checks `LEN`'s
operand, `R012`). Those properties hold for
compiler output because the checker and lowering guarantee them. Bytecode from outside is never executed by the
code in `core/` and `server/`: `reproduce` and `/api/import` only load and verify a supplied bytecode artifact and
compare its hash; they execute bytecode recompiled from the receipt's source. The pre-release red team's crafted
modules (fractional operands, a null function, huge slot and register counts, a billion frames, a CSS background,
a 2,000-function chain) are rejected without an exception in `tests/security.test.ts`.

Negative tests in `tests/backend.test.ts`: unknown opcode, out-of-range jump, out-of-range constant, an `ADD`
replacing a `CONST` (stack discipline), a truncated function (control runs past the end), an injected recursive
`CALLF`, a tampered constant (hash mismatch), a wrong version, a non-bytecode object, and a re-signed broken
module.

## 4. VM design (`core/vm.ts`)

- **One `VMRun` per frame.** `runVM` creates a fresh machine for each frame index, so no program state carries
  between frames. Only two counters are shared across the frames of one run: instructions (`fuelPerRun`) and scene
  size (`maxSceneUnits`), so the whole run is bounded, not just each frame. The scene frame's registers and slots start at `0`, then slot 0 is set to `time = frame / frames` and
  slot 1 to `frame`.
- **Explicit frame stack.** `CALLF` pushes a `CallFrame { fn, pc, regs, slots, stack }`; `RET` pops it and pushes
  the result onto the caller's stack. The VM never recurses on the host stack.
- **Dispatch loop.** `run(max, stop?)` executes up to `max` instructions. Before each instruction it checks the
  optional `stop` predicate (used by the debugger), increments the step count and faults `R006` if it exceeds
  `fuelPerFrame` or the run total exceeds `fuelPerRun`, updates a rolling FNV-1a fingerprint over `(fn, pc)`, then executes the opcode.
- **Fault handling.** Built-ins, operators and the scene builder signal faults by throwing `FaultSignal`; the VM
  catches it, sets the pc back to the faulting instruction, and records a `FolioFault` with the instruction's
  source span. Any other exception is not caught (it would be a VM bug).
- **Limits.** `TICK` counts iterations (`R004`); `CALLF` counts user-function calls (`R013` past 100,000 per frame,
  exactly as the reference interpreter counts them), charges the callee's register and slot cells against fuel
  (`R006`, so a huge register file cannot be allocated cheaply), and checks call depth (`R007` when 64 frames are
  already active); the operand stack is checked after every instruction (`R007` above 1,024), and fuel is checked before
  every instruction (`R006`). For checked, verified programs the two `R007` checks are second lines of defence:
  the checker's `S004` rule bounds call depth and the bytecode verifier bounds stack depth. Fuel is the only VM
  limit a checked program can reach that the reference interpreter does not share.
- **Result.** `runVM` returns the scene, the first fault (code, message, span, frame), per-frame step counts and
  a `traceHash`: SHA-256 over the per-frame step counts, per-frame fingerprints and the fault code and frame. Two
  runs with the same trace hash executed the same instruction sequence.
- **Debugger support.** `snapshot()`/`restore()` copy the full machine state; `stateHash()` hashes it canonically
  (frames, registers, slots, stacks, scene commands, counters, status, fingerprint, fault). See
  `DEBUGGER_DESIGN.md`.

The same `VMRun` class serves batch runs and the step debugger.

## 5. Host access: what a FOLIO program can reach

The VM's imports are the bytecode tables, `ops.ts`, the primitive table, `SceneBuilder`, scene snapshots, SHA-256
and the value helpers. A running program can reach exactly:

1. the vetted pure built-ins in `core/builtins.ts` (through `evalPure('callb', ...)`), which use only `Math`
   functions and string formatting;
2. the scene builder, which appends validated, quantized draw commands to an in-memory array;
3. the read-only datasets the host bound before the run.

There is no file system, network, clock, random source, `eval`, `Function` constructor, dynamic import or
host-object access in `core/` (a search of `core/`, `server/` and `scripts/` for `eval(`, `new Function`,
`child_process`, `fetch(`, `require(` and `import(` finds none). Fixture names are identifiers resolved against
a table the host passes in, never paths.

## 6. What the VM and the reference interpreter share

The reference interpreter (`core/interpreter.ts`) is a tree-walking evaluator of the checked AST. Its value as an
oracle depends on how much it shares with the compiled path. Exactly:

| Component | VM path | Reference interpreter | Shared? |
|---|---|---|---|
| Lexer, parser, checker | yes | yes (it runs the checked AST) | shared front end |
| Lowering, IR, optimizer, code generator, bytecode verifier | yes | no | independent |
| Operator semantics (`+ - * / %`, comparisons, `not`, index, field, concat) | `core/ops.ts` (also used by constant folding) | implemented separately in `interpreter.ts` | independent |
| Short-circuit, loops, range check, iteration counting, calls, returns | bytecode + VM | `interpreter.ts` | independent |
| Value representation, `finite`, `valueEquals`, `color()` | `core/values.ts` | `core/values.ts` | shared |
| Built-in function implementations and their result checks | `core/builtins.ts` | `core/builtins.ts` | shared |
| Primitive signatures and defaults | `core/primitives.ts` | `core/primitives.ts` | shared |
| Output device: draw limit, negative sizes, group depth, quantization | `core/scene.ts` | `core/scene.ts` | shared |
| Fuel (`R006`) | VM only (instructions and call-frame cells, per frame and per run) | its own evaluation budget (`R014`) | each executor's machine limit; receipts report `vm-resource-limit` or `reference-resource-limit` |
| Call limit (`R013`) | VM counts `CALLF` | interpreter counts user calls | semantic, identical in both: they stop at the same call |
| Scene size (`R005`) | shared scene builder, per frame and per run | shared | semantic, identical in both |
| Host stack | not used (explicit frame stack) | checker rule `S005` bounds its depth | a checked program never overflows the interpreter |
| Call depth | checker rule `S004` plus the VM's `R007` check | accepts only programs that passed `S004` | the static rule makes both accept the same programs |

Consequences, stated plainly:

- Differential testing checks the lowering, the optimizer, the code generator and the VM against an independent
  evaluator. It cannot detect a bug in the shared front end, in a built-in, in the primitive table or in the scene
  builder, because both sides would inherit it. Those modules are therefore tested directly:
  `tests/regressions.test.ts` checks colour clamping and rounding, `hsl`, `mix` and `alpha` on known values,
  `noise` determinism and range, `fmt` digit clamping, non-finite results faulting, and the scene builder's
  transform composition, opacity multiplication and limits; `validateScene` has its own tests. There is no
  separate unit test of the primitive table beyond its use by every example.
- Constant folding uses the VM's own operator semantics (`ops.ts`), which makes folded results identical to run
  time results by construction; the interpreter is what checks that both are right.
- Where the VM's fuel runs out (`R006`), the VM stops and the reference interpreter may finish; where the
  interpreter's runs out (`R014`), the reverse. This is by design, and a receipt records it as
  `oracle.status: "vm-resource-limit"` or `"reference-resource-limit"`, not as a divergence. See
  `FOLIO_LANGUAGE_SPEC.md` section 12 and `COMPILER_PIPELINE.md` section 5.

## 7. Constant encoding and `-0`

FOLIO keeps `-0` observable: `atan2(0, -0)` is π while `atan2(0, 0)` is 0, and `1 / -0` faults with
`-Infinity` rather than `Infinity`. JSON, and the canonical JSON used for hashing, write `-0` as `0`. Constants
are therefore encoded explicitly (`encodeValue` in `core/values.ts`): the number `-0` becomes `{ "neg0": true }`
and decodes back to `-0`. Because the code generator interns constants by the canonical JSON of their encoding,
and the CSE pass keys constant operands the same way, `0` and `-0` are distinct constants in the pool, in CSE and
in serialized bytecode, and both survive a JSON round trip.

This was a real miscompile before the explicit encoding existed, found during the documentation review: with
`constfold`, a `-0` constant and a `0` constant in the same function shared one pool entry, and this program

```
scene "s" { let x = -0 * frame; let a = atan2(0, x + 0); let b = atan2(0, x + -0);
            text(x: 10, y: 10, value: str(a) + " " + str(b)); }
```

drew `-3.141592653589793 -3.141592653589793` in the optimized VM but `0 3.141592653589793` in the reference
interpreter. It now draws `0 3.141592653589793` in both, with and without optimization (re-checked on
2026-11-12), and `tests/regressions.test.ts` ("-0 survives constant folding, the constant pool and CSE keys")
guards it.
