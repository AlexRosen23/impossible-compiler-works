# Debugger Design

Implementation: `core/debugger.ts` (`DebugSession`), `core/vm.ts` (`VMRun.snapshot`, `restore`, `stateHash`,
`describe`), `core/scene-snap.ts` (scene snapshots). Tests: `tests/backend.test.ts`, `describe('debugger')`.

## 1. Scope

A `DebugSession` debugs one frame of one compiled program: it owns a single `VMRun` for a chosen frame index and
drives it one instruction at a time. It debugs the bytecode that actually runs (optimized or not), and maps the
program counter back to source through the bytecode's `spans` debug table. It does not debug the reference
interpreter.

```ts
new DebugSession(bytecode, data, limits, frameIndex = 0, interval = 256, maxCheckpoints = 256)
```

## 2. Position and inspection

`position()` returns `{ step, fn, pc, line, depth, status }`:

- `step`: instructions executed so far in this frame (the VM's step counter, which is also its fuel counter);
- `fn`, `pc`: the function and instruction about to execute;
- `line`: the source line of that instruction, from `spans[pc]`;
- `depth`: number of active VM frames (1 in the scene body);
- `status`: `ready`, `running`, `halted` or `fault`.

`vm.describe()` returns, for every active frame (innermost first), the function name, pc, line, every slot by
name with its value, every register and the operand stack, rendered as text. `breakableLines()` returns the
sorted source lines that hold at least one instruction in any function; a breakpoint on any other line can never
be hit.

## 3. Stepping semantics

All stepping goes through one loop, `advance(stop, max)`: it executes one instruction at a time, records a
checkpoint when due, and before every instruction except the first checks the `stop` predicate. Stepping ends
early when the frame halts or faults.

| Command | Stops before the first instruction that... | Instruction cap |
|---|---|---|
| `stepInstruction()` | (executes exactly one instruction) | 1 |
| `stepIn()` | is on a different source line, or at a different call depth (entering or leaving a function) | 1,000,000 |
| `stepOver()` | is at a shallower depth, or at the same depth on a different line (calls made from the current line run to completion) | 1,000,000 |
| `stepOut()` | is at a shallower depth than now; in the scene body (depth 1) it behaves like `continue` with no breakpoints | 10,000,000 |
| `continue(lines)` | is on a breakpoint line, entered from a different line | 50,000,000 |

"Line" means the line of the instruction's span. Because the code generator gives a statement's instructions the
spans of their sub-expressions, one source line can map to several non-contiguous instruction ranges (for
example a multi-line `circle(...)` call evaluates arguments on lines 19 to 22 and draws on line 18).

## 4. Breakpoints

Breakpoints are a set of source line numbers passed to `continue`. A breakpoint is hit when execution moves onto
that line from a different line, so a loop body on one line stops once per iteration rather than once per
instruction.

Not implemented: conditional breakpoints, hit counts, column or expression breakpoints, data watchpoints and
breakpoints on function entry. `DebugSession` has no API for any of them.

## 5. Time travel: checkpoints and rewind

The VM is deterministic, so any earlier state can be reconstructed by re-executing from an earlier state.

- **Checkpoints.** The session stores a snapshot at step 0 and then whenever the step count is a multiple of
  `interval` (default 256 instructions). A snapshot (`VMRun.snapshot`) deep-copies every frame's registers,
  slots and operand stack, the step and iteration counters, status, fault, trace fingerprint, and the scene
  (`snapScene`: a copy of the array of command references plus the group-transform stack; commands themselves
  are immutable and shared).
- **Bounded memory.** When the checkpoint list grows past `maxCheckpoints` (default 256), every other checkpoint
  is dropped (the even-indexed ones are kept, including step 0) and `interval` doubles. Memory is therefore
  bounded by `maxCheckpoints` snapshots however long the frame runs, at the cost of longer re-execution after a
  rewind. Tested: a 20,000-iteration loop with `interval` 4 and `maxCheckpoints` 64 ends with at most 64
  checkpoints and still replays correctly.
- **`goto(step)`.** Restores the latest checkpoint at or before `step`, then re-executes forward to `step` (or to
  the end of the frame if it ends first). The same call moves backward or forward in time.

Cost model: a snapshot costs time and memory proportional to the live registers, slots and stack plus the number
of draw commands so far (the command array is copied by reference). A `goto` costs at most one checkpoint
interval of re-execution.

## 6. Replay proof

`proveReplay(step)` returns `{ step, viaCheckpoint, viaFreshReplay, equal }`:

1. `goto(step)` (restore a checkpoint and re-execute) and take `stateHash()`;
2. build a brand-new `VMRun` for the same frame, run it for the same number of steps, and take its `stateHash()`;
3. return to the original position with `goto`.

`stateHash` is SHA-256 over the canonical JSON of the full machine state: every frame's function, pc, registers,
slots and stack (values encoded), all scene commands so far, step and iteration counters, status, trace
fingerprint and fault (code and span). Equal hashes mean the two ways of reaching step `n` produced byte-identical
state.

Tested (`tests/backend.test.ts`): with `interval` 8, `proveReplay` is equal at steps 0, 1, 7, 8, 9, the midpoint,
the last step and the end; after `goto(3)` and `continue`, the final state hash equals the hash from the first
full run; and the frame's draw commands match `runVM` for the same frame.

## 7. Bug found during development: scene snapshot truncation on forward restore

Restoring a checkpoint must restore the scene's command list as it was at that checkpoint. The original approach
restored the scene by truncating the live command array to the checkpoint's length. That is correct only when
moving backward in time. `goto` can restore a checkpoint that is later than the current position (moving
forward: for example `proveReplay` returns to the original position after visiting an earlier step), and then
the live array is shorter than the checkpoint's, so truncation leaves out commands that should exist. The VM
state and the drawn scene then disagree, and the state hashes differ.

The fix, in `core/scene-snap.ts`, is that a snapshot keeps its own copy of the command array and `restoreScene`
replaces the live array with a copy of the snapshot's array (and likewise the group stack), so restore works in
both directions. The module's header comment records the rule: "Restoring must replace the array (not truncate
it): a restore can move forward in time to a later checkpoint." The replay tests above (in particular returning
to a later position after `proveReplay`) exercise forward restores.

## 8. Limits and non-goals

- One frame per session; to debug frame 5, construct the session with `frameIndex = 5`.
- The step caps in section 3 bound each command; the VM's own fuel limit (20,000,000 per frame) also applies.
- Variables are shown as raw slots and registers (with slot names); there is no expression evaluator in the
  debugger.
