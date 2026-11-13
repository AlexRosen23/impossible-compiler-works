# Cross-feature: the Witness wing model-checks the Compiler wing's optimizer

**Question.** The Compiler wing runs its optimization passes in one fixed order (`constfold`, `dce`, `cse`), once.
If they ran in *any* order, *any* number of times, could the optimized program ever draw something different from
the independent reference interpreter?

**Status: TESTED** for the 14 shipped FOLIO seeds. Code: [`bridge/pass-orders.ts`](../bridge/pass-orders.ts).
Tests: [`bridge/tests/`](../bridge/tests/). Evidence: [`evidence/bridge/`](../evidence/bridge/).

## How it works

1. **Compile** the seed with no passes (the real lexer, parser, checker and lowering).
2. **Abstract.** Breadth-first, apply each pass of an alphabet to each IR module with the real `optimize()` (the IR
   verifier runs after every pass). Every distinct IR module (keyed by the SHA-256 of its canonical encoding) is
   one abstract state. Passes only shrink or rewrite the IR, so the graph is finite; a cap of 48 modules turns the
   result into `INCOMPLETE` if it is ever reached (it is not, for any shipped seed: 8 to 16 modules).
3. **Label.** For each module: real codegen, the bytecode verifier, the real VM; compare its scene hash with the
   reference interpreter's for the original program (same fixtures, same default limits). Labels:
   `agree`, `diverge`, `vm-fault`, `invalid`.
4. **Check.** Emit the graph as a WML model: `var prog` is the module id, `var agree` its label, and one action per
   pass (a balanced `if prog < k` decision tree gives the successor). The Witness engine explores it and checks
   `invariant OptimizedMatchesReference: agree`. A violation comes back as the **shortest pass sequence** that
   reaches a diverging program, replayable by the independent replay evaluator and sealed in a standard Witness
   receipt.

## Results

| seed | alphabet | IR modules | verdict |
|---|---|---|---|
| all 14 shipped seeds | `constfold, cse, dce` | 8 to 14 each | `NO_DIVERGENCE_IN_ANY_PASS_ORDER` |
| 13 seeds | `+ BAD_cse_commute_all` | 10 to 14 each | `NO_DIVERGENCE_IN_ANY_PASS_ORDER` (no subtraction to mis-commute) |
| `fault-lab-commute` | `+ BAD_cse_commute_all` | 16 (6 diverge) | `DIVERGENCE_FOUND`, shortest: `BAD_cse_commute_all` |

`BAD_cse_commute_all` is the Compiler wing's deliberately wrong pass (it treats subtraction as commutative). It is
the negative control: the check finds it on the one seed where it matters and stays quiet where it cannot matter.

Re-run: `npm run pass-check -- <seeds…> [--mutant]`. In the IDE: Optimization Duel → **Every pass order**
(shipped examples only) → **open the model in the Witness wing**.

## What this does and does not show

- The model checker does **not** re-derive FOLIO semantics. The edges and labels come from running the real
  compiler, VM and reference interpreter. What the Witness engine adds is the exhaustive, order-independent search
  over the pass-order graph, the shortest counterexample, independent replay and a tamper-evident receipt.
- One seed, its fixtures and its limits per verdict. It is not a proof that the passes are correct for all
  programs; the differential fuzzer (4,000 programs, 0 divergences) and the legality rules in
  [OPTIMIZATION_CORRECTNESS.md](../wings/compiler/docs/OPTIMIZATION_CORRECTNESS.md) cover other ground.
- The receipt proves the model check; `bridge/tests/pass-orders.test.ts` proves the model is what the compiler
  produces today (the shipped `.witness` files must regenerate byte-for-byte from the FOLIO seeds).
