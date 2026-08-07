# KR — DART / OpenDART

**Data source:** [OpenDART](https://opendart.fss.or.kr/) (Financial Supervisory Service).
**Credentials:** `OPENDART_API_KEY` is required for all KR operations.

## Accepted `company` inputs

A company name, an OpenDART **8-digit corp code**, or a **6-digit stock code**. The
corp-code archive is a large reference download and is cached (24h default TTL) via the
injectable `AdapterOptions.cache`.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Matches against the OpenDART corp-code list; returns the corp code and stock code. |
| `CompanyFilings` | Periodic and major reports (사업보고서, 분기·반기보고서, etc.) with links; latest-annual/quarterly modes supported. |
| `CompanyInsiders` | Executive and major-shareholder ownership reports (임원·주요주주 소유보고). |
| `CompanyOwners` | 5%+ mass-holding reports (대량보유상황보고), with the DART 5% threshold regime on every row. |
| `CompanyFinancials` | Annual major-account financials (주요계정) by fiscal period end. |
| `CompanyDocument` | Fetches a filing's original documents by **receipt number** (rcept_no, passed as `transaction_id`, from `CompanyFilings`). Mode `metadata` (default) lists the DART XML documents in the filing; `xhtml` extracts the main document's plain text; `pdf` reports honestly that DART serves XML, not PDF. Requires `OPENDART_API_KEY`. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## `CompanyDocument` (KR)

- **Identifier:** the OpenDART 14-digit **receipt number** (`rcept_no`, e.g. `20240312000736`), passed as `transaction_id`. `company` is only a label — `/document.xml` fetches by receipt number.
- **Archive:** OpenDART returns a **ZIP of DART XML documents**. The main document is `{rcept_no}.xml`; supplementary parts are `{rcept_no}_NNNNN.xml`. Downloads are capped at 25 MB.
- **`metadata`** lists every member with sizes, highlighting the main document.
- **`xhtml`** decodes the main document and strips DART's uppercase-tag markup to plain text (truncated to 50,000 characters), returning the readable Korean filing text.
- **`pdf`** is reported honestly as unsupported — OpenDART serves structured DART XML, not PDF. The response links the DART web viewer, where the formatted document (and its browser print/PDF view) lives.
- **Errors:** on failure OpenDART returns a `<result><status>…</status>` envelope instead of a ZIP (e.g. `013` no data, `014` file not yet available); it is detected by ZIP magic bytes and surfaced as a readable, status-mapped error.

## Caveats

- Ownership and financial coverage follows what DART discloses in its structured feeds;
  narrative report bodies are not parsed (except via `CompanyDocument` `xhtml`, which
  extracts the filed document text directly).
