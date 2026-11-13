# Existing work audit (2026-11-12)

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

Checked before building, from source code (not READMEs), read-only. No existing system was
read, written or connected during any check; the shipped examples are self-contained models.

## Did `impossible-witness` already exist?

No. No local project folder existed and
`gh repo view AlexRosen23/impossible-witness` returned "Could not resolve". Built from scratch.

## Neighbouring projects

| project | what it really implements (evidence) | how THE IMPOSSIBLE WITNESS differs |
|---|---|---|
| **QUORUM** (Go) | three real `quorum-node` processes on hashicorp/raft + bbolt (`internal/node/node.go`, `internal/kv/fsm.go`); a fault lab (`cmd/quorum-lab`) that kills and partitions nodes at scripted points; linearizability check of one recorded history with Porcupine (`internal/lincheck`) | QUORUM observes **one** real, wall-clock run and judges its history. The Witness enumerates **every** schedule of a model and returns the shortest bad one. |
| **CURRENT//ZERO** (TS, Kafka) | generator, windowing, sink and an independent oracle that recomputes windows from seeded events (`core/oracle.ts`) | compares one seeded stream to a reference; no state or ordering exploration |
| **AEROLITH** (TS) | in-memory SQS/DynamoDB semantics (visibility timeout, DLQ, conditional writes) and six scripted failure scenarios (`core/workloads.ts`) | hand-picked scenarios with deterministic outcomes; the Witness searches all interleavings (its queue/idempotency examples are independent toy models inspired by the same failure class) |
| **FERRITE** (Rust) | LSM key-value engine; ~7 hand-listed crash-point tests (`tests/faults.rs`) and a proptest of random op sequences against a `BTreeMap` (`tests/model.rs`) | closest in spirit (systematic crash points) but sequential and sampled; no visited-state search, no concurrency |
| **Paper Tiger Compiler Works** (TS) | lexer, parser, checker, bytecode VM, reference interpreter, fuzzer and reducer for the FOLIO language | a programming language + differential testing; the Witness's WML is deliberately *not* a programming language (no calls, no I/O) and its "checking" is exhaustive state search |

A search of the author's other projects and the Constellation repository found no `.tla`
files, no TLC usage and no model checker. Constellation's `docs/FEATURES.md` lists no
formal-verification world.

## Conclusion

The new app models and explores **possible schedules** of an abstract finite system. It is not
another distributed store, job runner, language, or incident dashboard, and it never talks to
the systems above. Ideas it borrows: QUORUM's "check a history against a model" (here: replay a
trace against the transition relation), Paper Tiger's "independent reference interpreter"
(here: the replay evaluator), FERRITE's "name the failure point" (here: shortest witness).
