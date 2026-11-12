# Constellation integration

**Status: contract BUILT and tested in this repo; Constellation world NOT_BUILT (OWNER_ACTION).**

The brief asks for a narrow, read-only integration and strict isolation. This repo therefore changes nothing
in the Constellation repository. A world can be added there in a separate, owner-approved PR.

## The read-only contract (served by `server/app.ts`, tested in `tests/server.test.ts`)
| endpoint | returns |
|---|---|
| `GET /health` | `{ ok, service, version, commit, uptimeSeconds, runs }` |
| `GET /capabilities` | language and format versions, stages, passes, limits, number of diagnostics/faults/examples, the contract itself |
| `GET /runs?limit=N` | the latest run summaries: id, project, hashes, `oracleAgrees`, fault, passes, timing |
| `GET /runs/{id}` | one run summary plus its full receipt |

All four are GET-only, loopback-only (`127.0.0.1:5580`, Host-header checked) and side-effect free. They are not
a second dashboard: they expose only what a world needs to show liveness, versions and the latest verified runs.

## Proposed world (for the owner to approve)
- Attach: a world that opens `http://127.0.0.1:5580` (`npm start` in this repo), and reads `/health`.
- Build out: show the latest runs from `/runs` with their oracle verdicts.
- Connect: per the Constellation rule, "connected" only after an observed launch from inside the Constellation.
- `docs/FEATURES.md` in the Constellation repo must be updated in the same PR.

Nothing in this repo depends on the Constellation, and the Constellation is not required to run it.
