# Architecture

```
 browser (React + Vite, 127.0.0.1:5720)
   │  /api/*  /health  /capabilities  /runs   (Vite proxy in dev; src/server/proxy.ts in start.sh)
   ▼
 API service (node:http, 127.0.0.1:5721) ── src/server/app.ts
   │   SQLite (node:sqlite, WAL): models · revisions (content-addressed, immutable) · runs · annotations
   │   durable queue: runs table; pump() starts ≤ N worker_threads
   ▼
 worker thread ── src/server/worker.ts         (heap ≤ 2 GiB, 10-min wall clock, terminate = cancel)
   │
   ├── core/syntax     lexer · parser · printer           (WML → AST, AST → WML)
   ├── core/model      compile (resolve + type-check → IR) · mutate
   ├── core/engine     evaluate (IR → closures) · explore (BFS) · liveness (SCC/fairness) · check (verdicts, traces, graph payload)
   ├── core/replay     independent AST interpreter for witnesses
   ├── core/receipt    canonical JSON · digest · build · verify (re-run + replay)
   └── core/tla        export (TLA+ module + cfgs) · tlc (pinned jar, sandboxed run, -tool parser, cross-check)
```

## Why TypeScript (not Rust)

The brief prefers Rust "only if the toolchain is available". A Rust toolchain exists in
`~/.local` but is not on PATH and the rest of the stack (service, UI, tests) is TypeScript; one
language keeps the model compiler, explorer, replay evaluator and UI types in a single
reviewed codebase with no FFI boundary. Node 24 runs `.ts` directly (type stripping), so there
is no build step for the server. Measured throughput (~190k–480k states/s, see
`evidence/benchmarks.md`) is ample for teaching-sized models; the graph renderer, not the
checker, is the practical limit, and it is capped at 5,000 drawn states.

## Separation of concerns (as required)

| concern | module | depends on |
|---|---|---|
| parser / schema | `core/syntax` | nothing |
| semantic evaluator | `core/model/compile.ts`, `core/engine/evaluate.ts` | syntax |
| state explorer | `core/engine/explore.ts` | IR, evaluator |
| property evaluator | `core/engine/check.ts`, `liveness.ts` | explorer |
| TLC exporter / adapter | `core/tla` | IR, replay |
| witness verifier | `core/replay`, `core/receipt` | **syntax only** (replay) / everything (receipt re-run) |

## Service

- **Runs are jobs.** `POST /api/runs` stores the exact source as a revision (content-addressed:
  identical source reuses the revision), validates bounds, rejects non-compiling models with
  422, inserts a `queued` run and pumps the queue. Kinds: `check`, `tlc` (check + TLC
  cross-check), `mutation`.
- **Progress** is posted by the worker every 4,096 states and polled by the UI.
- **Cancel** terminates the worker; for TLC jobs it also `docker kill`s containers named
  `witness-tlc-*` (only ours).
- **Crash recovery.** A worker that exits without reporting is re-queued once, then failed
  with an explicit error. On start-up, runs left `running` by a dead server are re-queued once
  (`attempts` < 2), otherwise failed. Both paths are tested.
- **Immutability.** A run moves `queued → running → done | failed | cancelled` once; its result
  and receipt are never rewritten. Revisions are never edited. Annotations are separate rows.
- **Storage caps.** 500 models, 300 revisions per model, 5,000 runs, 512 MiB database; beyond
  that the API answers 507 instead of filling the disk.

## API

App: `GET /api/catalog`, `GET /api/models`, `GET /api/models/:id`, `GET /api/models/by-slug/:slug`,
`POST /api/models`, `POST /api/models/:id/revisions`, `GET /api/revisions/:id`, `GET /api/diff?a&b`,
`POST /api/compile`, `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`,
`GET /api/runs/:id/receipt`, `GET /api/runs/:id/report.html`, `GET /api/runs/:id/tla`,
`POST /api/runs/:id/annotations`, `POST /api/receipts/verify`, `GET /api/tlc`.

Read-only Constellation contract: `GET /health`, `/capabilities`, `/runs`, `/runs/:id`
(see `CONSTELLATION_INTEGRATION.md`).

## Web

React 18 + Vite 6, CodeMirror 6 (WML stream language + server-side linting through
`/api/compile`), a canvas graph renderer (`components/Graph.tsx`) with breadth-first-layer,
shortest-witness and condensed-SCC layouts, progressive reveal by logical step, pan/zoom,
hit-testing and keyboard navigation. All verdicts, colours and paths come from the run result;
the UI computes no verdicts. The only client-side analysis is the Theater's "interference
window" annotation, derived from real trace steps and the server's per-action read/write sets.

## Ports

5720 UI, 5721 API, 5722–5729 test helpers (assigned by the integration session to avoid
clashes with tonight's other builds).
