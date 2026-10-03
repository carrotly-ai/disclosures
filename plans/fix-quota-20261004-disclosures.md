# Disclosure interruption correctness — phase 1

Branch: `fix/quota-20261004-disclosures`

## Scope and evidence

Verified default `origin/main` and branch base: `833fa58` (#78). Read merged
#76 retry/deadline work, #77 pagination work, #78 malformed-source work, their
plans and PR evidence. Open #79 changes only CI and is excluded from this lane.

Hypothesis: `fetchFollowingRedirects` awaits body cancellation without handling
rejection. An interrupted error body therefore replaces the upstream status,
preventing bounded-download adapters from attributing an HTTP 429 correctly.
The ordinary JSON request path already catches discarded-body cancellation.

## Acceptance criteria

- [x] Demonstrate the cancellation-rejection failure with deterministic fixtures before fixing it.
- [x] Preserve the original HTTP status/URL and adapter source attribution when discarding interrupted bodies; retain valid redirect behavior and the bounded retry policy.
- [x] Confirm later-page rate limits cannot return earlier rows as complete results, and deadline cancellation cannot start another retry.
- [x] Preserve public APIs, Node >=18, existing size/time caps, and jurisdiction routing; leave CI and publishing untouched.
- [x] Pass focused/full tests, typecheck/build, stdio/HTTP MCP and packed-consumer checks on supported Node 18/20/22/24 runtimes.
- [x] Commit/push this branch, open/link one PR, inspect CI once, and leave a clean synchronized checkout.

## Work

- [x] Read repository instructions, current default/open PRs and previous worker evidence. (2026-10-04)
- [x] Add failing shared-helper and bounded-adapter cancellation regressions.
- [x] Apply the smallest proven shared-helper fix and validate interruption attribution/bounds.
- [x] Run required validation, document evidence and remaining limits.
- [x] Ship and register the PR without merging or publishing.

## Verification evidence

- Before the source change: 91 pass / 9 fail in the three reproduction files;
  every new failure surfaced `TypeError: fixture body interrupted` instead of
  the expected HTTP/adapter error or redirect result.
- Fix: catch cancellation rejection at the two existing discard sites in
  `fetchFollowingRedirects`; no retry policy, timeout, size cap or API changes.
- `bun test tests/core.test.ts tests/auditInfrastructure.test.ts tests/twseOpenApi.test.ts tests/kapTurkey.test.ts tests/companiesHouse.test.ts`: 178 pass.
- `bun test`: 1,194 pass / 0 fail; `bun run typecheck`, `bun run build`,
  `bun run test:stdio`, and `git diff --check` pass.
- Fresh-bundle MCP and packed-consumer validation pass on Node 18.20.8,
  20.20.2, 22.23.3 and 24.18.0. Commands: `node scripts/check-runtime.mjs` and
  `node scripts/check-package.mjs`; Node 18/20/22 run via
  `npm exec --yes --package=node@<major> -- node <script>`.
- TWSE/KAP errors retain `source`; the shared error retains status/URL. Earlier
  Companies House rows are withheld on later-page failure. Valid-source links
  remain covered by the existing adapter tests. Deadlines are per request,
  with existing pagination caps; no caller-cancellation API is introduced.
- Fixtures use no upstream traffic or real credentials. Packed checks access
  npm only for declared dependencies and temporary Node test runtimes.

## Handoff

- PR: https://github.com/carrotly-ai/disclosures/pull/80 (registered with T3).
- Fix: https://github.com/carrotly-ai/disclosures/commit/0c54fc0
- Packed regression: https://github.com/carrotly-ai/disclosures/commit/262408a
- Phase 1 implementation and local validation are complete. Hosted CI is
  inspected with one bounded `gh pr checks --watch --fail-fast`; its actual
  final/pending result is recorded in the PR body and sprint response.
- Phase 2, if assigned, must reuse this branch/PR. Nothing is merged or published.
