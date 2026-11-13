# PAPER TIGER COMPILER WORKS

*A language laboratory where programs become living diagrams.*

PAPER TIGER is a complete, small programming-language implementation with a browser workshop that makes the
machinery visible. Its language, **FOLIO**, is a typed DSL for data-driven generative diagrams and time-based
visual stories. Everything between the source text and the pixels is real, testable code:

```
source → tokens → AST → typed AST → register IR → optimized IR → verified bytecode → bounded VM → scene
                                         └──────────── independent AST reference interpreter (the oracle) ─┘
```

- **Hand-written front end:** a lexer and a recursive-descent parser with exact spans, expected-token diagnostics
  and error recovery; a static checker with lexical scopes, typing, definite-return analysis, a recursion check
  and documented diagnostic codes.
- **Middle end:** a typed IR in basic blocks with single-assignment registers, checked by a verifier
  (single definition, dominance, arity, slots) after every pass. Three optimization passes: constant folding
  with propagation, dead-code elimination, and CSE with copy propagation. Each has written legality rules.
- **Back end:** stack bytecode with a sha256 content hash. A verifier checks opcodes, operands, jump targets and
  stack depth. A sandboxed VM runs with fuel, stack and call-depth limits and has no host access beyond pure
  built-ins.
- **Proof:** a tree-walking reference interpreter that shares no evaluation code with the IR, optimizer or VM.
  On top of it: differential tests across 7 pass configurations, a seeded type-directed fuzzer with a reducer,
  a deliberately wrong optimization that the oracle catches, and run receipts that reproduce from scratch and
  reject tampering.
- **Workshop:** eight modes in one IDE (Editorial, Syntax Furnace, Type Observatory, Lowering Floor,
  Optimization Duel, Bytecode Theater, Failure Gallery, Proof Cabinet), backed by a loopback API with SQLite
  project history.

![Optimization Duel](evidence/screenshots/03-optimization-duel.png)

## Quick start

Node 24 or later. No native add-ons: SQLite is `node:sqlite`, and TypeScript runs through Node's type stripping.

```bash
npm install
```

```bash
npm start
```

Then open http://127.0.0.1:5580. `npm start` builds the IDE and serves it with the API from one loopback
process. For development with hot reload, run `npm run server` (API on 127.0.0.1:5580) and `npm run web`
(IDE on 127.0.0.1:5581) in two terminals.

## Commands

| command | what it does |
|---|---|
| `npm test` | 126 unit, differential, fuzz, optimizer, bytecode, debugger, receipt, regression, security and API tests (Vitest) |
| `npm run e2e` | 10 Playwright tests against the production build, covering the six required demonstrations; saves screenshots to `evidence/screenshots/` |
| `npm run fuzz -- 2000` | differential fuzz campaign (reference vs VM, optimizations off and on); writes `evidence/fuzz-summary.json` |
| `npm run bench` | interleaved VM benchmark, optimizations off vs on; writes `evidence/benchmarks.json` |
| `npm run receipt -- examples/02-rainfall-ledger.folio` | writes a receipt and bytecode artifact to `evidence/receipts/` |
| `npm run reproduce -- <receipt.json> [bytecode.json]` | recompiles and re-runs in a fresh process; exit code 1 on any mismatch |
| `npm run folio -- <file.folio> --opt --ir --bc` | command-line compiler: stage table, IR, disassembly, VM vs reference |
| `npm run check` | typecheck, lint, tests, build |

## A FOLIO program

```folio
data rain: List<Number> from "rainfall";

fn barHeight(mm: Number, peak: Number, room: Number) -> Number {
  return mm / peak * room;
}

scene "Rainfall Ledger" size 800 x 480 background #101013 {
  var i = 0;
  repeat mm in rain {
    let h = barHeight(mm, 110, 300);
    rect(x: 70 + i * 56, y: 400 - h, width: 38, height: h, fill: #98abb9, corner: 2);
    i = i + 1;
  }
  assert len(rain) == 12, "a year of data";
}
```

The 13 programs in [`examples/`](examples) all compile and run. In every one, the optimized VM's output is
byte-identical to the reference interpreter's, and the tests enforce this. [`examples/failures/`](examples/failures)
holds 14 red-team cases, each declaring the diagnostic or fault it must produce and the exact position.

## Documentation

- Language: [FOLIO_LANGUAGE_SPEC](docs/FOLIO_LANGUAGE_SPEC.md) · [TYPE_SYSTEM](docs/TYPE_SYSTEM.md) · [LIMITATIONS](docs/LIMITATIONS.md)
- Compiler: [ARCHITECTURE](docs/ARCHITECTURE.md) · [COMPILER_PIPELINE](docs/COMPILER_PIPELINE.md) · [INTERMEDIATE_REPRESENTATION](docs/INTERMEDIATE_REPRESENTATION.md) · [VM_AND_SANDBOX](docs/VM_AND_SANDBOX.md) · [OPTIMIZATION_CORRECTNESS](docs/OPTIMIZATION_CORRECTNESS.md) · [DEBUGGER_DESIGN](docs/DEBUGGER_DESIGN.md)
- Product: [PRODUCT](docs/PRODUCT.md) · [DESIGN_SYSTEM](docs/DESIGN_SYSTEM.md) · [RECRUITER_DEMO](docs/RECRUITER_DEMO.md) · [PORTFOLIO_CASE_STUDY](docs/PORTFOLIO_CASE_STUDY.md)
- Evidence: [TEST_AND_EVIDENCE](docs/TEST_AND_EVIDENCE.md) · [BUILD_LEDGER](docs/BUILD_LEDGER.md) · [SECURITY](docs/SECURITY.md) · [EXISTING_WORK_AUDIT](docs/EXISTING_WORK_AUDIT.md) · [CONSTELLATION_INTEGRATION](docs/CONSTELLATION_INTEGRATION.md)

## Security

PAPER TIGER runs untrusted programs, so every program's total work and memory are bounded by the core, server
jobs run on a worker thread with a time and memory limit, and the API refuses requests from other sites. Before
the repository went public, a three-part red team attacked the server, the compiler and VM, and the IDE; every
finding was fixed and became a regression test. No software is unhackable: [docs/SECURITY.md](docs/SECURITY.md)
lists the controls, the red-team findings and the residual risks. To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Status

v0.2, loopback only. Nothing is deployed: it runs on your own machine. The name FOLIO is used descriptively; no
exclusivity is claimed. MIT licensed ([LICENSE](LICENSE)).
