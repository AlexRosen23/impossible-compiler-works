# Security

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

## Reporting

This is a private portfolio project; report issues to the repository owner.
