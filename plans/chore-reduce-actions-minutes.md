# Reduce GitHub Actions minutes

## Acceptance criteria

- [x] PR validation uses one Linux runner and keeps a build gate.
- [x] npm and MCP registry publishing remain tag driven.
- [x] Live E2E and source canaries run only by manual dispatch.
- [x] Validate workflow syntax and run the local quality gate.

The former four-version matrix plus duplicate main push ran eight CI jobs per merged PR; the daily canary added a run every day. Run unit, stdio, package, and supported Node runtime checks on the agent machine before pushing or tagging.
