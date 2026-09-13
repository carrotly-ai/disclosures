# Audit remediation

Branch: `fix/audit-hardening`

Acceptance criteria: all eleven audit reproductions fail safely or return correct data; adapter cache expiry and failures are safe; clean package consumers compile; fresh bundles exercise both transports on supported Node runtimes; scheduled source canaries report failures explicitly. Preserve existing supported routes and tests.

- [ ] Correct ESEF values, amendments, and units; propagate SEC failures; exhaustively reject non-US raises.
- [ ] Enforce response-body deadlines and streaming document caps across adapters.
- [ ] Enforce HTTP host/origin/access policy and centralize exclusive, confined PDF writes.
- [ ] Correct process-cache expiry and make persistent cache writes atomic and best-effort.
- [ ] Fix published declaration dependencies, pin tooling, and validate fresh package/runtime builds.
- [ ] Add bounded scheduled source canaries; document contracts and resolve audit findings.
- [ ] Run focused regressions, full suite, isolated consumer and supported-runtime checks; commit validated work.
