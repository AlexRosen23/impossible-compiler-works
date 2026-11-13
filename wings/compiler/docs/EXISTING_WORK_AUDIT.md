# Existing Work Audit

Purpose: before building PAPER TIGER COMPILER WORKS, check whether a compiler, language or similar project
already existed among the owner's projects, decide what could be reused, and record why this is a separate
repository. Audit date: 2026-11-12.

## 1. Was there already a PAPER TIGER project?

No. No earlier PAPER TIGER repository or folder existed among the owner's projects when this one started
(checked on 2026-11-12).

## 2. Similarly named or related work

The owner's other projects were checked for anything that already was, or contained, a language, compiler or
virtual machine. One project uses the word "compiler" for a planner that turns a goal into a validated task graph
(steps, dependencies, budgets); it has no lexer, grammar, type system, IR, optimizer, bytecode or VM. A CAD
prototype shares only a general stance (keep designs as editable parameters and verify outputs before claiming
them). Nothing else came close, and no code was reusable.

## 3. What was reused

Conventions only; no code was copied from another project.

| Reused | From |
|---|---|
| Repository bootstrap: gitleaks hooks (`.githooks/`, `.gitleaks.toml`), baseline `.gitignore` (no secrets, databases or local data) | the owner's standard repository setup |
| Branch and pull-request workflow (`feat/` branches, no direct pushes to `main`) | the same setup |
| Toolchain pattern: Node 24 running `.ts` files directly through type stripping, `node:sqlite` for storage with numbered migrations, no native add-ons | the owner's other Node projects |
| Loopback-only server with a read-only `GET /health`, `/capabilities`, `/runs`, `/runs/{id}` contract | the integration contract the owner's Constellation dashboard reads from each standalone project |

## 4. Why a separate repository

- It is a different kind of system: a language implementation with its own grammar, type system, IR, bytecode
  format, VM, receipts and evidence. None of the existing projects contains any of these parts, so there is
  nothing to extend.
- It has its own versioned artifacts (`folio-grammar/0.2`, `folio-ir/0.1`, `folio-bc/0.1`, `folio-scene/0.1`,
  `paper-tiger-receipt/0.2`) whose reproducibility depends on pinning the compiler version and commit; mixing it
  into a larger repository would make receipts depend on unrelated changes.
- Its test suite (differential testing, fuzzing, reduction) and evidence files should run and be read on their
  own.
- It integrates with Constellation only through the read-only HTTP contract, like other standalone projects.

## 5. What it demonstrates (for software-engineering reviewers)

Each item points to where the evidence is.

| Skill | Evidence in this repository |
|---|---|
| Language design | a small, total, statically typed language with explicit limits and a normative spec (`FOLIO_LANGUAGE_SPEC.md`) |
| Parsing with error recovery | hand-written recursive descent with exact spans, expected-token messages, panic-mode recovery and non-associative comparisons (`core/parser.ts`, `tests/frontend.test.ts`) |
| Static semantics | lexical scopes, shadowing warnings, type checking with a poison type, definite-return and reachability analysis, call-graph recursion detection, a static bound on interpreter stack depth, 45 documented diagnostic codes (`core/checker.ts`, `TYPE_SYSTEM.md`) |
| Intermediate representation | typed register IR in basic blocks with single-definition registers whose definitions are verified to dominate their uses, slots for mutable state (`core/ir.ts`, `core/irverify.ts`) |
| Optimizer legality reasoning | folding that refuses to fold faulting operations, DCE that respects strict evaluation, CSE that reasons about faults and commutativity (`core/optimize.ts`, `OPTIMIZATION_CORRECTNESS.md`) |
| Bytecode design and verification | stack bytecode with debug tables, content hash, and a verifier that checks operands, jump targets, stack discipline and recursion (`core/bytecode.ts`) |
| VM sandboxing | explicit frame stack, per-frame and whole-run fuel, call, stack, call-depth and scene-size limits, no host access beyond pure built-ins, and a server worker with a wall-clock and heap limit (`core/vm.ts`, `server/jobs.ts`, `VM_AND_SANDBOX.md`) |
| Adversarial review | a pre-release red team of the server, the compiler and VM, and the IDE; every reproduction became a regression test (`SECURITY.md` section 5, `tests/security.test.ts`) |
| Differential testing, fuzzing and reduction | an independent reference interpreter as oracle, seven pass configurations, a seeded type-directed generator, a token mutator, a deliberately broken pass caught by the oracle, and a delta-debugging reducer (`tests/differential.test.ts`, `tests/optimizer.test.ts`, `core/fuzz.ts`, `core/reduce.ts`) |
| Reproducibility | stage hashes, run receipts with a digest, and an independent `reproduce` that re-derives every hash (`core/receipt.ts`, `evidence/receipts/`) |
| Debugger engineering | stepping, line breakpoints, bounded checkpoints, rewind and a replay proof by state hash (`core/debugger.ts`) |
| Honest measurement | interleaved benchmarks with spread statistics and a stated non-result (`evidence/benchmarks.json`) |

The same documents also list what the project does not do (`LIMITATIONS.md`), and record the nine findings of the
documentation review and the findings of the pre-release red team, all fixed with regression tests
(`tests/regressions.test.ts`, `tests/security.test.ts`).
