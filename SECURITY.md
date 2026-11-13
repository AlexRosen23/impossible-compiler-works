# Security policy

THE IMPOSSIBLE COMPILER WORKS compiles and runs untrusted FOLIO programs and loads untrusted models and receipts,
so security is part of the design. [docs/SECURITY.md](docs/SECURITY.md) (Witness wing and the combined app) and
[wings/compiler/docs/SECURITY.md](wings/compiler/docs/SECURITY.md) (Compiler wing) describe the threat model,
every control, the red-team findings and fixes, and the residual risks. No software is unhackable; those documents
say what is defended and what is not.

## Supported versions

Only the latest commit on `main` is supported.

## Reporting a vulnerability

Please report it privately through GitHub's private vulnerability reporting: the repository's **Security** tab,
**Report a vulnerability**. Do not open a public issue for a security problem.

A useful report includes the program, model, receipt or request that triggers the problem, what you expected, and
what happened (a crash, a hang, a wrong verdict, or access to something that should be unreachable).

## In scope

- Programs, models or receipts that crash, hang or exhaust memory in the compiler, VM, reference interpreter,
  model checker, replay evaluator, receipt verifier or server.
- A wrong verdict presented as verified (for example a violation reported as safe, or `INCOMPLETE` shown as safe).
- Ways to make the API act on a request from another site or another local port, or to read files outside the
  served folders.
- The TLC download in `scripts/setup` accepting anything other than the pinned jar.

## Scope notes

- The server is designed for one person on their own machine, bound to `127.0.0.1`. It has no authentication by
  design; any local program can call it (see the residual risks in docs/SECURITY.md).
- Nothing is deployed publicly; there is no hosted instance to test against.
