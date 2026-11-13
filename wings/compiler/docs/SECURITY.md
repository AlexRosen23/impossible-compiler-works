# Security

Scope: `core/`, `server/` and, since the pre-release red team (section 5), the browser IDE in `web/` and the
repository's supply chain.

No software is unhackable, and this document does not claim it. It states what is defended, how, how it was
attacked before the repository went public, and what remains (section 3).

## 1. Threat model

Deployment assumption: a single user running the API on their own machine, bound to `127.0.0.1`, with the IDE
in a local browser. There are no accounts.

| Asset | Threat |
|---|---|
| The host process (CPU, memory, stack) | a hostile or careless FOLIO program, an oversized or malformed request, a crafted import bundle |
| Files on the host | path traversal through fixture names or static-file URLs |
| The API and its database | other web pages open in the same browser (cross-site requests, DNS rebinding) |
| The browser tab rendering a scene | script or markup injection through program strings or stored scenes |
| Integrity of recorded runs | edited receipts, sources, fixtures or bytecode presented as genuine |

Untrusted inputs: FOLIO source text, fixture tables, receipts, export bundles, serialized bytecode, HTTP requests.

## 2. Controls

### 2.1 Untrusted source is data

- FOLIO source is only ever lexed, parsed, checked, compiled and executed by `core/`. There is no `eval`,
  `new Function`, dynamic `import`, `child_process`, `fetch` or `require` in `core/`, `server/` or `scripts/`.
- A program can reach only the pure built-ins, the scene builder and read-only datasets
  (`VM_AND_SANDBOX.md` section 5). No I/O, clock, randomness or host objects.
- The lexer, parser and checker never throw on bad input (they produce diagnostics); any unexpected exception
  inside a compiler stage, including hashing the stage's output, is caught by the pipeline and becomes an `ICE`
  diagnostic instead of crashing the host. The red team's hostile inputs (section 5) produce diagnostics, not ICEs.
- Every lookup table a program's names can reach (built-ins, constants, primitives, the call graph, the server's
  fixture library) has no prototype, so `toString`, `constructor` or `__proto__` are ordinary names.
- Source that is not valid Unicode (an unpaired surrogate) is rejected first (`L008`), so a source hash names
  exactly one program.

### 2.2 Bounded execution

All limits are in `core/limits.ts` and enforced by the core, never by the UI (`FOLIO_LANGUAGE_SPEC.md` section 13).
The rule is that the total work and memory of any run are bounded, not just each frame's:

- **Compile time:** source size and token count, AST size, measured expression-tree height (operator chains
  count), block nesting, error count (lexer, parser and checker), symbol count, string length, list literal size,
  fixture size, frame count and canvas size.
- **Both executors, identically:** iterations per frame (`R004`), user-function calls per frame (`R013`), draws
  per frame and scene size per frame and per run (`R005`, checked before anything is copied), string length,
  group depth.
- **VM:** instructions per frame and per run, call-frame cells per frame (`R006`), operand stack, call depth,
  bytecode size.
- **Reference interpreter:** evaluation steps per frame and per run (`R014`).
- **Host stack:** the checker bounds the reference interpreter's deepest recursion through calls (`S005`); every
  pass that walks a whole tree without that bound (node counting, expression height, the bytecode call-graph check)
  is iterative. A host stack overflow in the interpreter, if one ever happened, is reported as `R014`.

The language has no recursion (rejected by the checker, the IR verifier and the bytecode verifier) and no
unbounded loop (`repeat` iterates a range or a finite list). The VM uses an explicit frame stack, not host
recursion.

On the server, a third bound sits outside the language: every job that compiles or runs a program (recording a
run, reproducing a receipt, building an export bundle) runs on a worker thread (`server/jobs.ts`,
`server/worker.ts`) with a 15-second wall-clock limit and a 512 MB heap cap. A job past its time is stopped by
terminating the worker (422, or 503 for a bundle); a job that exhausts its heap kills only its worker. Either way
the next job gets a fresh worker and the API keeps answering. At most 8 jobs wait; the next gets 503. All three
behaviours are tested (`tests/server.test.ts`).

### 2.3 Fixture names are not paths

