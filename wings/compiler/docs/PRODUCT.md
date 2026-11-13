# Product

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Compiler wing (formerly PAPER TIGER COMPILER WORKS). Ports and commands for the combined app are in the [root README](../../../README.md); older mentions of ports 5580/5581/5590 describe the standalone app.

**PAPER TIGER COMPILER WORKS** is a language-engineering instrument: a place to write small programs in FOLIO
and watch every stage of their compilation and execution, from tokens to pixels. It works at two levels:

- **For a novice:** an error explains itself at the exact characters that caused it, in plain words with a
  hint. The pipeline rail shows which stage stopped. Programs draw something you can see and scrub through time.
- **For a compiler engineer:** the AST with node ids and spans, the scope graph and type-derivation trace, the
  IR with instruction ids and source maps, the CFG, the bytecode with stack effects, before/after optimization
  with legality notes, a step debugger with time travel, and receipts that reproduce bit for bit.

## Domain and scope
FOLIO targets data-driven generative diagrams and small time-based visual stories: charts from read-only
fixtures, geometric compositions, animations sampled at discrete frames from a pure `time` input. It cannot
touch files, the network, the DOM or other apps. That is deliberate: the language is a concrete, safe and
total playground for language implementation, not a competitor to general-purpose languages.

## The eight experiences
| | mode | what is real |
|---|---|---|
| A | **Editorial** | CodeMirror editor with highlighting from the actual lexer, checker-backed diagnostics, scope-aware completion, type hovers, Format, save/fork/history/diff/restore, deep links; live pipeline rail with per-stage timing and hashes; rendered scene with frame scrubber and a per-frame VM ≡ reference verdict |
| B | **Syntax Furnace** | the token stream with spans; the AST explorer synced to source selection; the grammar rail from the spec |
| C | **Type Observatory** | scopes, symbols, uses, function signatures, call graph, datasets, and the type-derivation trace |
| D | **Lowering Floor** | IR before or after passes, a layered CFG with true/false/back edges, bytecode with stack effects, the constant pool, the content hash and verification status |
| E | **Optimization Duel** | pass toggles, struck-through removals, rewritten operands, the pass log, equivalence over all frames, an in-browser interleaved measurement, and the recorded benchmark table |
| F | **Bytecode Theater** | the real VM stepped by instruction, by line, over and out; line breakpoints; call stack, locals, operand stack, registers and watches; time travel with a replay-equality proof |
| G | **Failure Gallery** | 14 curated failures checked live, the fault lab with a deliberately wrong pass and the reducer, a tampered-bytecode demo, in-browser differential fuzzing |
| H | **Proof Cabinet** | server-recorded, content-addressed runs; receipts; reproduce; tamper tests; bundle export and import |

## What it is not
Not an LLM product: no model checks or explains anything. Not a CAD tool, and not an agent orchestrator (see
[EXISTING_WORK_AUDIT](EXISTING_WORK_AUDIT.md)). Not deployed: it runs on 127.0.0.1.
