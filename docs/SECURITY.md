# Security

Scope: `core/` and `server/`. The browser IDE in `web/` is out of scope for this document except where `core/`
states a contract for renderers.

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
  inside a compiler stage is caught by the pipeline and becomes an `ICE` diagnostic instead of crashing the host.

### 2.2 Bounded execution

All limits are in `core/limits.ts` and enforced by the core, never by the UI (`FOLIO_LANGUAGE_SPEC.md` section 13):
source size and token count, AST size, expression depth, error count, symbol count, string length, list literal
size, fixture size, iterations per frame, draws per frame, group depth, frame count and canvas size; in the VM
also fuel per frame, operand stack depth, call depth and bytecode size. The language has no recursion (rejected by
the checker, the IR verifier and the bytecode verifier) and no unbounded loop (`repeat` iterates a range or a
finite list). Call chains are bounded statically (`S004`), and block and expression nesting are bounded in the
parser (`S002`), so the parser's and the reference interpreter's host recursion is bounded too. The VM uses an
explicit frame stack, not host recursion.

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
- **Cross-site writes.** Every POST requires `content-type: application/json` (415 otherwise). Cross-origin pages
  cannot send that content type without a CORS preflight, and the server sends no CORS headers, so a browser
  blocks such requests; responses carry no `Access-Control-Allow-Origin`, so other origins cannot read them. GET
  routes have no side effects.
- **Body caps.** Request bodies are capped at 512 KiB, and at 2 MiB for `/api/reproduce` and `/api/import`.
  Past the cap the server stops keeping data but keeps reading (so the client receives a clean 413 with
  `connection: close` rather than a reset); past 16 times the cap it destroys the connection.
  `source` is capped at 64,000 characters, project names at 80, pass lists at 8 entries drawn from the known
  passes, run ids must be 16 hex characters, project ids `^[0-9a-f-]{1,36}$`.
- **Error hygiene.** Unexpected exceptions return 500 with `{"error":"internal error"}`; details go only to the
  server console.
- **Response headers.** JSON responses carry `content-type: application/json`, `cache-control: no-store`,
  `x-content-type-options: nosniff`.

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
  img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  plus `x-content-type-options: nosniff` and `referrer-policy: no-referrer`. No third-party origin is allowed;
  `style-src` permits inline styles.

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
structural verifier (opcodes, operand ranges, jump targets, consistent stack depth, terminators, no recursion,
size). The hash is not a signature: anyone can recompute it. The verifier is what stands behind it, and it is
structural, not a type checker (`VM_AND_SANDBOX.md` section 3). The server never executes supplied bytecode: it
only loads, verifies and hash-compares it, and executes bytecode it recompiled from source.

### 2.8 Receipts and import require reproduction

A receipt's `digest` covers every field except timing and creation time, so any edited field is detected.
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
| No authentication | Any local process that can reach `127.0.0.1:5580` can read and write every project and run. Accepted because the server is loopback-only and single-user. |
| Unencrypted database | `var/paper-tiger.sqlite` is a plain SQLite file (WAL mode). Anyone with file access can read or edit it. Sources and receipts are stored in clear. |
| CPU use per request | Compilation and execution run synchronously on the server's event loop. Limits bound the work, but not tightly: a run may execute up to 20,000,000 VM instructions per frame for up to 240 frames, plus the reference interpreter (which has no fuel limit; its work is bounded by the iteration, draw and size limits). A heavy request blocks the server until it finishes. There is no rate limiting or timeout. |
| Bytecode verifier is structural | A hand-crafted, re-hashed module that passes the verifier could still feed wrong-typed values to opcodes. Mitigated by never executing external bytecode in `core/` and `server/`; a future consumer that runs external bytecode would need a typed verifier. |
| Unbounded storage growth | Runs and versions are never deleted; there is no API to delete them. |
| No TLS | Plain HTTP on loopback. |
| Dependency surface | The core has no runtime dependencies. The IDE's dependencies (React, CodeMirror) and dev tooling are outside this review. |

## 4. Reporting

This is a private, single-user project. Security issues should be filed in the private repository.
