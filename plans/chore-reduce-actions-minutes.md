# Reduce GitHub Actions minutes

## Acceptance criteria

- [x] PR validation uses one Linux runner and keeps a build gate.
- [x] npm and MCP registry publishing remain tag driven.
- [x] Live E2E and source canaries run only by manual dispatch.
- [x] Validate workflow syntax and run the local quality gate.

The former four-version matrix plus duplicate main push ran eight CI jobs per merged PR; the daily canary added a run every day. Run unit, stdio, package, and supported Node runtime checks on the agent machine before pushing or tagging.

## Baseline PR checkpoint

## Acceptance criteria

- Every PR emits `pr-check`; applicable validation failures, cancellations and unexpected skips fail.
- Frozen installs, existing offline checks, no production services/credentials.
- Hosted lightweight/public jobs; private heavier suites on Linux, Apple builds on mini.
- Preserve existing release/deployment/security jobs and related local CI work.

## Tasks

- [x] Inspect default branch, related CI PR, manifests and instructions.
- [x] Implement repository-specific baseline and runner routing.
- [x] Validate workflow and run supported local checks; document failures.
- [x] Prepare and ship one feature-branch commit and PR.

## Baseline validation evidence

- actionlint v1.7.7 and `git diff --check` passed.
- `bun install --frozen-lockfile` — passed.
- `bun run typecheck` — passed.
- `bun run test` — passed.
- `bun run build` — passed.
- `node scripts/check-runtime.mjs` — passed.
