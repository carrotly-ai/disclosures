# Audit remediation

Branch: `fix/audit-hardening`

Acceptance criteria: all eleven audit reproductions fail safely or return correct data; adapter cache expiry and failures are safe; clean package consumers compile; fresh bundles exercise both transports on supported Node runtimes; scheduled source canaries report failures explicitly. Preserve existing supported routes and tests.

- [x] Correct ESEF values, amendments, and units; propagate SEC failures; exhaustively reject non-US raises.
- [x] Enforce response-body deadlines and streaming document caps across adapters.
- [x] Enforce HTTP host/origin/access policy and centralize exclusive, confined PDF writes.
- [x] Correct process-cache expiry and make persistent cache writes atomic and best-effort.
- [x] Fix published declaration dependencies, pin tooling, and validate fresh package/runtime builds.
- [x] Add bounded scheduled source canaries; document contracts and resolve audit findings.
- [x] Run focused regressions, full suite, isolated consumer and supported-runtime checks; commit validated work.


Validation: 1,151 offline tests and 4,393 assertions passed; pinned typecheck, fresh build, and isolated npm-consumer compile passed. Both transports passed under Node 18.20.8, 20.20.2, 22.23.2, and 24.18.0. GLEIF, filings.xbrl.org, HKEXnews, and TWSE live canaries reported healthy. Full credentialed E2E was not run.

Implementation commits: `d09c453` (data integrity and routing), `6e47b50` (transport, downloads, cache, packaging, and regressions). CI/release gates and deployment documentation accompany the final documentation commit. No push or release performed.
