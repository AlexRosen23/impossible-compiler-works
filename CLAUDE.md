# CLAUDE.md — THE IMPOSSIBLE COMPILER WORKS

Formerly Paper Tiger Compiler Works (now `wings/compiler/`) and The Impossible Witness (the root). Repo name
`impossible-witness` is kept for now; the Constellation contract id stays `impossible-witness`.

- Node 24 runs `.ts` directly (type stripping): **erasable syntax only** (no enums, namespaces,
  parameter properties, and no method named `declare`). Imports use `.ts` extensions.
- Ports: UI **5720** (Vite, both wings: `/` and `/compiler/`), API **5721** (Witness API + Compiler API at
  `/engine/compiler`), tests **5726–5729** (Playwright uses 5726/5727). Retired: 5580/5581/5590 (old Paper Tiger).
  Bind 127.0.0.1 only. Never pkill broadly; stop only your own PIDs.
- Run: `scripts/dev`. Test: `scripts/test` (`--e2e`, `--tlc`, `--fuzz`).
- Honesty rules are product requirements: never present `INCOMPLETE` as safe, never hard-code
  verdicts in the UI or `examples/catalog.json` (a test enforces it), label internal vs TLC checks.
- Compiler wing rules: see `wings/compiler/CLAUDE.md` (oracle independence, never JS-eval FOLIO, version bumps).
- Bridge (`bridge/pass-orders.ts`): evidence in `evidence/bridge/` must regenerate byte-for-byte (a test checks).
- Changing exploration order or trace rendering changes trace hashes: re-run
  `node scripts/corpus.ts --write-expected`, review the diff, and regenerate `evidence/demo/` with `scripts/demo`.
- `tools/tla2tools.jar` is git-ignored and pinned by SHA-256 in `src/core/tla/tlc.ts` and `scripts/setup`.
- Keep `docs/BUILD_LEDGER.md` truthful (TESTED / PARTIAL / INCOMPLETE / FAILED / NOT_BUILT / OWNER_ACTION).
- Branches + PRs only; never merge, deploy, make public or enable Actions without the owner's OK.
