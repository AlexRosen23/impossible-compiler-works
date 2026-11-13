# Build ledger

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

Labels: `TESTED` (built and covered by passing automated tests or recorded evidence),
`PARTIAL` (built, with a stated gap), `INCOMPLETE` (started, not usable), `FAILED` (tried, does
not work), `NOT_BUILT`, `OWNER_ACTION` (needs the owner). Last updated 2026-11-12 on branch
`feat/witness-v0.1`.

## START RIGHT NOW vertical slice

| step | status | evidence |
|---|---|---|
| two concurrent processes | TESTED | `examples/counter-race.witness` |
| finite transition system (typed, canonical states) | TESTED | `tests/parser.test.ts`, `tests/explore.test.ts`, `docs/TRANSITION_SEMANTICS.md` |
| BFS explorer | TESTED | hand oracle 13 states / 14 edges |
| real violation | TESTED | `NoLostUpdate` violated |
| shortest counterexample | TESTED | 4 steps; minimality test against all violating states |
| live diagram / table | TESTED | E2E journey 1, screenshot `01-counter-race-witness.png`, States table test |
| repaired model | TESTED | `counter-atomic.witness` |
| completed bounded verification | TESTED | 4 states, exhaustive, `VERIFIED_BOUNDED` |
| receipt + independent replay | TESTED | `tests/receipt.test.ts`, `scripts/demo`, `evidence/demo/` |

## Phases

| phase | item | status | evidence / gap |
|---|---|---|---|
| 0 | portfolio audit | TESTED | `docs/EXISTING_WORK_AUDIT.md` (read-only source audit) |
| 0 | formal semantics spec | TESTED | `docs/TRANSITION_SEMANTICS.md` |
| 1 | canonical states, explicit transitions, BFS, invariant oracle | TESTED | 13 explore tests |
| 2 | model DSL, diagnostics, editor | TESTED | parser tests; E2E "editing" |
| 2 | ≥ 8 tutorial examples | TESTED | 17 scenarios / 35 models |
| 3 | graph + trace visualisation wired to real results | TESTED | E2E journeys; screenshots |
| 3 | graph optimised for 1k–10k nodes | PARTIAL | canvas renderer; capped at 5,000 drawn states (stated on screen); 1,000-state model renders interactively; no WebGL / clustering beyond SCC condensation |
| 4 | deadlocks vs terminal states | TESTED | explore tests; E2E journey 4 |
| 4 | bounded liveness + fairness (WF/SF) | TESTED | `tests/liveness.test.ts`; starvation trio; TLC agreement |
| 4 | failure gallery, source-linked errors | TESTED | Bazaar; diagnostics with line:col and CodeMirror lint markers |
| 5 | TLC exporter + sandboxed adapter, pinned version | TESTED | `tests/tla.test.ts` (recorded output + live run) |
| 5 | cross-check corpus + report | TESTED | `evidence/tlc-crosscheck.md`: 150/150 agree |
| 6 | save / version / diff models | TESTED | server test "content-addressed revisions and diffs"; Revisions tab |
| 6 | replayable receipts, tamper rejection | TESTED | receipt tests; E2E journey 6; `scripts/reproduce` |
| 6 | HTML report + JSON replay bundle export | TESTED | `/api/runs/:id/report.html` (XSS test), receipt download (E2E) |
| 6 | annotations | PARTIAL | saved and shown per run and in the report; no edit/delete (append-only by design) |
| 7 | 15 examples | TESTED | 17 scenarios, concepts test |
| 7 | performance | TESTED | `evidence/benchmarks.md` (measured while E2E ran in parallel; see LIMITATIONS) |
| 8 | recruiter journey | TESTED | E2E "guided 90-second journey"; `docs/RECRUITER_DEMO.md` |
| 8 | accessibility | TESTED | axe (no serious/critical), keyboard graph nav, table fallback, reduced motion; CodeMirror excluded from the axe scan |
| 8 | browser E2E, mobile, screenshots | TESTED | 15/15 Playwright; 17 screenshots |
| 8 | negative tests (malformed, XSS, huge domains, storage, crash, cancel) | TESTED | server + parser tests |
| 9 | Constellation contract | TESTED | `/health`, `/capabilities`, `/runs`, `/runs/:id`; public-safety test |
| 9 | Constellation world PR + FEATURES.md | TESTED | AlexRosen23/constellation#450 (`feat/impossible-witness-world`, unmerged): world order 92, bespoke Logic Cathedral scene, reader fixtures recorded from this app, FEATURES.md + PROJECT_LIFECYCLE + public manifest in the same PR; its own world test 10/10; the Constellation's full `npm test` was not re-run green after the last fix (see that PR) |
| 9 | website case study (unposted) | TESTED | `docs/PORTFOLIO_CASE_STUDY.md` (draft only; not posted, per owner rule) |

