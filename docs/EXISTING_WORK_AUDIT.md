# Existing Work Audit

Purpose: before building PAPER TIGER COMPILER WORKS, check whether a compiler, language or similar project
already existed among the owner's projects, decide what could be reused, and record why this is a separate
repository. Audit date: 2026-11-12.

## 1. Was there already a PAPER TIGER project?

No. No `paper-tiger-compiler-works` repository or folder existed, checked locally under
`~/Desktop/Claude Projects/` and on GitHub under `AlexRosen23` on 2026-11-12.

## 2. Similarly named or related work

| Candidate | What it is | Relation to PAPER TIGER |
|---|---|---|
| Constellation, `server/agentwork/compiler.ts` ("The Mission Compiler") | A planner and validator for agent work. Its header describes the flow: one goal, then a source inventory, then feasible tasks, then a dependency DAG with roles, tool scopes and a budget, then a dry run (and owner review when needed), then execution with checkpoints, with independent acceptance evidence. It validates the DAG (known steps only, acyclic, typed actions, budget inside caps) and refuses model-proposed steps that are not in its template. | Different domain. "Compiler" there means compiling a goal into a validated task plan. It has no lexer, grammar, type system, IR, optimizer, bytecode or VM. Nothing to reuse as code. (Read-only check of the file's header comment.) |
| "Rule Box" | Not found in Constellation `docs/FEATURES.md`, the owner's memory files, briefs or the shelf of build prompts. | Does not exist. |
| "Prompt Loom" | Not found in the same places. | Does not exist. |
| "Forge" | Exists only as the Forge Website Builders (website builder versions) and as a Constellation mind (character) name. | Unrelated: neither is a language or compiler. |
| Blueprint Zero (`~/Desktop/Claude Projects/Blueprint Zero`) | A local CAD prototype: turns a sketch and a sentence into an editable multi-part CadQuery assembly with rigid-body joints, collision checks and verified STEP/STL export; owns the shared `cadcore/` kernel vendored by Makeshift and SKIN. Python (CadQuery, FastAPI) plus a React/Three.js front end. | Unrelated domain (CAD geometry), different language stack. Its "design as editable parameters, verify outputs before claiming them" stance is similar in spirit only. (Read-only check of its README.) |

## 3. What was reused

Conventions only; no code was copied from another project.

| Reused | From |
|---|---|
| Repository bootstrap: gitleaks hooks (`.githooks/`, `.gitleaks.toml`), baseline `.gitignore` (no secrets, databases or local data) | the owner's `new-github-project.sh` playbook used by every project |
| Branch and pull-request workflow (`feat/` branches, no direct pushes to `main`) | the same playbook |
| Toolchain pattern: Node 24 running `.ts` files directly through type stripping, `node:sqlite` for storage with numbered migrations, no native add-ons | the same approach as CURRENT//ZERO |
| Loopback-only server with a read-only `GET /health`, `/capabilities`, `/runs`, `/runs/{id}` contract | the Constellation integration contract used by other projects |

## 4. Why a separate repository

- It is a different kind of system: a language implementation with its own grammar, type system, IR, bytecode
  format, VM, receipts and evidence. None of the existing projects contains any of these parts, so there is
  nothing to extend.
- It has its own versioned artifacts (`folio-grammar/0.1`, `folio-ir/0.1`, `folio-bc/0.1`, `folio-scene/0.1`,
  `paper-tiger-receipt/0.1`) whose reproducibility depends on pinning the compiler version and commit; mixing it
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
| Static semantics | lexical scopes, shadowing warnings, type checking with a poison type, definite-return and reachability analysis, call-graph recursion detection, 42 documented diagnostic codes (`core/checker.ts`, `TYPE_SYSTEM.md`) |
| Intermediate representation | typed register IR in basic blocks with single-definition registers whose definitions are verified to dominate their uses, slots for mutable state (`core/ir.ts`, `core/irverify.ts`) |
| Optimizer legality reasoning | folding that refuses to fold faulting operations, DCE that respects strict evaluation, CSE that reasons about faults and commutativity (`core/optimize.ts`, `OPTIMIZATION_CORRECTNESS.md`) |
| Bytecode design and verification | stack bytecode with debug tables, content hash, and a verifier that checks operands, jump targets, stack discipline and recursion (`core/bytecode.ts`) |
| VM sandboxing | explicit frame stack, fuel, stack and call-depth limits, no host access beyond pure built-ins (`core/vm.ts`, `VM_AND_SANDBOX.md`) |
| Differential testing, fuzzing and reduction | an independent reference interpreter as oracle, seven pass configurations, a seeded type-directed generator, a token mutator, a deliberately broken pass caught by the oracle, and a delta-debugging reducer (`tests/differential.test.ts`, `tests/optimizer.test.ts`, `core/fuzz.ts`, `core/reduce.ts`) |
| Reproducibility | stage hashes, run receipts with a digest, and an independent `reproduce` that re-derives every hash (`core/receipt.ts`, `evidence/receipts/`) |
| Debugger engineering | stepping, line breakpoints, bounded checkpoints, rewind and a replay proof by state hash (`core/debugger.ts`) |
| Honest measurement | interleaved benchmarks with spread statistics and a stated non-result (`evidence/benchmarks.json`) |

The same documents also list what the project does not do (`LIMITATIONS.md`), and record the nine findings of the
documentation review, which were fixed with regression tests (`tests/regressions.test.ts`).
