# IN — BSE India

**Data source:** [BSE India](https://www.bseindia.com/) company search, corporate-announcement feed, and official filing PDFs.
**Credentials:** none. `api.bseindia.com` is anti-bot protected; if the default fetch is blocked, inject a browser-backed `fetchFn` via `AdapterOptions`. Direct attachment PDFs may remain reachable even when the API host is not.

## Accepted `company` inputs

A company name or a **6-digit BSE scrip code**.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | BSE listing resolution with scrip code and ISIN. |
| `CompanyFilings` | Paginated corporate-announcement feed with BSE `NEWSID`, attachment transaction id, and official PDF link. |
| `CompanyDocument` | Filing PDF metadata, paged best-effort text extraction, or bounded local download. |
| `CompanyInsiders` | Unsupported — insider detail is not exposed as a clean BSE feed. |
| `CompanyOwners` | Unsupported in this release; the correct follow-up is the latest-quarter BSE shareholding iXBRL/XML, not annual-report PDF parsing. |
| `CompanyFinancials` | Unsupported — BSE financial data is not normalized here. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Filing discovery and identifiers

BSE's current announcement endpoint returns 50 rows per page plus a total count. The adapter paginates up to 20 pages / 1,000 raw rows, deduplicates repeated announcements, and reports when a selective query reaches that scan ceiling.

BSE assigns two independent identifiers:

- **`NEWSID`** — announcement identity, returned as `announcementId` in structured output.
- **`ATTACHMENTNAME`** — PDF identity, returned as the `CompanyDocument` `transaction_id`.

They are not interchangeable. Rows without an attachment expose no document transaction id.

## `CompanyDocument`

Pass either:

- the bare attachment filename returned by `CompanyFilings`, such as `468b09a3-a212-4066-bbaa-4b0ba524d2ce.pdf`; or
- an exact official HTTPS URL under BSE's `AttachHis` or `AttachLive` directory.

The adapter canonicalizes both to the bare filename, prefers the more durable `AttachHis` location, and falls back to `AttachLive` only after a definite 404/410. It validates the initial request and every redirect against the exact BSE host and path before fetching.

Modes:

- **`metadata`** — lightweight HEAD/range probe for MIME type, size, Last-Modified, and the verified official URL. It does not download the full PDF merely to count pages.
- **`xhtml`** — best-effort extraction from the PDF text layer, fenced as untrusted issuer-authored content and paged in 50,000-character windows through `text_offset`.
- **`pdf`** — writes the exact PDF bytes to `output_path` or a temporary file; bytes are never inlined.

The processing cap is **30 MiB**. A larger document remains available as metadata plus an official link, but is not downloaded, extracted, or written locally. The cap is enforced from declared length and while streaming, so an incorrect or absent `Content-Length` cannot bypass it.

## Caveats

- HTTP 200 is not sufficient evidence of data: BSE's anti-bot edge can return an HTML shell. Announcement envelopes and PDF magic bytes are validated before being trusted.
- PDF text extraction is not a rendered view. Tables, columns, and reading order can be imperfect; scanned/custom-font documents degrade to the official link rather than fabricated text.
- `AdapterOptions.fetchFn` is a TypeScript-library/custom-server capability. The stock stdio process cannot receive a JavaScript function and returns an actionable error when its host is blocked.
- Company ownership remains a separate task. Corpus work found annual-report 1%+ tables inconsistent, while BSE's quarterly shareholding iXBRL/XML was stable across the sampled issuers; that structured source is the intended implementation path.
