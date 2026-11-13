# Architecture

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Compiler wing (formerly PAPER TIGER COMPILER WORKS). Ports and commands for the combined app are in the [root README](../../../README.md); older mentions of ports 5580/5581/5590 describe the standalone app.

PAPER TIGER COMPILER WORKS is one TypeScript codebase with three consumers of one compiler library:

```
                 ┌────────────────────────── core/ (isomorphic, no I/O) ──────────────────────────┐
                 │ lexer → parser → checker → fixtures → lower → optimize → bytecode → vm          │
                 │ interpreter (oracle) · receipt · debugger · fuzz · reduce · format · sha256     │
                 └───────────────▲───────────────────────▲──────────────────────────▲──────────────┘
                                 │                       │                          │
                  scripts/ (CLI, Node)          server/ (HTTP API, Node)       web/ (browser IDE)
                  folio, fuzz, bench,           127.0.0.1:5580, SQLite         built separately;
                  receipt, reproduce            node:sqlite                    see note below
```

The browser IDE in `web/` is being built separately and is not described in these documents beyond this: it
consumes the same `core/` library in the browser and the server's `/api` routes.

## 1. Module map (`core/`)

| Module | Responsibility |
|---|---|
| `version.ts` | version strings for compiler, grammar, IR, bytecode, scene format and receipt format |
| `limits.ts` | `Limits` and `DEFAULT_LIMITS` |
| `diagnostics.ts` | spans, diagnostics, `DIAGNOSTIC_CODES` |
| `lexer.ts` | source to tokens (never throws) |
| `ast.ts` | AST types, `children`, `countNodes` |
| `parser.ts` | recursive-descent parser with recovery |
| `checker.ts` | scopes, types, definite return, reachability, recursion, scene options |
| `fixtures.ts` | binds `data` declarations to a host-supplied fixture table |
| `values.ts` | runtime value representation, fault codes, value encoding |
| `builtins.ts` | the vetted pure built-in functions and constants |
| `primitives.ts` | drawing primitive and `group` signatures with defaults |
| `scene.ts` | `SceneBuilder` (the output device), `sceneHash`, `validateScene` |
| `scene-snap.ts` | scene snapshots for the debugger |
| `interpreter.ts` | reference tree-walking interpreter (the oracle) |
| `ir.ts` | IR types, op classification, printer, encoding |
| `lower.ts` | checked AST to IR |
| `irverify.ts` | IR verifier, dominators, reachability, IR call-graph check |
| `ops.ts` | operator semantics shared by the VM and constant folding |
| `optimize.ts` | `constfold`, `dce`, `cse`, `BAD_cse_commute_all` |
| `bytecode.ts` | opcodes, code generator, serialization, loader, verifier, disassembler |
| `vm.ts` | the bounded VM |
| `pipeline.ts` | `compile`: the staged pipeline with `StageRecord`s |
| `receipt.ts` | run receipts and `reproduce` |
| `debugger.ts` | `DebugSession` |
| `fuzz.ts` | seeded program generator and token mutator |
| `reduce.ts` | AST reducer |
| `format.ts` | canonical pretty-printer |
| `sha256.ts` | dependency-free SHA-256 and canonical JSON |
| `index.ts` | re-exports everything |

Other directories: `server/` (HTTP API and storage), `scripts/` (command-line tools), `tests/` (Vitest suites),
`examples/` (13 example programs, 14 failure cases, the fault-lab program, fixtures), `evidence/` (fuzz summary,
benchmarks, receipts).

## 2. Data flow

1. Source text enters `compile` (`core/pipeline.ts`), which runs the seven stages in order and records one
   `StageRecord` per stage (`COMPILER_PIPELINE.md`).
2. On success, the caller gets the AST, the check result, bound datasets, raw and optimized IR, pass reports and
   serialized, verified bytecode.
3. Execution is separate: `runVM` on the bytecode, `interpret` on the checked AST. Both write through
   `SceneBuilder` into a normalized scene command buffer, so "the same drawing" is a hash comparison.
4. `makeReceipt` wraps compile plus both executions into a self-contained, digest-protected record;
   `reproduce` re-derives it.
5. The server stores projects, versions and receipts in SQLite; scripts write evidence files.

## 3. Why one TypeScript codebase

- **One parser, one checker, one VM.** The compiler runs in the browser IDE (live diagnostics, IR and bytecode
  views, debugger, rendering without a server round trip), in the server (recording runs, reproducing imported
  receipts) and in the CLI and tests. `core/` uses no Node-only or browser-only APIs (no file system, no
  network, no `node:crypto`; hashing is a local SHA-256), so the same files run in all three. There is no second
  implementation of the language to drift out of sync.
- **Hashes agree across hosts.** Because the browser and the server run the same code, including the same
  SHA-256 and canonical JSON, a receipt computed in one can be reproduced by the other.
- **Toolchain.** Node 24 runs the `.ts` files directly through type stripping (`erasableSyntaxOnly` in
  `tsconfig.json`; scripts use `node scripts/x.ts`), so there is no build step for the server, scripts or tests.
  `tsc --noEmit` is used only for type checking.

## 4. Why a hand-written recursive-descent parser

