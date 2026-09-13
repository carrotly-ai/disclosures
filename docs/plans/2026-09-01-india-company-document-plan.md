# India CompanyDocument implementation plan

**Goal:** Make BSE filing PDFs safely chainable and retrievable through the existing `CompanyDocument` tool.

**Architecture:** Use a narrow shared bounded/redirect-aware HTTP primitive, with all BSE endpoint, host, fallback, metadata, and error policy retained in the BSE adapter. Reuse the existing PDF extraction and tool-rendering pipeline.

**Tech stack:** TypeScript, Bun, Zod, MCP SDK, zero runtime dependencies.

**Acceptance criteria source:** [`2026-09-01-india-company-document-design.md`](2026-09-01-india-company-document-design.md).

---

## 1. Repair BSE filing enumeration `[Medium]`

**Files:** `src/adapters/bseIndia.ts`, `src/core/types.ts`, `src/tools/index.ts`, `tests/bseIndia.test.ts`, `tests/tools.test.ts`

- Replace `AnnGetData/w` with `AnnSubCategoryGetData/w`; send `subcategory=-1`.
- Parse and validate `Table1[0].ROWCNT`; paginate 50 rows/page up to 20 pages/1,000 rows.
- Dedupe by `NEWSID`, then attachment filename, then a stable row composite.
- Preserve `NEWSID` as `sourceIdentifiers.bseNewsId` / structured `announcementId`.
- Use normalized `ATTACHMENTNAME` as `Filing.accession`; omit it when no attachment exists.
- Prefer AttachHis links in filing output and expose scan truncation honestly.

**Verification:** `bun test tests/bseIndia.test.ts tests/tools.test.ts && bunx tsc --noEmit`

**Satisfies:** US-001, US-003 chaining criteria.

## 2. Add bounded redirect-aware HTTP requests `[Medium]`

**Files:** `src/core/http.ts`, `tests/http.test.ts`

- Add method-capable manual redirects with a validator called before every request.
- Add incremental bounded binary reads, declared-length precheck, cancellation, final URL/headers, and typed limit context.
- Keep timeout active through body consumption.
- Preserve the existing `getFollowingRedirects` contract and authorization stripping.

**Verification:** `bun test tests/http.test.ts && bunx tsc --noEmit`

**Satisfies:** US-002 redirect, cap, and zero-target-request criteria.

## 3. Add secure BSE document primitives `[Medium]`

**Files:** `src/adapters/bseIndia.ts`, `tests/bseIndia.test.ts`

- Add strict filename/URL normalization for exact AttachHis/AttachLive HTTPS paths.
- Reject credentials, ports, query/fragment, traversal, encoded separators, foreign/suffix hosts, and non-PDF names before fetch.
- Probe metadata through HEAD plus a small range request; validate PDF magic.
- Prefer AttachHis and fall back to AttachLive only on 404/410.
- Implement bounded full PDF retrieval, page counting, Last-Modified and MIME/length metadata, anti-bot detection, and typed over-cap behavior.
- Expose metadata/PDF methods from `createBseAdapter`.

**Verification:** `bun test tests/bseIndia.test.ts && bunx tsc --noEmit`

**Satisfies:** US-002 adapter/security criteria.

## 4. Wire IN CompanyDocument `[Medium]`

**Files:** `src/tools/shared.ts`, `src/tools/index.ts`, `tests/inTools.test.ts`, `tests/tools.test.ts`

- Add IN to `DOCUMENT_JURISDICTIONS` and schema descriptions.
- Add `companyDocumentIn` for metadata/xhtml/pdf.
- Reuse `extractPdfText`, `pdfExtractionSections`, `pdfNoTextSections`, pagination, fencing, and output paths.
- Render over-cap metadata/link-only outcomes without extraction or file writes.
- Test metadata, paging, sentinel defanging, image-only degradation, exact file bytes, output paths, SSRF, 404/429/non-PDF, and declared/streamed cap behavior.

**Verification:** `bun test tests/inTools.test.ts tests/tools.test.ts && bunx tsc --noEmit`

**Satisfies:** US-002 and US-003 schema/chaining criteria.

## 5. Document and live-verify `[Simple]`

**Files:** `README.md`, `CHANGELOG.md`, `docs/jurisdictions/IN.md`, `docs/jurisdictions/README.md`, `src/core/jurisdictionReference.ts`, `docs/TESTING.md`, `docs/CAPABILITY-PARITY-FEASIBILITY.md`, `tests/live/e2e.live.ts`

- Document the attachment-filename transaction contract, AttachHis fallback, 30 MiB cap, and PDF-derived text caveats.
- Mark IN CompanyDocument delivered and retain CompanyOwners as an XBRL-based follow-up.
- Add a direct pinned BSE attachment metadata live case; do not depend on the blocked announcement API.

**Verification:** `bun run test:live:all`

**Satisfies:** US-003 documentation/live criteria.

## 6. Full gate, PR, and integration `[Medium]`

```bash
git diff --check
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
bun run build
bun run test:stdio
bun run pack:dry
bun run test:live:all
```

- Commit each implementation slice atomically.
- Push `feat/india-company-document`, open a PR with acceptance evidence, and wait for Node 18/20/22 CI plus CodeQL.
- Squash-merge after green checks, sync `main`, and rerun the deterministic gate.
- Do not bump the package version or implement CompanyOwners in this branch.

**Satisfies:** all approved acceptance criteria.
