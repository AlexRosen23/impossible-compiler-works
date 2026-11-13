# Constellation integration

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

Delivered as a **separate, unmerged PR** in `AlexRosen23/constellation` (branch
`feat/impossible-witness-world`), which also updates `docs/FEATURES.md` in the same PR, as the
Constellation's features list is the source of truth. The world is a self-contained manifest
(`worlds/proj/impossible-witness/`) with a service launch on 5720/5721 and a standalones
reader for `/runs` and `/capabilities`. See that PR for scenery and tests. Merging either PR,
and making anything live, is the owner's decision.
