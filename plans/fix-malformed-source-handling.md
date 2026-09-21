# Malformed source handling

Branch: `fix/malformed-source-handling`

## Acceptance criteria

- [x] Representative JSON and HTML adapters reject malformed payloads or schema drift with precise source-context errors instead of misleading empty success. (completed: 2026-09-21)
- [x] Missing source identifiers cannot produce fabricated records or ambiguous official-source links. (completed: 2026-09-21)
- [x] Unexpectedly large responses are rejected within existing processing bounds before unbounded parsing or accumulation. (completed: 2026-09-21)
- [x] Official-source attribution and links remain unchanged for valid payloads. (completed: 2026-09-21)
- [x] Exported APIs, schemas, jurisdiction behavior, R11/R32, namespace boundaries, model defaults, and Node 18 support remain unchanged. (completed: 2026-09-21)
- [x] Focused regressions, full tests, typecheck, build/runtime, and packed-consumer checks pass. (completed: 2026-09-21)
- [ ] A focused PR is pushed, registered with T3, and its CI is watched once with a bounded timeout.

## Work

- [x] Inventory representative adapters and trace malformed JSON/HTML, schema drift, identifier, and response-size paths. (completed: 2026-09-21)
- [x] Add deterministic failing fixtures for demonstrated gaps before changing source code. (completed: 2026-09-21)
- [x] Implement only fixes proven by those fixtures, preserving valid-source behavior and attribution. (completed: 2026-09-21)
- [x] Run required checks and review the final diff for public-contract or jurisdiction drift. (completed: 2026-09-21)
- [ ] Commit, push, open and register the PR; watch CI and address only in-scope failures.
