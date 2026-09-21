# Pagination correctness

Branch: `fix/pagination-correctness`

## Acceptance criteria

- [x] Cursor pagination terminates on repeated cursors without refetching a page and still follows an empty page that advertises a distinct next cursor. (completed: 2026-09-21)
- [x] Offset/page-number pagination can cross an empty intermediate page when authoritative metadata says more results exist. (completed: 2026-09-21)
- [x] Duplicate records across pages collapse by stable source identity without changing source attribution or ordering. (completed: 2026-09-21)
- [x] A later-page upstream failure remains an explicit error rather than being presented as a complete or empty result. (completed: 2026-09-21)
- [x] Every pagination path remains bounded and non-progressing metadata terminates safely. (completed: 2026-09-21)
- [x] Exported signatures, structured output, and jurisdiction behavior remain unchanged. (completed: 2026-09-21)
- [x] Focused regressions, the full offline suite, typecheck, build/runtime, and packed-package checks pass. (completed: 2026-09-21)
- [ ] A focused PR is pushed, registered with T3, and its CI is watched once with a bounded timeout.

## Work

- [x] Add failing deterministic fixtures for empty intermediate pages, repeated cursors, cross-page duplicates, and partial upstream failures. (completed: 2026-09-21)
- [x] Implement only the pagination fixes proven by those fixtures. (completed: 2026-09-21)
- [x] Document the tested pagination invariants where repository testing guidance tracks regressions. (completed: 2026-09-21)
- [x] Run required checks and review the final diff for public-contract or source-attribution drift. (completed: 2026-09-21)
- [ ] Commit, push, open and register the PR; watch CI and address only in-scope failures.