## Acceptance journeys

| # | journey | status | evidence |
|---|---|---|---|
| 1 | broken counter → violation → step trace → two non-atomic read/writes | TESTED | E2E journey 1 |
| 2 | atomic fix → complete bounded exploration → no violation (bounded, not universal) | TESTED | E2E journey 2 |
| 3 | at-least-once queue duplicate → idempotency fix → retest | TESTED | E2E journey 3 |
| 4 | resource deadlock → fix lock order → recheck | TESTED | E2E journey 4 |
| 5 | export TLA+ → run TLC → compare and explain mismatches | TESTED | E2E journey 5; `docs/TLC_COMPATIBILITY.md` |
| 6 | 50-state cap → INCOMPLETE → receipt → tamper rejected | TESTED | E2E journey 6; receipt tests |

## Owner actions and open items

| item | status | note |
|---|---|---|
| host JDK for TLC without Docker | OWNER_ACTION | TLC currently runs in the already-installed keycloak JVM image; installing a JDK is the owner's call (same open question as VoxelMint) |
| GitHub Actions | OWNER_ACTION | `.github/workflows/ci.yml` is in the repo; Actions are disabled on the repo and stay off until the owner approves |
| merge PRs / deploy / make public | OWNER_ACTION | nothing merged, deployed or published |
| preview-pane dev server | PARTIAL | the app's own launch config could not be started through the desktop preview tool (per-folder server limit used by other chats); verified by running `scripts/dev` and opening the pane by URL |
| symbolic engine, POR, symmetry | NOT_BUILT | out of scope; the docs never claim them |
| Alloy | NOT_BUILT | optional in the brief; no case where it adds value yet |

## THE IMPOSSIBLE COMPILER WORKS merge + public-release hardening (2026-11-13)

| item | status | evidence |
|---|---|---|
| Paper Tiger history merged into `wings/compiler/` (MIT notice kept) | TESTED | `git log -- wings/compiler`; Compiler wing suite 126/126 inside the merged app |
| one API (5721, Compiler API at `/engine/compiler`) + one Vite (5720, `/` and `/compiler/`) | TESTED | `bridge/tests/combined-server.test.ts`; e2e both projects |
| shared shell, visible "Formerly …" line, `/health` `name` + `formerly` | TESTED | `e2e/combined.spec.ts`; combined server test |
| cross-feature: every optimizer pass order model-checked by the Witness engine | TESTED | `docs/CROSS_FEATURE_PASS_ORDERS.md`; `bridge/tests/pass-orders.test.ts`; `evidence/bridge/` |
| legacy receipts of both apps still verify / reproduce | TESTED | `tests/legacy-receipts.test.ts`; `scripts/reproduce` |
| TLC cross-check in the merged app (Docker) | TESTED | `evidence/tlc-crosscheck.md` 150/150 |
| red-team fixes R1–R7 | TESTED | `docs/SECURITY.md` "Public-release red team" |
| MIT licence for the whole repo, third-party notices, SECURITY.md | TESTED (docs) | `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md` |
| security contact in SECURITY.md | OWNER_ACTION | placeholder; the owner adds a contact before the visibility flip |
| make the repository public | OWNER_ACTION | the integration session reviews and flips visibility; never done by a build session |
