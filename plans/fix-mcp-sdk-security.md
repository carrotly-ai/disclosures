# MCP SDK security remediation

## Acceptance criteria

- Consume SDK 1.31.0 or a compatible patched 1.x release, with no affected lock copies.
- Clear all advisories in the installed production and development graph using compatible targeted updates.
- Preserve the public library, stdio and HTTP protocol contracts without product authentication changes.
- Reproduce the issuer-isolation defect using fictional credentials and injected fetch only.
- Pass the repository PR gates and publish one reviewed commit/PR for parent review.

## Checklist

- [x] Confirm active repository, exclusive clean clone, fetched default, no existing repair PR, and applicable guidance.
- [x] Install frozen baseline; reproduce SDK and transitive audit findings; pass 1,196 baseline tests.
- [x] Add and run an inert issuer-isolation regression against the vulnerable SDK.
- [x] Patch the exact SDK pin and affected transitive lock entries within supported ranges; audit the complete graph.
- [x] Run frozen install, typecheck, full tests, build, stdio, Node runtime and packed-consumer gates.
- [x] Review the full diff and prepare the atomic commit and single-PR handoff.

## Evidence and decisions

Baseline is origin/main 8d38976. Bun 1.3.14 is pinned in CI. Node support remains >=18.
The full baseline audit reports SDK 1.30.0 plus fast-uri, hono, ip-address, proxy-addr and qs.
SDK imports in product source implement the MCP server; client scripts/tests do not configure OAuth providers.
The regression exercises upstream OAuth credential isolation without adding product OAuth behavior.
All provider requests in the regression are injected; protocol gates use loopback and existing fictional fixtures.
Live-source canaries, release/publish workflows and real providers are outside this isolated validation.

The regression fails with SDK 1.30.0 (credential request accepted for a mismatched issuer) and passes with 1.31.0.
Targeted lock updates: fast-uri 3.1.8, hono 4.13.7, ip-address 10.7.4, proxy-addr 2.0.8 and qs 6.16.0.
Registry integrity metadata was retained; every update satisfies the immediate parent range.
The graph has one lock entry per affected package. A fresh frozen install confirms each actual parent resolution.
The baseline contains 18 advisories (1 critical, 6 high, 11 moderate); the patched full-graph audit returns {}.

Fresh-install validation: typecheck, all 1,198 tests (43 files), build and the separate stdio gate pass.
Built runtime and installed packed-package gates pass on Node 18.20.8, 22.23.3 and 24.18.0.
Packed-consumer gates cover declarations, Node imports, tool/resource protocol contracts, stdio EOF,
HTTP recovery, fictional upstream failures and request deadlines. No live providers are invoked.
There is no configured lint script. Hosted PR baseline and parent review remain the handoff gates.
