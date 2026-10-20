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

## Production release preparation — 20 October 2026

The unattended follow-up expands this existing branch and PR #81 into the single
0.9.0 release candidate. The minor release includes the already-merged India
document capability and September/October hardening. Michael retains merge and
tag publication; no automatic merge or direct push to main is permitted.

### Acceptance criteria

- [x] The complete dependency graph audits clean and the existing security regression passes.
- [x] PR/release validation audits dependencies; bounded source canaries run weekly and on demand after merge.
- [x] Main requires passing PR validation, CodeQL is configured, and Dependabot security updates are enabled.
- [x] All four version surfaces agree on 0.9.0; changelog and publishing/testing guidance match actual gates.
- [x] India ownership is either implemented from verified live structured filings with focused tests or explicitly deferred with current access/corpus evidence.
- [x] Fresh offline, runtime, installed-package, manifest and keyless source validation are recorded.
- [?] Strict credentialed live validation (blocked: the four required process/repository credentials are absent).
- [ ] The complete diff receives independent review, all changes are committed/pushed, and PR #81 has a current release handoff.

### Execution

- [x] Reuse and register PR #81; preserve the pre-existing untracked browser artifacts.
- [x] Add CI security gates, weekly monitoring, and safe publication prerequisites.
- [x] Configure and verify repository security controls.
- [x] Investigate and, where supported, implement India ownership (deferred: current API 403 and no verified XML corpus).
- [x] Prepare 0.9.0 metadata, release notes, and consistent operator guidance.
- [x] Run available fresh release validation; resolve failures without weakening checks.
- [ ] Review, ship, and write the unattended session summary with remaining merge/publication gates.

### File ownership

- Parent: release metadata, README, changelog, this plan, GitHub settings and final validation.
- Workflow agent: `.github/`, `PUBLISHING.md`, `docs/TESTING.md`.
- India agent: India adapter/tests/fixtures, IN tool/reference branches, and India jurisdiction documentation.

### Repository controls and external prerequisites

- Main protection now requires up-to-date `pr-check` from GitHub Actions and
  `CodeQL` from GitHub Advanced Security,
  pull requests, and resolved review conversations, including for administrators.
  Force pushes and deletion are disabled. Zero mandatory reviewer approvals avoids
  blocking the sole maintainer from merging their own PR; the PR/check gate still applies.
- Dependabot security updates are enabled. Bun currently supports Dependabot
  version updates but not security updates, so the full-lockfile audit remains
  essential. CodeQL default setup was enabled for
  Actions and JavaScript/TypeScript with the default queries and remote/local sources;
  both analyses passed and the API confirms a weekly schedule:
  https://github.com/carrotly-ai/disclosures/actions/runs/39430980270.
- No required live-provider variables are present in the process environment and
  `gh secret list` returns no repository secrets. No credential contents are
  inspected or copied. Bun 1.3.14 package-manager commands ignore the runtime
  `--no-env-file` flag, so subsequent install/audit validation uses a tracked-only
  temporary export with no local environment files.
  Strict credentialed live validation remains a release prerequisite; missing
  credentials must not be converted into a successful strict run.

### CodeQL trust-boundary review

The restored remote/local scan surfaced four environment-taint findings on main.
An independent reviewer and the parent checked the source, actual dataflow, and
existing adversarial tests before marking these individual alerts false positives.
No query, threat model, or security check was disabled.

- Alert 39 traces the Actions runner-owned `GITHUB_STEP_SUMMARY` destination in
  `scripts/source-canary.mjs`. Source responses and MCP clients cannot control it.
- Alerts 40–42 trace administrator-controlled `DISCLOSURES_DOWNLOAD_DIR` from
  `process.env` in `runHttpServer` into directory/file creation. The server selects
  this root before requests arrive. HTTP arguments cannot override the root;
  requested names reject separators, traversal and dot components. Exclusive
  `wx` writes preserve existing files and reject destination symlinks.
- Local stdio/library explicit file paths are an intended documented capability.
  Restricting them to silence an environment-taint warning would break that contract.
- `bun --no-env-file test tests/auditInfrastructure.test.ts tests/http.test.ts`:
  39 tests and 114 assertions pass, including real HTTP path confinement and
  overwrite/symlink checks. The full 1,198-test suite also passes.

### Initial release evidence

- Frozen dependency installation, full graph audit (zero findings), typecheck,
  build, all 1,198 offline tests and the SDK issuer-isolation regression pass.
- The official MCP JSON Schema accepts `server.json` at version 0.9.0.
- Fresh canaries report healthy GLEIF, filings.xbrl.org, HKEXnews and TWSE.
- The non-strict live suite passes 21 tests with five credential-dependent skips.
  Existing explicitly tolerated anti-bot paths remain tolerated; this result does
  not certify every provider's availability or replace strict live validation.
- Runtime and installed-package checks pass on Node 18.20.8, 20.20.2, 22.23.3 and
  24.18.0. They cover declarations, imports, stdio/HTTP recovery, exclusive EOF
  shutdown, upstream errors and deadline/cancellation behavior.
- The strict credential preflight fails with the four missing variable names,
  as required. The release workflow now repeats this prerequisite before any
  publication and supports non-publishing manual validation of candidate branches.
- Workflow validation: actionlint 1.7.7 and 13 extracted guard scenarios pass.
  The scenarios exercise merged/unmerged tags, source/manifest version drift,
  npm commit/identity mismatch, manual validation, and credential presence.
- Independent adversarial review found one documentation omission: npm publisher
  setup must permit direct `npm publish`. It is corrected and cited to official
  npm guidance. The reviewer found no remaining blocking implementation defect.
  Authenticated npm publisher permissions and actual publication are not verified.
