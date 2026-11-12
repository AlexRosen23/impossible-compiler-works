# PAPER TIGER COMPILER WORKS: notes for Claude

- **What it is:** FOLIO language + compiler + VM + reference interpreter (`core/`), loopback API (`server/`),
  browser IDE (`web/`). `core/` is isomorphic: no Node APIs in it (the IDE imports it directly).
- **Ports:** API 127.0.0.1:5580 (also serves `dist/` with `PT_STATIC=1`), Vite dev 127.0.0.1:5581, E2E 5590.
- **Never** evaluate FOLIO with JS eval/Function. Untrusted source only goes through `core/`.
- **Every semantic change must keep the oracle independent:** `core/interpreter.ts` must not import `ops.ts`,
  `ir.ts`, `optimize.ts`, `bytecode.ts` or `vm.ts`. If you change an operator, change it in both places and
  add a differential test.
- **New optimization pass:** write its legality rule in `docs/OPTIMIZATION_CORRECTNESS.md`, add it to
  `optimize.ts`, run `npm test` and `npm run fuzz -- 2000`; the IR verifier runs after every pass.
- **New diagnostic code:** add it to `DIAGNOSTIC_CODES` and to the table in `docs/TYPE_SYSTEM.md` (a test checks).
- **Version bumps:** any change to grammar, IR, bytecode, scene or receipt format bumps `core/version.ts`.
- **Evidence:** benchmark and fuzz numbers in docs must come from `evidence/*.json`; regenerate them after
  optimizer changes (`npm run bench`, `npm run fuzz -- 2000`).
- **Repo rules:** feature branches + PRs; never merge without the owner's OK; Actions are off (the CI file is
  dormant until the owner enables Actions).
- **Before claiming done:** `npm run check` and `npm run e2e`.
