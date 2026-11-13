# Contributing

## Branches and releases
- `main` is the reviewed line. Work on `feat/…`, `fix/…`, `chore/…` or `docs/…` branches and open a PR with
  `gh pr create`. Nothing merges without the owner's approval; the local pre-push hook refuses direct pushes to
  `main`.
- Releases are annotated tags (`git tag -a v0.1.0 -m …`). Roll back with `git revert` in a PR; never rewrite
  history.

## Setup
Node 24 or later. Then:

```bash
npm install
```

```bash
npx playwright install chromium
```

(The second command is only needed for `npm run e2e`.)

## Checks before a PR
```bash
npm run check
```

```bash
npm run e2e
```

After optimizer or generator changes, also regenerate the evidence that the docs quote:

```bash
npm run fuzz -- 2000
```

```bash
npm run bench
```

## Environment variables
`PT_PORT` (API port, default 5580), `PT_DB` (SQLite path, default `var/paper-tiger.sqlite`), `PT_STATIC=1`
(also serve the built IDE from `dist/`). No secrets are used.

## Never committed
`var/` (SQLite databases), `dist/`, `test-results/`, `.env*` files, and any personal data. Fixtures in
`examples/fixtures/` are synthetic.

## CI
`.github/workflows/ci.yml` runs typecheck, lint, tests, build and E2E on `ubuntu-latest`. GitHub Actions is
**disabled** on this repository until the owner enables it, so the workflow does not run yet.
