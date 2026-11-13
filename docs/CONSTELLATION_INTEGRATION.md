# Constellation integration

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

## Read-only contract (served by the API, 127.0.0.1:5721)

All `GET`, JSON, `schema_version: 1`, `project_id: "impossible-witness"`, loopback only.

| endpoint | content |
|---|---|
| `/health` | `{status:"ok", ok:true, project_id, service, version, mode:"bounded-model", uptime_s, queue:{active}, recovered, problems:[], last_run:{run_id, kind, status}}` |
| `/capabilities` | the shared three lists (`implemented`, `not_implemented`, `disabled_by_design`), `active_mode: "bounded-model"`, `dataset: {synthetic: true}`, summary, engine, checkers (`internal` available; `tlc` `available` or `INTERNAL_ONLY`), example count, the eight feature rooms, read-only endpoints, default bounds, provenance labels, disclaimer |
| `/runs?limit=N` | newest first: `{schema_version, project_id, generated_at, total, runs:[…]}` |
| `/runs/:id` | `{schema_version, project_id, run}` |

Each run (the Constellation's shared `provenance` run shape): `run_id`, `project_id`, `kind`
(`model-check` / `tlc-cross-check` / `mutation-test`), `status` (`queued` / `running` /
`completed` / `failed` / `cancelled`), `mode: "bounded-model"`, `verdict`, `complete`,
`states`, `edges`, `model` (slug of a shipped example, otherwise `user-model`), `title`
(stripped of markup characters, ≤ 80 chars), `revision`, `headline` (e.g.
`counter-race r1: VIOLATION_FOUND, 13 states`), `started_at`, `ended_at`, `created_at`,
`finished_at`, `provenance: {synthetic: true, label, source}` (`label` is `fixture` for a run of
a shipped example model and `synthetic` for a user-written model; every model is synthetic),
`links.self`.

Never exposed: model source, annotations, receipts, file paths, environment, user input other
than the sanitised title. Tested in `tests/server.test.ts`.

## Launch

`./scripts/start.sh` builds the UI if needed, starts the API on `API_PORT` (default 5721)
and serves the UI + proxied API on `WEB_PORT` (default 5720), both bound to 127.0.0.1.
Health: `http://127.0.0.1:5721/health`.

## The Constellation world

Delivered as a **separate, unmerged PR**, AlexRosen23/constellation#450 (branch
`feat/impossible-witness-world`), which also updates `docs/FEATURES.md` in the same PR, as the
Constellation's features list is the source of truth. The world is a self-contained manifest
(`worlds/proj/impossible-witness/`) with a service launch on 5720/5721 and a standalones
reader for `/runs` and `/capabilities`. See that PR for scenery and tests. Merging either PR,
and making anything live, is the owner's decision.

## THE IMPOSSIBLE COMPILER WORKS (merged 2026-11-13)

The Witness and PAPER TIGER COMPILER WORKS are one app now. For the integration session:

- **Ports.** 5720 is the Vite UI for both wings (`/` Witness wing, `/compiler/` Compiler wing), 5721 the API. The
  Compiler wing's API is mounted unchanged at `/engine/compiler/{health,capabilities,runs,runs/:id,api/*}` and
  its `/health` still says `service: "paper-tiger-compiler-works"`. **Retired: 5580/5581** (and 5590 for tests).
- **Contract.** `/health` keeps `project_id: "impossible-witness"` and adds `name: "THE IMPOSSIBLE COMPILER WORKS"`,
  `formerly: ["Paper Tiger Compiler Works", "The Impossible Witness"]` and `wings.{witness,compiler}`.
- **Framing.** Compiler wing pages keep their CSP `frame-ancestors` for the Constellation (4520/4521); Witness wing
  pages stay `frame-ancestors 'none'`.
- **Worlds.** Fold the Compiler Works world into the Witness world (one world, two wings). Launch title match:
  `THE IMPOSSIBLE COMPILER WORKS` (both wings' titles end with it).
- **After merge (live folder).** `npm ci` (React 19, Vite 8, TypeScript 6), copy `tools/tla2tools.jar` if
  present, restart `scripts/dev` or `scripts/start.sh`, then stop the old Paper Tiger servers on 5580/5581 by PID.
  Old Paper Tiger data (`var/paper-tiger.sqlite`) can be copied to `data/witness-compiler.sqlite` to keep its
  projects and runs.
- **Site line.** "THE IMPOSSIBLE COMPILER WORKS: write it, compile it, prove nothing impossible can happen.
  Formerly Paper Tiger Compiler Works and The Impossible Witness." Screenshots: `evidence/screenshots/icw-witness-wing.png`,
  `icw-compiler-wing.png`, `icw-cross-feature-pass-orders.png`.
