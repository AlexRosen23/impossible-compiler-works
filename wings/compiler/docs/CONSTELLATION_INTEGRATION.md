# Constellation integration

**Status: contract BUILT and tested in this repo; Constellation world BUILT and LIVE** (`proj:paper-tiger`, "The
Compiler Works", AlexRosen23/constellation PR #442, integrated by PR #445, owner-approved, 2026-11-12).

The brief asks for a narrow, read-only integration and strict isolation. This repo therefore changes nothing
in the Constellation repository; the world lives there, in its own PRs.

## The read-only contract (served by `server/app.ts`, tested in `tests/server.test.ts`)
| endpoint | returns |
|---|---|
| `GET /health` | `{ ok, service, version, commit, uptimeSeconds, runs }` |
| `GET /capabilities` | language and format versions, stages, passes, limits, number of diagnostics/faults/examples, the contract itself |
| `GET /runs?limit=N` | the latest run summaries: id, project, hashes, `oracleAgrees`, fault, passes, timing |
| `GET /runs/{id}` | one run summary plus its full receipt |

All four are GET-only, loopback-only (`127.0.0.1:5580`, Host-header checked) and side-effect free. They are not
a second dashboard: they expose only what a world needs to show liveness, versions and the latest verified runs.

## The world (built in the Constellation repo)
- Attach: its launcher opens `http://127.0.0.1:5580`, or starts it with `npm start` in this repo, and reads `/health`.
- Build out: it shows the latest runs from `/runs` with their oracle verdicts.
- Connect: checked 2026-11-12 against the live Constellation: its reader went `live` and showed a real run
  ("VM and reference agree · passes constfold, dce, cse").
- Opening inside: the IDE's CSP lets only the Constellation's loopback origins (4520, 4521) frame it
  (`server/static.ts`, `docs/SECURITY.md` §2.5), so the world shows the IDE inside itself instead of a new tab.

Nothing in this repo depends on the Constellation, and the Constellation is not required to run it.
