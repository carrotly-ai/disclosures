# Upstream resilience

Branch: `fix/upstream-resilience`

## Acceptance criteria

- [x] Shared HTTP requests retry a transient connection failure, transient 5xx response, or HTTP 429 with a valid `Retry-After` at most once.
- [x] `Retry-After` is honored when it fits inside the caller's existing deadline; retries never extend that deadline.
- [x] Abandoned response bodies and retry waits are cancelled, and timeout errors retain the requested URL and duration without exposing headers.
- [x] Exhausted retries report the final upstream status or connection error accurately; non-retryable 4xx responses are not retried.
- [x] Representative source-adapter tests prove recovery and final typed-error behavior with deterministic fixtures.
- [x] Installed-artifact expectations reflect the bounded retry contract without weakening malformed-input or lifecycle coverage.
- [x] Node 18/20/22/24-compatible build, unit, runtime, and package checks pass.
- [ ] A focused PR is pushed, registered with T3, and its CI is watched once with a bounded timeout.

## Work

- [x] Add failing shared-HTTP and adapter regressions for timeout, connection, 429 `Retry-After`, and 5xx behavior.
- [x] Implement the smallest internal retry policy under one end-to-end deadline, preserving exported signatures and jurisdiction behavior.
- [x] Update installed-consumer assertions and testing documentation for the demonstrated contract.
- [x] Run diff/style checks, type checking, focused tests, full tests, runtime/package gates, and supported-Node verification available locally.
- [ ] Commit, push, open and register the PR; watch CI and address only in-scope failures.
