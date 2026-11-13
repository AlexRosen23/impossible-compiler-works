# Third-party notices

THE IMPOSSIBLE COMPILER WORKS is MIT-licensed ([LICENSE](LICENSE)). It combines two projects by the same author,
both MIT-licensed in the combined repository:

- **Compiler wing** (`wings/compiler/`): originally PAPER TIGER COMPILER WORKS, MIT License, Copyright (c) 2026
  Alex Rosen. Its original licence text is kept at [wings/compiler/LICENSE](wings/compiler/LICENSE). History is
  preserved in this repository (merged from `paper-tiger-compiler-works` main `492a916`).
- **Witness wing** (root `src/`, `web/`, `examples/`): originally THE IMPOSSIBLE WITNESS by the same author,
  released under the MIT License with this combined repository.

## Not included, fetched on request

- **TLC / tla2tools.jar** v1.7.4 from [tlaplus/tlaplus](https://github.com/tlaplus/tlaplus), MIT License.
  `scripts/setup` downloads it over HTTPS and refuses it unless its SHA-256 matches the pin in `scripts/setup`
  and `src/core/tla/tlc.ts`. It is git-ignored and never redistributed here.
- **A JVM container image** (optional) used to run TLC when no host Java exists. It is referenced by digest in
  `src/core/tla/tlc.ts` and used only if already present locally; TLC runs in it with `--network none`.

## npm dependencies

Runtime (bundled into the web UI): React and React DOM (MIT), CodeMirror 6 packages (MIT), Lezer highlight (MIT).
Development only: TypeScript (Apache-2.0), Vite and @vitejs/plugin-react (MIT), Vitest (MIT), Playwright and
@axe-core/playwright (Apache-2.0 / MPL-2.0), ESLint and typescript-eslint (MIT), globals (MIT), @types (MIT).
Exact versions are pinned in `package-lock.json`. Licences across the whole locked tree (dev included, as of this
commit): MIT 176, Apache-2.0 19, MPL-2.0 14 (axe-core, lightningcss platform builds), ISC 10, BSD-2/3-Clause 8,
BlueOak-1.0.0 2, 0BSD 1, CC-BY-4.0 1 (caniuse-lite data). Only the runtime packages above ship in the built UI.
