# Contributing

1. `scripts/setup`, then `scripts/doctor`.
2. Branch from `main` (`feat/`, `fix/`, `chore/`, `docs/`).
3. `scripts/test` must pass; run `scripts/test --e2e` for UI changes and `scripts/test --tlc`
   for anything touching semantics, the exporter or the TLC adapter.
4. New example: add `examples/<slug>.witness`, reference it from `examples/catalog.json`
   (teaching text only, never verdicts), run `node scripts/corpus.ts --write-expected` and
   review the new expectation by hand.
5. Update `docs/BUILD_LEDGER.md` and any doc whose claims changed. Open a PR; do not merge your own.
