# Contributing

THE IMPOSSIBLE COMPILER WORKS has two wings in one repository: the Witness wing (root `src/`, `web/`, `examples/`)
and the Compiler wing (`wings/compiler/`), plus `bridge/` between them. Node 24+ runs the TypeScript directly
(type stripping), so use erasable syntax only and `.ts` import extensions.

1. `scripts/setup`, then `scripts/doctor` (what this machine can do: TLC via Docker or Java?).
2. `scripts/dev` serves both wings: UI http://127.0.0.1:5720 (`/` and `/compiler/`), API 127.0.0.1:5721.
3. Branch from `main` (`feat/`, `fix/`, `chore/`, `docs/`).
4. `scripts/test` must pass (typecheck, lint, all unit suites, receipts). Add `--e2e` for UI changes (Playwright on
   127.0.0.1:5726/5727), `--tlc` for anything touching WML semantics, the TLA+ exporter or the TLC adapter, and
   `--fuzz` for anything touching the FOLIO compiler, optimizer or VM.
5. Witness wing example: add `examples/<slug>.witness`, reference it from `examples/catalog.json` (teaching text
   only, never verdicts), run `node scripts/corpus.ts --write-expected` and review the expectation by hand.
6. Compiler wing: keep the reference interpreter independent (`core/interpreter.ts` must not import the IR,
   optimizer, bytecode or VM). A new optimization pass needs its legality rule in
   `wings/compiler/docs/OPTIMIZATION_CORRECTNESS.md`, `npm test`, `npm run fuzz -- 2000`, and a re-run of
   `npm run pass-check` (all seeds) so the Witness wing checks it in every pass order.
7. Changing the optimizer or the bridge changes `evidence/bridge/`: regenerate with
   `node bridge/pass-orders.ts 13-optimizer-bench fault-lab-commute --write evidence/bridge` (and again with
   `--mutant`); a test fails until the evidence matches.
8. Update `docs/BUILD_LEDGER.md` and any doc whose claims changed. Open a PR; do not merge your own.

Security problems: see [SECURITY.md](SECURITY.md), not the issue tracker.
