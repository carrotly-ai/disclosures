# Refresh MCP dependency security

## Acceptance criteria

- Reuse existing PR83 and its supported SDK1.32.1 update; preserve every public/library/stdio/HTTP contract and Node>=18 support.
- Patch the new Hono advisory within the existing SDK dependency range; retain every unrelated lock record.
- Pass fresh frozen install, unfiltered audit, typecheck, complete offline tests, build, stdio, actual HTTP/runtime and installed packed-consumer gates. No live provider or publication acceptance is inferred.
- Review, commit and push on the same PR; preserve strict live-provider release holds and require passing current hosted checks.

## Work

- [x] Confirm clean assigned checkout, current default and existing PR83; inspect full diff and canonical install/validation workflows. SDK1.32.1 excludes the new SDK highs, but fresh audit reveals Hono4.13.7 moderate GHSA-5r4p-p66f-jhc7.
- [x] Select Hono4.13.11 from official npm metadata; no dependency or engine change and no new direct dependency or override.
- [x] Validate frozen graph, complete offline/stdio/HTTP/packed consumers and exact dependency range exclusions. Full audit returns zero; the actual SDK protocol consumers pass.
- [x] Review the full diff and prepare the same-PR commit/push and handoff. Exact committed replay and hosted status are recorded externally; pending/failing hosted checks block readiness.
