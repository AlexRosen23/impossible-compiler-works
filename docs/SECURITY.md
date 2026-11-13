# Security

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

## Threat model

A local, single-user tool. The realistic threats are: a malicious model or receipt file
(pasted or shared), a web page in the same browser trying to reach the loopback API (CSRF /
DNS rebinding), resource exhaustion, and output that leaks into other tools (the
Constellation reads `/runs`).

## Controls

| risk | control | evidence |
|---|---|---|
| code execution from model input | WML has no calls, strings, I/O or eval; the parser rejects `f(...)`, string expressions and unknown characters; the model is never turned into JS source | `tests/parser.test.ts` "no host-language code" |
| code execution in TLC | TLA+ is generated from the type-checked IR (identifiers + integers only); TLC runs via argv (no shell) in a network-less, read-only, capability-dropped container with memory/CPU/pid/time caps | `src/core/tla/tlc.ts`, `TLC_COMPATIBILITY.md` |
| supply chain (TLC) | pinned release + SHA-256 verified at download and before every run | `scripts/setup`, `verifyJar()` |
| state explosion / huge domains | compile-time limits (`MODEL_LANGUAGE.md`), run bounds with hard maxima, worker heap limit, 10-min wall clock, cancel | `tests/explore.test.ts`, `tests/server.test.ts` |
| pathological graphs in the UI | at most 5,000 states / 40,000 edges sent and drawn; truncation is stated on screen | `check.ts` `graphLimit` |
| oversized / malformed requests | 512 KiB body cap (413), JSON parse errors (400), typed field validation, bounds validation (400), unknown run kinds (400), 30 s request timeout | server tests "malformed and oversized input" |
| storage exhaustion | row caps and a 512 MiB database cap → 507 | `db.ts` `LIMITS` |
| network exposure | binds `127.0.0.1` only; requests whose `Host` is not loopback get 421 (DNS-rebinding guard); no CORS headers, so other origins cannot read responses | server test "non-loopback Host" |
| XSS | React escapes all text; titles in the public contract are stripped of markup characters; the HTML report escapes every dynamic string and embeds the receipt as inert JSON with `<` escaped; strict CSP on served pages and reports | server + E2E XSS tests |
| path traversal | static files resolved inside `web/dist` only; `\0` rejected | `serveStatic`, proxy |
| tampered receipts | digest + source hash + full re-run + independent replay; schema-version check | `tests/receipt.test.ts` |
| SSRF | the service never fetches URLs; the only outbound network use is `scripts/setup` downloading the pinned jar | — |
| private data in the Constellation contract | `/runs` exposes slug, sanitised title, kind, status, verdict, counts and timestamps only: no source, no file paths, no annotations | server test "no source leaks" |

## Not protected against

A local attacker with your user account (they can edit the database or the code). Receipts
use an unkeyed digest: integrity comes from **recomputation**, not secrecy, so a receipt is
evidence only to someone who re-verifies it with this checker (or their own). There is no
authentication: do not expose the ports beyond loopback.

## Public-release red team (2026-11-13, combined app)

Before THE IMPOSSIBLE COMPILER WORKS can be made public, everything a stranger could run was reviewed: the dev and
production servers, the WML parser and model loader, both receipt verifiers, every file loader, the dependency
tree and the TLC download. Each finding below was fixed and has a test.

| # | finding | severity | fix | test |
|---|---|---|---|---|
| R1 | The Witness API had no cross-site guard: a page on another site (or another local port) could send a `text/plain` "simple" POST that the server parsed as JSON and acted on (queue checks, create models). Reads were already protected by the absence of CORS. | medium | Same rule as the Compiler wing: `Sec-Fetch-Site` other than `same-origin`/`none` → 403 on API and contract paths; a foreign `Origin` on a write → 403; bodies must be declared `application/json` → 415 otherwise. | `bridge/tests/combined-server.test.ts` "cross-site…", `tests/server.test.ts` "malformed…" |
| R2 | A ~400 KB body nested 200,000 levels deep made both wings answer 500 (stack overflow in recursive walkers after `JSON.parse`). | low (no crash, but a cheap error path) | Both servers measure bracket depth in O(n) without recursion and refuse anything deeper than 64 levels with a 400 before parsing (`src/server/json-depth.ts`). | "malformed paths and hostile receipts…" |
| R3 | Static serving called `decodeURIComponent` unguarded: malformed percent-encoding raised inside the handler. | low | Malformed paths are a 404 (Witness) / 400 (proxy); the Compiler wing already answered 400. | same test |
| R4 | The Witness CSP still allowed Google Fonts, which the UI never uses. | hardening | Removed; added `object-src 'none'` and `base-uri 'none'`. Compiler wing pages keep their stricter CSP. | — |
| R5 | `scripts/setup` could leave a partial `tla2tools.jar.part` after a failed download and allowed redirects to any scheme. | low | `--proto-redir '=https'`, bounded time and retries, the partial file is removed, and the message says the app still runs `INTERNAL_ONLY`. The SHA-256 pin was already enforced at download and again at every TLC run. | manual: setup with no network |
| R6 | The fairness editor built a `RegExp` from a process name (semgrep `detect-non-literal-regexp`). Names are identifiers, so not exploitable, but unnecessary. | info | Static pattern, compared by name. | semgrep clean |
| R7 | The cross-feature endpoint runs the compiler and VM in the server process. | design | It accepts only shipped seed names (`^[a-z0-9-]+$` and present in `wings/compiler/examples/`), never source text, and caches results; arbitrary programs keep going through the Compiler wing's worker with its fuel limits. | "bridge endpoint: shipped seeds only…" |

Checked and found sound: both servers bind `127.0.0.1` only (API, Vite dev with `strictPort` and no CORS, the
production proxy); the Host guard answers 421 to DNS rebinding; WML source is capped at 64 KiB with expression
nesting capped at 64; the model language has no calls, I/O or strings; neither wing uses `eval`, `new Function`
or a shell (TLC and git are spawned with argument arrays); static files and seeds cannot leave their folders;
receipts are verified by recomputation; `npm audit --omit=dev` and `npm audit` report 0 vulnerabilities; trivy
reports 0 vulnerabilities, secrets or misconfigurations; gitleaks is clean on the full history and on the tree.

## Reporting

See [SECURITY.md](../SECURITY.md).
