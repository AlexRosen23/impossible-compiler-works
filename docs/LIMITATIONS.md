# Limitations (read this before trusting a verdict)

1. **Models, not systems.** Every verdict is about the finite model as written: its domains,
   its initial states, its atomic actions and its fairness assumptions. `VERIFIED_BOUNDED`
   means "no violation in every reachable state of this model", never "the service is correct".
   Nothing checks that an implementation refines the model.
2. **Atomicity is an assumption.** Each action is one indivisible step. If real code splits it,
   the model is optimistic; the examples show how to split actions to expose races.
3. **No time.** Steps are logical; latency, clocks, timeouts and crashes exist only as explicit
   nondeterministic actions.
4. **Finite and small.** Domains are bounded; explicit-state search stores every state.
   Beyond the caps the verdict is `INCOMPLETE`, which says nothing about unexplored states.
   There is no symbolic, symmetry or partial-order reduction.
5. **Liveness** needs a complete graph, supports only `eventually` and `leadsto`, and only
   weak/strong fairness on processes or action families. Lassos are not minimal.
6. **Independence is partial.** The replay evaluator shares the parser with the explorer. TLC
   is fully independent but only checks what the exporter emits.
7. **TLC availability.** This Mac has no host JDK; TLC runs in a JVM container image that was
   already installed for another project. Without Docker or Java the app is `INTERNAL_ONLY`.
8. **Receipts** are tamper-evident by recomputation, not signed. A receipt proves nothing to
   someone who does not re-verify it.
9. **Rendering** draws at most 5,000 states. Counts and verdicts cover everything; the UI says
   when the drawing is truncated.
10. **Shipped examples** are teaching models, deliberately tiny (one unit of stock, two
    transfers, one message) so that every state can be inspected. They are inspired by common
    failure modes, not extracted from any real system, and no existing project or live
    infrastructure was read or connected.
11. **Single user, loopback only**, no authentication.
12. **Benchmarks** are from one machine and were measured while other work was running; treat
    them as orders of magnitude.
