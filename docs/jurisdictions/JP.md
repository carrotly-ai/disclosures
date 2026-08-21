# JP — EDINET

**Data source:** [EDINET](https://api.edinet-fsa.go.jp/) (Financial Services Agency).
**Credentials:** `EDINET_API_KEY` is required only for document search. `CompanyResolve`
works **without** a key because the EDINET code list is public.

## Accepted `company` inputs

A company name, an **EDINET code** (`E` + 5 digits), a 4/5-digit securities code, or a
13-digit corporate number. The EDINET code list is cached (24h default TTL) via the
injectable `AdapterOptions.cache`.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless — matches against the public EDINET code list. |
| `CompanyFilings` | Date-indexed disclosure-document search (requires `EDINET_API_KEY`). |
| `CompanyInsiders` | Unsupported — EDINET has no Section 16-style insider feed. |
| `CompanyOwners` | Large-volume holding reports (大量保有報告書, the 5% rule) and their change reports (変更報告書), reverse-mapped to the subject issuer — each row is a ≥5% holder (requires `EDINET_API_KEY`). |
| `CompanyFinancials` | Headline annual figures parsed from the latest 有価証券報告書's XBRL instance — net sales / operating revenue, operating income, profit attributable to owners of the parent, total assets, net assets — in JPY, consolidated preferred (requires `EDINET_API_KEY`). |
| `CompanyDocument` | Fetches a filing's renditions by **EDINET docID** (passed as `transaction_id`, from `CompanyFilings`). Mode `metadata` (default) lists the XBRL archive members (type=1); `pdf` downloads the human-readable PDF (type=2) to disk with a page count; `xhtml` attempts **best-effort text-layer extraction from the type=2 PDF** (fenced, paged via `text_offset`), falling back to the honest bundled-XBRL-archive note when the PDF has no usable text layer. Requires `EDINET_API_KEY`. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## `CompanyDocument` (JP)

- **Identifier:** the EDINET **docID** (e.g. `S100YRS6`), passed as `transaction_id`. `company` is only a label here — EDINET fetches a document by its docID, not by issuer.
- **Renditions:** every filing exposes two machine-fetchable renditions — a human-readable **PDF** (`type=2`) and a **ZIP archive** of the submission's XBRL instance, PublicDoc iXBRL HTML, and audit documents (`type=1`). Downloads are capped at 25 MB.
- **`metadata`** downloads the type=1 archive and lists its members with sizes (the `XBRL/PublicDoc/*.htm` files are the formatted rendition; the `.xbrl` file is the structured data).
- **`pdf`** downloads the type=2 PDF to disk (defaulting to a temp file; override with `output_path`), reporting the saved path, byte size, and page count. Document bytes are never inlined into the response.
- **`xhtml`** attempts best-effort text-layer extraction from the type=2 PDF via the zero-dep in-repo extractor (`src/core/pdfText.ts`), returning the text fenced as untrusted and paged via `text_offset`. EDINET has no single inline XHTML rendition, so when the PDF yields no usable text (scanned, or fonts with no `/ToUnicode` map) the response falls back to the honest note that the machine-readable content is the bundled XBRL archive (`metadata` lists it) and the human-readable rendition is the PDF (`pdf` downloads it). This is a text-layer extractor, not a renderer — layout is not preserved.
- **Errors:** a bad docID or absent rendition answers a JSON envelope rather than bytes; it is detected by magic-byte inspection and surfaced as a readable error, never leaked as content.

## `CompanyFinancials` (JP)

- **Source:** the XBRL instance (`XBRL/PublicDoc/*.xbrl`) bundled inside the latest
  **有価証券報告書** (annual securities report, docType 120) `type=1` archive. The call is
  bounded: one date-indexed document search to find the report, then one archive download.
  Requires `EDINET_API_KEY` (resolution is keyless; a missing key returns the friendly
  configuration message).
- **Concepts:** the shared canonical set — `revenue` (jppfs_cor `NetSales` /
  `OperatingRevenue1` / `OperatingRevenue2`, or the IFRS `*IFRS` variants), `operating_income`
  (`OperatingIncome` / `OperatingProfitLossIFRS`), `net_income`
  (`ProfitLossAttributableToOwnersOfParent`, falling back to `ProfitLoss` and the IFRS
  variants), `total_assets` (`Assets`), and `stockholders_equity` (`NetAssets` / IFRS
  `Equity`). Matching is by element **local name**, so both Japanese-GAAP (jppfs_cor) and
  IFRS (jpigp_cor) taggings resolve. Values are the raw yen amounts as tagged — no scaling.
- **Contexts:** only the standardized undimensioned annual contexts qualify —
  `CurrentYear{Duration,Instant}`, `Prior{1..4}Year{...}`, and their
  `_NonConsolidatedMember` companions. Segment/member-dimensioned contexts are ignored, so a
  per-segment figure is never surfaced as a company total.
- **Basis:** consolidated (連結) is preferred **per line**; the non-consolidated (単体) value
  is used only where the filer reports no consolidated figure for that line, and the `Basis`
  column states which was used. One report carries the current fiscal year plus the prior
  year it restates; `periods` bounds how many are shown (default 2).
- **Errors:** a bad docID or absent rendition answers a JSON envelope rather than a ZIP; it is
  detected by magic-byte inspection and surfaced as a readable error, never leaked as content.

## Caveats

- EDINET search is date-indexed rather than company-indexed; resolution narrows to the
  issuer's EDINET code, then filings are queried within the date window.
- `CompanyFinancials` reads figures **as filed** from the XBRL instance in JPY. It extracts
  only headline statement totals (no segment or note detail); a company with no recent annual
  securities report, or whose instance tags none of these elements, legitimately returns
  nothing — absence is not proof it did not report.
- `CompanyOwners` reverse-maps EDINET's **filer-indexed** large-holding reports onto the
  subject issuer by matching each report's `issuerEdinetCode` to the resolved company, so
  the filer of each returned row is a ≥5% holder of it. Because there is no server-side
  subject filter, the scan walks a bounded window one calendar day per request (default
  ~1 year; narrow with `start_date`/`end_date`, which apply **only** to JP here). EDINET's
  day index carries **no holding ratio**, so exact percentages require opening the linked
  report (docID) in the EDINET viewer — parity with the SEC 13D/G path, which likewise
  returns the filing, not the exact stake. Filing-based disclosure only: not a share
  register and not UBO tracing, and absence is not proof no ≥5% holder exists.
