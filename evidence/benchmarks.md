# Benchmarks

Machine: Apple M5 Pro × 18, 48 GiB, darwin-arm64, Node v24.14.0. Git 1e1ac35765 (dirty). Command: `node scripts/corpus.ts --bench`. Median of 5 runs, graph payload disabled.

| model | states | edges | depth | median ms | states/s | peak heap MB |
|---|---|---|---|---|---|---|
| counter-race | 13 | 14 | 4 | 0.2 | 72,931 | 10 |
| polite-livelock | 15 | 30 | 5 | 0.4 | 42,428 | 10 |
| two-phase-presumed-commit | 32 | 53 | 5 | 0.2 | 170,667 | 11 |
| state-explosion | 1000 | 2700 | 27 | 2.1 | 480,875 | 11 |
| benchmark-grid | 160000 | 608000 | 76 | 853.4 | 187,487 | 195 |
