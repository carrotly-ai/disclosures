# Installed-package reliability

Branch: `fix/installed-package-reliability`

Acceptance criteria:

- The release gate builds an npm tarball and installs it into a fresh, isolated consumer with lifecycle scripts disabled.
- That consumer compiles strict TypeScript imports against the package's published declarations without consumer-only dependencies or `skipLibCheck`.
- The installed package—not the repository source tree or an unpacked `dist/`—is exercised on Node 18, 20, 22, and 24 by CI.
- Packed-package checks cover library import, stdio MCP startup/initialization/tool discovery/clean shutdown, malformed tool input, and deterministic upstream timeout and error responses without live network access.
- Any demonstrated runtime defect is fixed at its root without changing public APIs, jurisdiction routing, or Node 18 support.
- Publishing/test documentation describes the installed-package gate accurately; no release, tag, publication, protection, dependency, or autopilot changes are made.

## Work plan

- [x] [Medium] Establish the clean baseline, reproduce missing packed-artifact coverage, and trace package/transport/error boundaries. (completed: 2026-09-21)
- [x] [Medium] Add a deterministic installed-consumer harness covering declarations, MCP lifecycle, malformed input, timeout, and upstream errors. (completed: 2026-09-21)
- [x] [Medium] Repair only defects reproduced by the installed-consumer harness, with focused regression assertions. (completed: 2026-09-21 — no runtime defect reproduced; the missing release-gate coverage was the demonstrated gap)
- [x] [Simple] Integrate the harness with the supported-Node CI/release gates and update publishing/testing documentation. (completed: 2026-09-21)
- [x] [Medium] Run focused and full validation, inspect the packed file set, and verify Node 18/20/22/24 results. (completed: 2026-09-21)
- [ ] [Simple] Commit, push, open and register a focused PR, then watch CI once with a bounded timeout.

## Validation

- `bun run typecheck`
- `bun test` — 1,151 passed, 0 failed, 4,393 assertions
- `bun run build`
- `bun run test:stdio` — 1 passed, 68 assertions
- `node scripts/check-runtime.mjs` — stdio and HTTP passed on Node 24.18.0
- `npm pack --dry-run --json` — only `dist/`, `README.md`, `LICENSE`, `NOTICE`, and `package.json`
- `npx -y node@{18,20,22,24} scripts/check-package.mjs` — installed-artifact gate passed on Node 18.20.8, 20.20.2, 22.23.2, and 24.21.0
- No live official-source calls were needed: the changed boundary uses deterministic injected failure fixtures.