A parser generator was not used. Reasons, each visible in `core/parser.ts`:

- **Spans.** Every AST node carries an exact `{start, end, line, col}`. These spans become IR spans, bytecode
  debug spans, fault locations and the debugger's line mapping, so they have to be precise and under our control.
- **Recovery.** Panic-mode recovery to the next `;` or `}` or statement keyword reports several syntax errors in
  one pass and keeps the IDE useful while the user types.
- **Expected-token messages.** Each production knows its alternatives, so errors read "expected ";", found
  keyword "let"", with production-specific hints (for example that named arguments are only for drawing calls,
  or that comparisons do not chain).
- **Zero runtime dependencies.** The core has no npm dependencies; the grammar is small enough (one method per
  production, about 400 lines) that a generator would add a build step and a dependency without removing much
  code.
- **Non-associative comparisons and contextual keywords** (`size`, `frames`, `background`, `from`) are simple to
  express directly.

## 5. Server design (`server/`)

| File | Role |
|---|---|
| `index.ts` | process entry: binds `127.0.0.1` only, port `PT_PORT` (default 5580); database path `PT_DB` (default `var/paper-tiger.sqlite`); with `PT_STATIC=1` also serves the built IDE from `dist/` |
| `app.ts` | `createHandler`: request routing, validation, JSON responses |
| `db.ts` | `openDb`: SQLite via `node:sqlite` (built into Node 24, no native add-on), WAL journal, foreign keys on, numbered migrations |

The handler is a plain `(req, res)` function, so tests run it on an ephemeral port with an in-memory database
(`openDb(':memory:')`).

### 5.1 Routes

Read-only contract (consumed by an external dashboard, "Constellation"):

| Route | Returns |
|---|---|
| `GET /health` | service name, compiler version, commit, uptime, number of runs |
| `GET /capabilities` | versions, stage list, safe passes, fault-lab passes, limits, number of diagnostic codes, fault codes, example and failure-case counts |
| `GET /runs?limit=n` | most recent run summaries (limit clamped to 1..200, default 50) |
| `GET /runs/{id}` | one run summary plus its receipt |

IDE API:

| Route | Purpose |
|---|---|
| `GET /api/corpus` | examples, failure cases (with expected code and position) and the fault-lab program |
| `GET /api/fixtures` | the fixture library (`examples/fixtures/*.json`) |
| `POST /api/runs` | compile, run VM and reference, store the receipt and bytecode; 201, or 422 with diagnostics |
| `GET /api/runs/{id}/bytecode` | the stored serialized bytecode |
| `GET /api/runs/{id}/bundle` | an export bundle: manifest, receipt, source, fixtures, optimized IR listing, bytecode, reference scene |
| `POST /api/reproduce` | run `reproduce` on a receipt (and optional bytecode) |
| `POST /api/import` | reproduce an exported bundle and, only if every check passes, create a project from it |
| `GET /api/projects`, `POST /api/projects` | list and create projects |
| `GET /api/projects/{id}` | project with head version and history |
| `GET /api/projects/{id}/versions/{seq}` | one version |
| `POST /api/projects/{id}/versions` | save a new version; refused with 409 if `baseVersion` is not the current head |
| `POST /api/projects/{id}/restore` | append a copy of an older version as the new head |
| `POST /api/projects/{id}/fork` | new project from a version |

### 5.2 Storage

Migration 1 creates:

| Table | Columns (main) | Notes |
|---|---|---|
| `projects` | `id`, `name`, `created_at`, `forked_from` | `id` is the first 8 characters of a random UUID |
| `versions` | `id` (`<project>:v<seq>`), `project_id`, `parent_id`, `seq`, `source`, `source_hash`, `fixtures`, `message`, `created_at` | append-only; restore and save both append; unique `(project_id, seq)` |
| `runs` | `id`, `project_id`, `version_id`, `created_at`, hashes, `agrees`, `fault`, `passes`, `timing`, `receipt`, `bytecode` | content-addressed: `id` is the first 16 hex characters of the receipt digest, so identical runs deduplicate |
| `schema_migrations` | `version`, `name`, `applied_at` | migrations not yet recorded are applied in order, each inside a transaction |

Saving uses optimistic concurrency: the client names the version it edited (`baseVersion`); if the head has moved,
the server answers 409 with the current head. Saving unchanged source and fixtures returns 200 `unchanged` without
a new version.

## 6. Ports

| Service | Address |
|---|---|
| API server | `127.0.0.1:5580` (`PT_PORT`) |
| IDE development server (Vite) | `127.0.0.1:5581` (configured under `web/`; not covered here) |
| End-to-end test server | port 5590 (Playwright suite; not covered here) |

## 7. Commands

| Command | What it runs |
|---|---|
| `npm test` | Vitest over `tests/**/*.test.ts` |
| `npm run e2e` | Playwright end-to-end suite for the IDE (`e2e/`) |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` |
| `npm run lint` | ESLint |
| `npm run server` | the API server |
| `npm run dev` | API server plus the IDE dev server |
| `npm run folio`, `fuzz`, `bench`, `receipt`, `reproduce` | the scripts in `scripts/` (`COMPILER_PIPELINE.md` section 6) |