A `data` declaration names a fixture by an identifier matching `^[a-z][a-z0-9_-]{0,63}$`; there is no path syntax.
The core resolves names against a table the host passes in. The server builds its library only from
`examples/fixtures/*.json` files whose names match the same pattern, accepts fixture lists only of library names,
and validates inline fixture tables (at most 16 entries, valid names, arrays of at most 10,000 items; element
types are then checked by the core's fixture loader). A request naming `../../etc/passwd` is rejected with 400
(tested).

### 2.4 HTTP API

- **Loopback bind.** `server/index.ts` listens on `127.0.0.1` only.
- **Host header check (DNS rebinding).** Every API request whose `Host` header is not `127.0.0.1`, `localhost` or
  `[::1]` (optionally with a port) is refused with 421 (tested with `evil.example:5580`).
- **Cross-site requests.** Browsers label every request with `Sec-Fetch-Site`. Any request labelled other than
  `same-origin` or `none` (a typed-in URL) is refused with 403 before any work is done, including GETs: another
  site, or a page on another local port, cannot make the server recompile a stored run. Any non-GET request whose
  `Origin` is present and is not the server's own origin is refused with 403. Every POST also requires
  `content-type: application/json` (415 otherwise), the server sends no CORS headers, and OPTIONS is 404.
  Non-browser clients (the Constellation's reader, curl, the tests) send neither header and are unaffected.
- **Slow clients.** Headers must arrive within 15 s and a whole request within 30 s; at most 64 sockets.
- **Storage caps.** The newest 2,000 runs are kept (older ones are pruned on insert); at most 1,000 projects and
  1,000 versions per project (413 past either).
- **Body caps.** Request bodies are capped at 512 KiB, and at 2 MiB for `/api/reproduce` and `/api/import`.
  Past the cap the server stops keeping data but keeps reading (so the client receives a clean 413 with
  `connection: close` rather than a reset); past 16 times the cap it destroys the connection.
  `source` is capped at 64,000 characters, project names at 80, pass lists at 8 entries drawn from the known
  passes, run ids must be 16 hex characters, project ids `^[0-9a-f-]{1,36}$`.
- **Error hygiene.** Unexpected exceptions return 500 with `{"error":"internal error"}`; details go only to the
  server console.
- **Response headers.** JSON responses carry `content-type: application/json`, `cache-control: no-store`,
  `x-content-type-options: nosniff`.
- **Dev server.** The Vite dev server (`web/vite.config.ts`, 127.0.0.1:5581) has CORS off (Vite's default would
  let any localhost page read the proxied API) and sends the same `frame-ancestors` rule as the built IDE.

### 2.5 Static files (`PT_STATIC=1` only)

- Paths are percent-decoded inside a `try`: malformed percent-encoding (for example `/%E0%A4%A`) is answered
  with 400 `bad URL` instead of throwing. Before this fix, `decodeURIComponent` ran outside any `try`, and such a
  request terminated the Node process; any web page open in the browser could have triggered that with a link
  or image. Static serving is now its own module, `server/static.ts`, tested in `tests/static.test.ts`
  (malformed encoding → 400; `..`, encoded `..` and backslash traversal never leave `dist/`).
- Decoded paths are normalized, stripped of leading slashes and resolved inside `dist/`; a resolved path that
  does not start with `dist/` (or does not exist, or is a directory) falls back to `dist/index.html`.
- The static path does not apply the API's Host-header check; it serves only files from `dist/`.
- Static responses carry a Content Security Policy:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self';
  img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors http://127.0.0.1:4520 http://127.0.0.1:4521 http://localhost:4520 http://localhost:4521`,
  plus `x-content-type-options: nosniff` and `referrer-policy: no-referrer`. No third-party origin is allowed;
  `style-src` permits inline styles.
- Framing: only the Constellation's own loopback origins (its API on 4520, its Vite dev server on 4521) may frame
  the IDE, so its world can open the IDE inside itself. Until 2026-11-12 this was `frame-ancestors 'none'` and the
  world opened the IDE in its own tab. Any other page, including any site on the open web, still cannot frame it
  (`tests/static.test.ts` pins the exact list). The trade-off: a page served from one of those four loopback
  origins could frame the IDE and try to trick a click; those origins are the Constellation's, on this machine.

### 2.6 Scene output

- The scene builder quantizes numbers, writes colours as `#rrggbbaa` and bounds the number of commands
  (`core/scene.ts`).
- `validateScene` is the renderer-side check for any buffer (never trust a stored scene): known format, canvas size
  in range, a `background` matching `#RRGGBB` or `#RRGGBBAA`, frame count, command count, known primitive kinds,
  a finite 6-number transform, opacity `o` in [0, 1], finite numeric arguments, colour strings matching
  `#[0-9a-f]{8}` for every string argument except `value`, every point in an array argument (`line` endpoints,
  `path` points) a pair of finite numbers, and string length. Tested: a command whose `fill` is
  `url(javascript:alert(1))` and whose transform contains NaN is rejected, and (`tests/regressions.test.ts`) a bad
  background, an out-of-range opacity and a non-finite point coordinate are rejected.
- `core/scene.ts` states the renderer contract: renderers consume only validated buffers and draw text with
  canvas `fillText`, so FOLIO strings never become HTML or CSS. The renderer lives in `web/` and is not reviewed
  here.

### 2.7 Bytecode integrity

Serialized bytecode carries a SHA-256 content hash. `loadBytecode` checks format, version and hash, then runs the
structural verifier: header and scene fields (size, frames, background), table sizes (functions, constants, data,
registers, slots), whole-number operands in range, jump targets, consistent stack depth, terminators, no recursion
(checked iteratively) and total size. It returns a list of problems for any input, however malformed, and never
throws (tested with nine crafted modules and a 2,000-function chain). The hash is not a signature: anyone can recompute it. The verifier is what stands behind it, and it is
structural, not a type checker (`VM_AND_SANDBOX.md` section 3). The server never executes supplied bytecode: it
only loads, verifies and hash-compares it, and executes bytecode it recompiled from source.

### 2.8 Receipts and import require reproduction

A receipt's `digest` covers every field except timing and creation time, so any edited field is detected.
Before anything is hashed or compiled, `receiptShape` checks the receipt's shape: a source string within the
source limit, at most 16 flat fixture tables, at most 8 known pass names, bounded hash and name strings. Past
that, `reproduce` reports any failure as a failed check and never throws. Fixtures store `-0` as `0`, because
the fixture hash cannot tell them apart and a program can.
`/api/import` runs the full `reproduce` (recompile, re-run VM and reference interpreter, compare every hash) and
creates a project only if every check passes; otherwise it answers 422 with the failing checks (tested with an
edited bytecode constant and an edited source). Like the bytecode hash, the digest detects edits but does not
prove authorship.

Receipt limits cannot raise the host's limits. `reproduce` accepts a receipt's `limits` entry only if it names a
known limit and is a whole number from 1 up to this host's default; any other entry fails the check "receipt
limits within this host's caps" and reproduction stops before compiling anything. Before this fix, `reproduce`
merged the receipt's limits over the defaults unchecked, so a crafted receipt sent to `/api/reproduce` or
`/api/import` could raise fuel, iterations, source size or any other limit. Tested in
`tests/regressions.test.ts`.

## 3. Residual risks

Stated plainly; none of these is mitigated in the current code.

| Risk | Detail |
|---|---|
| No authentication | Any local process that can reach `127.0.0.1:5580` can read and write every project and run. Accepted because the server is loopback-only and single-user. Browsers are kept out by the checks in section 2.4; local programs are not. |
| Unencrypted database | `var/paper-tiger.sqlite` is a plain SQLite file (WAL mode). Anyone with file access can read or edit it. Sources and receipts are stored in clear. |
| CPU per request | Every program's work is bounded (section 2.2) and server jobs stop at 15 s, but a local process can still keep the one compile worker busy with a stream of legal heavy programs. There is no rate limiting. |
| The browser IDE runs programs in its own tab | The IDE compiles and runs on the page's main thread. The core's limits bound that work, but a hostile project opened in the IDE can make the tab slow for a few seconds per frame before a limit stops it. |
| Bytecode verifier is structural | A hand-crafted, re-hashed module that passes the verifier could still feed wrong-typed values to opcodes; the VM checks `LEN` and charges frame allocation, but is not fully type-safe against crafted code. Mitigated by never executing external bytecode in `core/`, `server/` or `web/`; a future consumer that runs external bytecode would need a typed verifier. |
| `style-src 'unsafe-inline'` | CodeMirror injects a style element, so the CSP allows inline styles. No HTML injection was found to pair it with (section 5). |
| No TLS | Plain HTTP on loopback. |
| Dependency surface | The core has no runtime dependencies. The IDE has 9 direct runtime dependencies (React and CodeMirror; 17 production packages). `npm audit` reports 0 findings for production and development dependencies (a `minimatch` override in `package.json` pins the patched version for the lint toolchain). |

## 4. Reporting

Please report a vulnerability privately through GitHub's "Report a vulnerability" (security advisories) on the
repository, not in a public issue. See [`../SECURITY.md`](../SECURITY.md).


## 5. Pre-release red team (2026-11-12)

Before the repository went public, three independent reviewers attacked a live copy, each with a different
scope: the HTTP server, the compiler and VM sandbox, and the browser IDE with the supply chain. Every finding was
reproduced, fixed and turned into a regression test (`tests/security.test.ts`, `tests/server.test.ts`,
`e2e/ide.spec.ts`). Nothing found reached `eval`, `Function`, dynamic import, the file system or
`Object.prototype`, and no XSS was found.

| # | Severity | Finding (as reproduced) | Fix |
|---|---|---|---|
| 1 | critical | An 11 KB program (a 1,000-point path drawn 10,000 times per frame for 240 frames) ran the process out of memory (4.4 GB, uncatchable); a variant with long texts threw from hashing | Scene-size budget per frame and per run (`R005`), checked before copying |
| 2 | high | A 3.5 KB program whose calls double at each level hung the reference interpreter (and the server, synchronously) without bound; SECURITY.md wrongly said its work was bounded | User-function call limit in both executors (`R013`); interpreter fuel per frame and per run (`R014`); server jobs on a worker with a 15 s limit |
| 3 | medium | `/api/reproduce` and `/api/import` accepted 20,000 optimization passes: a 25 s stall per file | `receiptShape` allows at most 8 known passes |
| 4 | medium | A 3,000-term `1 + 1 + ...` threw a `RangeError` out of `compile()`; 40 functions of 200-term chains overflowed the interpreter | Iterative expression-height check (`S002`); static interpreter stack bound (`S005`); stage hashing inside the guard |
| 5 | medium | Crafted bytecode crashed the verifier (fractional operand, null function, 20,000-function chain) or passed it and crashed the VM | Verifier checks whole-number operands, headers and table sizes, runs iteratively and never throws; VM checks `LEN` and charges frame allocation |
| 6 | medium (dev only) | Through the Vite dev server, any page on a localhost port could read and write the API | Dev CORS off; `Sec-Fetch-Site` and `Origin` checks on the API |
| 7 | low | A cross-site `<img>` GET of `/api/runs/{id}/bundle` made the server recompile a stored heavy run | Cross-site requests refused before any work; bundle built on the worker |
| 8 | low | `fn toString(...)`, the fixture name `constructor`, and similar names reached inherited properties (internal compiler error, or a run its own import rejected) | Prototype-free lookup tables; `Object.hasOwn` |
| 9 | low | A fixture `[-0]` and `[0]` hashed the same but drew different scenes, so an imported receipt could verify one scene and re-run another | Fixtures store `-0` as `0` |
| 10 | low | 2,600 checker diagnostics took 10 s (edit-distance suggestions for every error); the lexer reported 20,002 | Diagnostics capped at `maxErrors` (`S006`); suggestions capped |
| 11 | low | Malformed receipts (`source: {}`, deep fixtures) threw from `reproduce` | Shape check first; failures become failed checks |
| 12 | low | A crafted `#/editorial/project/..%2F..%2Fapi%2Fcorpus` deep link made the IDE fetch other API paths | Project ids validated before use; `encodeURIComponent` in the fetch |
| 13 | low | Storage grew about 9 bytes per request byte, without limit; slow clients could hold a body open for 5 minutes | Run pruning, project and version caps; 15 s header and 30 s request timeouts |
| 14 | low | `npm run fuzz -- --help` overwrote `evidence/fuzz-summary.json` with zeros | Arguments validated; `--help` prints usage |
| 15 | info | Two sources (a lone surrogate, and U+FFFD in its place) shared a source hash | Invalid Unicode rejected (`L008`) |
| 16 | supply chain | 10 moderate dev-only advisories (`minimatch` via the lint toolchain) | `overrides` pins `minimatch` ^11.0.8; `npm audit`: 0 |

What held up under attack, and still does: the Host-header check against every rebinding variant tried; 415 for
every simple-request content type; parameterized SQL everywhere; static-file traversal (encoded, double-encoded,
backslash); the receipt limits clamp; parser error recovery (20,000 stray `}` give 51 diagnostics in 4 ms); 5,000
extra differential fuzz runs and 10,000 mutants with 0 divergences; every XSS payload rendered as text across all
eight modes with the CSP on and off; no `innerHTML`, `eval` or `postMessage` in the IDE; gitleaks and semgrep
clean.
