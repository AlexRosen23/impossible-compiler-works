# Case study: the Compiler wing (formerly PAPER TIGER COMPILER WORKS)

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Compiler wing (formerly PAPER TIGER COMPILER WORKS). Ports and commands for the combined app are in the [root README](../../../README.md); older mentions of ports 5580/5581/5590 describe the standalone app.

*Draft for the portfolio. Not published anywhere; publishing needs the owner's approval.*

## The problem
Compilers are usually invisible. A program goes in and an answer comes out, and when the two disagree there
is nothing to look at. I wanted a language implementation small enough to understand completely, but built
the way production compilers are, with a stable IR, a verifier, real optimizations, a bytecode format and a
sandboxed VM. Then I wanted to make every stage inspectable, and every claim about it checkable.

## What I built
- **FOLIO**, a typed DSL for data-driven diagrams and animations: lexical scoping, `let`/`var`, functions with
  typed signatures, bounded loops, lists, colours and points, read-only datasets, assertions, and a time
  input sampled per frame. Programs always terminate: recursion is rejected statically and loops are bounded.
- **A full pipeline in TypeScript:** recursive-descent parser with recovery, checker, register IR with a
  dominance-checking verifier, three optimization passes, stack bytecode with a structural verifier and
  content hash, and a VM with fuel and stack limits.
- **An independent oracle:** a tree-walking interpreter that shares no evaluation code with the compiler. Every
  example, every fuzzed program and every receipt is checked against it.
- **A browser workshop** with eight inspectors, a step debugger with time travel, and a proof cabinet backed
  by a loopback API and SQLite.

## Decisions and trade-offs
- **One TypeScript codebase.** The same `core/` runs in the IDE, the server and the CLI, so the browser and
  the server provably compile the same bytes. A Rust/WASM core would be faster but would split the toolchain
  for no measured need.
- **Registers plus slots instead of phi nodes.** Registers are single-assignment and the verifier checks
  dominance. Mutable state lives in slots. This keeps optimization legality easy to argue about, at the cost
  of some loads and stores.
- **Strict evaluation and faulting arithmetic.** Any non-finite result is a fault. That makes the optimizer's
  rules precise: constant folding never folds an operation that would fault, and DCE never deletes one.
- **Honest measurement.** Interleaved benchmark runs and medians. The write-up reports where optimization
  barely matters.

## Evidence
126 unit, differential, regression and security tests; 10 browser E2E tests; a pre-release red team whose
every finding became a test; 4,000/4,000 agreeing fuzz runs; a deliberately wrong pass
that the oracle catches and the reducer shrinks to 7 lines; receipts that reproduce in a fresh process and
fail on any edit. All commands and outputs are in [BUILD_LEDGER](BUILD_LEDGER.md).

## Limitations I chose
No recursion, no list construction, no modules, pure functions only, line breakpoints only, and determinism
claimed for one toolchain build (no cross-platform bit equality). See [LIMITATIONS](LIMITATIONS.md).
