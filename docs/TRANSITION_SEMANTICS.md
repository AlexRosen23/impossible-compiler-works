# Transition semantics

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

Every WML model denotes a **finite transition system** `M = (S, S0, A, T)` plus a set of
properties and fairness assumptions. This document is the contract that the explorer
(`src/core/engine`), the independent replay evaluator (`src/core/replay`) and the TLA+
exporter (`src/core/tla/export.ts`) all implement.

## 1. State space `S`

- The model declares variables `v1 … vn` (globals, then each process instance's locals in
  declaration order; a local `pc` of process `A` is the variable `A.pc`).
- Each variable has a finite domain: an integer range `lo..hi` (at most 1,000,000 values),
  `bool`, or an enumeration of identifiers.
- A **state** is a total assignment of one domain value to every variable. `S` is the
  cartesian product of the domains; `|S|` ("declared state space") is reported for every model.
- **Canonical encoding.** A state is a fixed-length vector in declaration order. Integers are
  themselves, booleans are `0/1`, enumeration literals are indexes into the model's literal
  table. The **canonical key** is the decimal vector joined by commas (`"0,2,1,0"`). Two states
  are identical **iff** their keys are equal: deduplication uses this exact content key, not a
  hash, so there are no collisions. The SHA-256 **state digest** (`name=value` lines in
  declaration order) is used only for display and receipts. Neither depends on JavaScript
  object key order.

## 2. Initial states `S0`

Each variable has either one initial value (`= expr`, a constant expression) or an initial
set (`in 0..2`, `in {a, b}`, `in bool`). `S0` is the cartesian product of the initial sets,
enumerated in declaration order (first variable slowest). At most 100,000 initial states.

## 3. Actions `A` and the transition relation `T`

- A process declaration `process A, B { … }` is a template instantiated once per name. Inside
  it, unqualified names resolve to (1) the instance's locals, (2) action parameters, (3)
  globals, (4) constants, (5) enumeration literals / process names. `self` is the instance's
  own name as a literal. `P.x` names process `P`'s local `x` from anywhere.
- An action `action a(p in D) when g { x := e1; y := e2 }` is instantiated once per process
  instance and per parameter value, giving labelled actions such as `A.send(m=1)`.
- An action instance `α` is **enabled** in state `s` iff its guard `g` evaluates to `true` in `s`
  (an absent guard is `true`).
- Taking `α` from `s` yields exactly one successor `s'`: **simultaneous assignment**. Every
  right-hand side is evaluated in the pre-state `s`; each assigned variable gets its value;
  every other variable is unchanged. A variable may be assigned at most once per action
  (compile error E230 otherwise). This is the TLA+ reading `g ∧ x' = e1 ∧ y' = e2 ∧ UNCHANGED ⟨others⟩`.
- `T = {(s, α, s') | α enabled in s, s' = effect(α, s)}`. The **behaviours** of `M` are the
  interleavings: one action instance per step. There is no true concurrency, no time and no
  probability; a "step" is a *logical step*, not a duration. Delays, reorderings, crashes and
  timeouts exist only when the model encodes them as nondeterministic actions (e.g. a
  `Network` process with a `lose_reply` action).
- **Domain violations.** If an assignment would leave a variable's declared domain, the step
  is not added to `T`; it is recorded as a violation of the implicit property `TypeOK`, with a
  witness ending in the offending successor. (TLC reports the same situation as a violation of
  the exported `TypeOK` invariant.)
- **Expression semantics.** Integers are mathematical integers checked to stay within ±2^31;
  `%` is the mathematical modulus with a positive divisor (as in TLA+); `and`/`or`/`=>` are
  boolean connectives evaluated left to right; comparisons are not chainable;
  `if c then a else b` requires both branches to have the same type. Evaluation errors
  (`x % 0`, overflow) are reported as `ERROR`, never silently ignored.

## 4. Identical states and self-loops

States are identified by canonical key. An action whose successor equals its source is a
real edge (a self-loop) for reachability and deadlock purposes, but for fairness it does not
count as "taken" or "enabled" (it is not a `⟨A⟩_vars` step), matching TLA+.

## 5. Deadlock and intended termination

A reachable state with **no enabled action** is a **deadlock** unless it satisfies one of the
model's `terminal` predicates, in which case it is an **intended terminal state**. Deadlock
freedom is always checked and reported as the property `DeadlockFreedom`.

## 6. Properties

| kind | syntax | meaning |
|---|---|---|
| invariant | `invariant I: p` | `p` holds in every reachable state |
| deadlock freedom | implicit | no reachable non-terminal state without an enabled action |
| domain safety | implicit `TypeOK` | no reachable step leaves a declared domain |
| eventually | `liveness L: eventually q` | every fair behaviour from an initial state reaches a `q` state |
| leads-to | `liveness L: p leadsto q` | in every fair behaviour, every `p` state is followed (now or later) by a `q` state |

Liveness semantics, stuttering and fairness are specified in `LIVENESS_AND_FAIRNESS.md`.

## 7. Independence of the replay evaluator

The explorer compiles the resolved IR into closures over integer vectors. The replay
evaluator (`src/core/replay/replay.ts`) does **not** use the IR, the compiler, the integer
encoding or the closure compiler: it re-parses the source and interprets the AST over named
JavaScript values (numbers, booleans, literal strings) with its own name resolution,
enabledness test, simultaneous-assignment step and fairness check. The two share only the
lexer and parser; a parser bug would affect both (the round-trip printer test and the TLC
cross-check are the defences against that).
