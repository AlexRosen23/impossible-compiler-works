# CLAUDE.md — The Impossible Witness

- Node 24 runs `.ts` directly (type stripping): **erasable syntax only** (no enums, namespaces,
  parameter properties, and no method named `declare`). Imports use `.ts` extensions.
- Ports: UI **5720**, API **5721**, tests 5722–5729 (assigned by the integration session). Bind 127.0.0.1 only.
- Run: `scripts/dev`. Test: `scripts/test` (`--e2e`, `--tlc`). Never pkill broadly; stop only your own PIDs.
- Honesty rules are product requirements: never present `INCOMPLETE` as safe, never hard-code
  verdicts in the UI or `examples/catalog.json` (a test enforces it), label internal vs TLC checks.
- Changing exploration order or trace rendering changes trace hashes: re-run
  `node scripts/corpus.ts --write-expected`, review the diff, and regenerate `evidence/demo/` with `scripts/demo`.
- `tools/tla2tools.jar` is git-ignored and pinned by SHA-256 in `src/core/tla/tlc.ts` and `scripts/setup`.
- Keep `docs/BUILD_LEDGER.md` truthful (TESTED / PARTIAL / INCOMPLETE / FAILED / NOT_BUILT / OWNER_ACTION).
- Branches + PRs only; never merge, deploy, make public or enable Actions without the owner's OK.
