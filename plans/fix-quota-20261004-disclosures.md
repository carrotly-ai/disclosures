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

## Phase 2 — adversarial review

Review scope: the actual #80 diff, response/reader ownership, cancellation and
retry boundaries, authoritative status/source handling, rejected-cache behavior
and supported Node runtimes. Default remains `833fa58`; #79 is CI-only. #80 has
no reviews or comments at the start of this phase, and all four CI jobs passed
phase-1 head `53e3f14`.

Hypothesis: swallowing a redirect body's cancellation rejection allows the
redirect loop to continue after the shared deadline has already aborted. The
low-level fetch loop currently invokes injected fetches without checking that
signal first, so late cleanup can start another request after the caller fails.

- [x] Read the actual diff/evidence, current default/open PRs and review feedback; relink #80.
- [x] Reproduce or rule out a redirect continuation after deadline during cleanup.
- [x] Repair only a reproduced boundary defect and verify resource/error ownership.
- [x] Run checks warranted by changes and prepare the final #80 handoff; track final CI and clean/pushed verification in the PR body and sprint response.

### Phase-2 findings and evidence

- Demonstrated defect: both resolving and rejecting redirect cleanup after
  deadline issued `/final` despite the caller already receiving a timeout and
  the shared signal being aborted. Before repair:
  `bun test tests/auditInfrastructure.test.ts -t 'late redirect cleanup'` —
  0 pass / 2 fail; each observed `[start, final]` instead of `[start]`.
- Root cause: `fetchWithRetry` lacked an abort guard at the actual fetch boundary.
  Repair: throw the existing signal reason before invoking each fetch attempt.
  This uses Node-18-supported signal properties and preserves existing error,
  retry, size, redirect-auth and public API contracts.
- Focused check across the same five phase-1 test files: 180 pass / 0 fail;
  `bun run typecheck` passes. Unit fixtures also assert identity of the original
  deadline error and shared abort reason.
- Resource/persistence review: discarded-body rejection remains observed,
  deadline races handle late pending work, and `CachedLoader.load` writes only
  successful values and removes in-flight entries in `finally`. Existing cache,
  streaming-cap, redirect-auth and partial-result regressions cover these paths.
- No additional in-scope defect or review feedback identified. Add the late
  cleanup challenge to the packed HTTP consumer, then validate the changed head.
- Full suite after the guard: 1,196 pass / 0 fail; build, stdio and fresh-bundle
  runtime checks pass on Node 18/20/22/24. The initial new packed fixture failed
  on all four because its assertion incorrectly assumed GLEIF's 15-second
  timeout for TWSE; the actual `TWSE_REQUEST_TIMEOUT_MS` is 30 seconds. Correct
  only that new fixture assertion; leave all production deadlines unchanged.
- Corrected packed-consumer checks pass on Node 18.20.8, 20.20.2, 22.23.3 and
  24.18.0, including late redirect rejection after TWSE's production 30-second
  deadline and subsequent MCP discovery. No runtime/build/unit rerun is needed
  for the fixture-only correction.
- #79's actual files include `docs/TESTING.md` as well as workflows. A three-way
  `diff3` of the current guide, default and #79 reproduced a conflict between
  its changed CI paragraph and our adjacent packed-fixture paragraph. Move this
  lane's fixture text into the audit section; do not adopt or change #79's CI
  guidance. This preserves the documentation and removes the demonstrated hunk
  conflict without editing another checkout.
- The adjusted guide passes the same `diff3` challenge (exit 0, no conflict).
  No workflow, CI guidance, compatibility target or dependency is changed.
- Phase-2 repair commit: https://github.com/carrotly-ai/disclosures/commit/7d06856
- Final local validation: 180 focused tests, 1,196 full tests, typecheck, build,
  stdio, and fresh/packed MCP checks on Node 18/20/22/24 all pass. Final hosted
  CI is checked with one bounded watch after the packed-test commit; its exact
  head/run/status is recorded in the PR body without an extra documentation push.
- Both assigned phases are implemented and reviewed. Final shipping/CI status
  is authoritative in #80 and the phase-2 sprint result. Live availability and
  caller-level cancellation APIs remain outside scope.
