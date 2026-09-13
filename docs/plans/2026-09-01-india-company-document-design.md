# India CompanyDocument design

## Context

BSE filings already expose official PDF attachments, but the IN route cannot retrieve them through `CompanyDocument`. The current filings adapter also uses a stale announcement endpoint, does not paginate, and exposes `NEWSID` as the structured transaction id even though the independent `ATTACHMENTNAME` identifies the document. Live corpus work found 26/26 valid PDFs extractable, while annual-report ownership tables were too irregular; ownership should later use BSE shareholding iXBRL/XML instead.

## Approved scope

- Repair BSE announcement discovery with the current paginated endpoint.
- Preserve announcement identity separately from the attachment transaction id.
- Add IN `CompanyDocument` metadata, paged extracted text, and bounded PDF download.
- Enforce exact official-host/path validation and validate every redirect before requesting it.
- Use a 30 MiB processing cap; over-cap documents remain linkable but are not downloaded, extracted, or written.
- Add offline, live, documentation, and release-gate coverage.
- Defer `CompanyOwners` to a separate latest-quarter shareholding-XBRL feature.

## Architecture

### Shared bounded HTTP transport

Add a narrow primitive to `src/core/http.ts` that owns transport mechanics only:

- manual redirects with a five-hop budget;
- caller-provided validation before the initial request and every redirect;
- declared `Content-Length` rejection;
- incremental body reads with cancellation at the byte cap;
- timeout coverage through body consumption;
- final URL, headers, bytes, and typed size-limit context.

Existing adapters remain unchanged. BSE is the first consumer; later hardening can migrate other document sources independently.

### BSE source policy

`src/adapters/bseIndia.ts` owns:

- `AnnSubCategoryGetData/w`, `subcategory=-1`, 50-row pages, strict `ROWCNT` validation, 20-page/1,000-row scan ceiling, and deduplication;
- bare attachment filenames as canonical transaction ids;
- `NEWSID` preserved as `sourceIdentifiers.bseNewsId` and structured `announcementId`;
- exact `www.bseindia.com` HTTPS allowlisting for `/xml-data/corpfiling/AttachHis/` and `/AttachLive/` PDF paths;
- AttachHis-first retrieval with AttachLive fallback only after definitive absence;
- BSE browser headers, rate limiting, anti-bot-envelope detection, metadata probing, PDF magic, and typed errors.

### Tool rendering

`src/tools/index.ts` reuses the existing document pipeline:

- `extractPdfText`;
- `pdfExtractionSections` / `pdfNoTextSections`;
- 50,000-character pagination;
- untrusted-content fencing and sentinel defanging;
- existing absolute/relative/default `output_path` behavior;
- `countPdfPages`.

Over-cap outcomes are successful link-only results. `pdf` mode must not create or truncate the requested output file.

## Acceptance criteria

### US-001 — Repair BSE filing discovery and chaining

- Current endpoint and required parameters are used.
- Results paginate from `Table1[0].ROWCNT` and dedupe before limiting.
- Typed malformed/blocked/upstream failures never become empty results.
- `NEWSID` remains announcement identity; `ATTACHMENTNAME` is the document transaction id.
- No-attachment rows expose no transaction id.

### US-002 — Add IN CompanyDocument

- IN is accepted by the canonical document schema.
- Bare filenames and exact official AttachHis/AttachLive URLs are accepted; unsafe references and redirects issue zero target requests.
- Metadata exposes verified source, MIME, size, Last-Modified, page count when known, and over-cap state.
- XHTML uses shared extraction, paging, and fencing; unreadable PDFs degrade honestly.
- PDF mode writes exact bytes below 30 MiB and never inlines bytes.
- Declared and streamed over-cap documents remain link-only and do not write files.

### US-003 — Integrate and verify

- Structured filings chain directly to CompanyDocument and preserve `announcementId`.
- README, jurisdiction docs/cards, coverage matrices, parity status, testing docs, and changelog are current.
- A bounded direct-document live test runs under the existing BSE transport-tolerance policy.
- Typecheck, all offline tests, build, stdio, package allowlist, strict live suite, Node 18/20/22 CI, and CodeQL pass.
