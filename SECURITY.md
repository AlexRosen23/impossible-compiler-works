# Security policy

PAPER TIGER compiles and runs untrusted programs, so security is part of the design, not an afterthought.
[docs/SECURITY.md](docs/SECURITY.md) describes the threat model, every control, the pre-release red team's
findings and fixes, and the residual risks. No software is unhackable; that document says what is defended and
what is not.

## Supported versions

Only the latest commit on `main` is supported.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for a security problem.

A useful report includes the FOLIO program, request or file that triggers the problem, what you expected, and
what happened (a crash, a hang, a wrong result, or access to something that should be unreachable). Programs that
crash, hang or exhaust memory in the compiler, the VM, the reference interpreter or the server are in scope, as
are ways to make the API act on a request from another site.

## Scope notes

- The server is designed to run on your own machine, bound to `127.0.0.1`, for one user. It has no
  authentication by design; any local program can use it (see the residual risks).
- Nothing is deployed publicly; there is no hosted instance to test against.
