# PH — PSE EDGE (Philippine Stock Exchange)

**Data source:** [PSE EDGE](https://edge.pse.com.ph) — the Philippine Stock Exchange's
statutory disclosure portal.
**Credentials:** none. PSE EDGE is fully keyless server-rendered HTML/JSON with no bot wall
— verified live from a plain server request, no browser and no injected `fetchFn` required.
**Licence:** ⚠️ **PSE restricts its contents to "personal, non-commercial use" and forbids
redistribution to third parties.** This conflicts with serving PSE content through this
package. Read [Terms of use — an unresolved conflict](#terms-of-use--an-unresolved-conflict)
**before** relying on this jurisdiction.

PSE EDGE is the most turnkey source in this package's Southeast Asia coverage: one keyless
host serves six of the ten intents, including two — insiders and owners — that most exchange
portals cannot serve at all.

| PSE disclosure template | Form | Backs |
|---|---|---|
| Change in Shareholdings of Directors and Principal Officers | 13-1 | `CompanyInsiders` |
| Public Ownership Report | POR-1 | `CompanyOwners` (default) |
| Statement of Changes in Beneficial Ownership of Securities | 17-7 | `CompanyOwners` (dealings mode) |
| Annual Report / Quarterly Report | 17-1 / 17-2 | `CompanyFinancials` |
| (all templates) | — | `CompanyFilings`, `CompanyDocument` |

---

## Terms of use — an unresolved conflict

**This section is the most important part of this page. It is not boilerplate.**

PSE's own disclaimer at <https://edge.pse.com.ph/page/disclaimer.do> says, verbatim (fetched
live 2026-08-29):

> **Using the Contents**
>
> Except as otherwise indicated with respect to a particular portion, file, or document
> provided on the Website, you may only download, view, or print individual pages of the
> Contents for your own **personal, non-commercial use**.
>
> You may **NOT COPY, STORE, EITHER IN HARD COPY OR IN ELECTRONIC RETRIEVAL SYSTEM,
> TRANSMIT, TRANSFER, PERFORM, BROADCAST, PUBLISH, REPRODUCE, CREATE A DERIVATIVE WORK
> FROM, DISPLAY, DISTRIBUTE, SELL, LICENSE, RENT, LEASE OR OTHERWISE TRANSFER** any of the
> Contents **to any third person, including others in your company or organization**,
> whether for direct commercial or monetary gain or otherwise without prior written consent
> of PSE or the third party provider of the Contents.

and, on ownership:

> All rights, title, and interest in and on the Contents, including database rights, are
> owned, licensed and/or controlled by the PSE and/or the third party credited as the
> provider of the Contents.

### The conflict, stated plainly

This package fetches PSE content and returns it to a caller. Where that caller is anyone
other than the natural person operating the package for their own personal, non-commercial
purposes — including, on PSE's own wording, **"others in your company or organization"** —
that transmission is the activity the clause above prohibits absent PSE's prior written
consent.

The **link-first, fetch-on-demand** model this package uses elsewhere (return the official
link, fetch content only when asked, cite the source, never bulk-mirror) mitigates the
volume of what is transmitted. It does **not** resolve the conflict, because PSE's
restriction is on the *act of transmitting to a third person* and on the *purpose* being
non-commercial — not merely on bulk redistribution.

### The precedent asymmetry — this project rejected ASX for the same wording

This repository's own Australia feasibility finding treated the ASX Terms of Use as
**disqualifying**, on wording that is near-identical to PSE's: the same "personal,
non-commercial use" limitation and the same explicit prohibition on transmitting or
distributing to a third party. **AU was not built on that basis.**

The Southeast Asia triage that assessed PSE reached the same conclusion independently. Its
verdict, verbatim:

> **Verdict: technically a standout BUILD (keyless, no browser, 5+ intents from one source),
> but its Terms disqualify redistribution on the same basis the repo used to reject ASX.**
> … An honest reading defaults to **do not ship PSE under the current ToU**, exactly as with
> ASX.

**PH was nevertheless built and shipped.** That was an explicit, eyes-open decision by the
repository owner, made with the above in front of them. It is recorded here rather than
resolved, because the underlying tension is real and is not cured by anything in the
implementation.

The asymmetry is therefore live and acknowledged: **AU is absent from this package on
grounds that PH is present despite.** That is a maintainer's judgement call, not a legal
conclusion, and this page does not argue that PSE's terms permit what the package does.

### What this means for you, the operator

- **The operator deploying this package — not the package, and not its authors — is
  responsible for holding the rights to use PSE data in their context.** If your use is
  commercial, or serves anyone beyond yourself, you likely need PSE's prior written consent.
  Requests go to the address on PSE's disclaimer page.
- Every PH tool response carries a short source-attribution and terms note pointing at the
  disclaimer, so the restriction travels with the data rather than living only in this file.
- The PH [jurisdiction reference card](../../src/core/jurisdictionReference.ts)
  (`disclosures://jurisdictions/PH`) opens its caveat with `TERMS-OF-USE CONFLICT`, so an
  MCP client can surface the warning before spending a call.
- Nothing here is legal advice.

---

## Accepted `company` inputs

- **PSE ticker symbol** — `SM` (SM Investments), `SMPH` (SM Prime), `SMC` (San Miguel),
  `MER` (Manila Electric). An exact ticker match outranks a name-similarity match, so `SM`
  resolves to SM Investments rather than to SM Prime Holdings, whose *name* also starts
  with "SM".
- **Numeric PSE company id** (`cmpyId`) — `599`, `112`, `154`. This is the id PSE's own
  endpoints key on, and `CompanyResolve` returns it in `sourceIdentifiers.pseCompanyId`.
- **Issuer name** as PSE EDGE spells it — `SM Investments Corporation`, `Ginebra San
  Miguel, Inc.`

`CompanyResolve` merges two keyless paths: the autocomplete endpoint (fast JSON: `cmpyId`,
`cmpyNm`, `symbol`) and the company directory (richer: sector, subsector, listing date, and
the `securityId`). Directory rows win where both have the company.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Symbol, legal name, sector/subsector, listing date, company id and security id. LEI enriched from GLEIF where a **confident** match exists (see below). |
| `CompanyFilings` | The per-issuer disclosure index — every template, newest first — with a date window, a limit, and a template-name filter. Each row carries the `edge_no` as its transaction id. |
| `CompanyDocument` | A disclosure by its `edge_no`: `metadata` (body file id + attachment list), `xhtml` (extracted body text, paged and untrusted-fenced), `pdf` (first PDF attachment, downloaded to disk, 25 MB cap). |
| `CompanyInsiders` | PSE form **13-1**, with per-transaction detail parsed from the document: person, position, trade date, share count, acquired/disposed, and the resulting direct and indirect holding. |
| `CompanyOwners` | PSE form **POR-1** by default — a named, point-in-time roster of directors, officers, principal/substantial stockholders and affiliates with direct/indirect share counts and percentages. A `start_date`/`end_date` window switches to the **17-7** beneficial-ownership dealings feed. |
| `CompanyFinancials` | The 17-A annual report's headline statement (balance sheet + income statement), in PHP. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

### LEI enrichment is deliberately conservative

PSE's registers carry no LEI at all, so GLEIF (keyless, CC0) fills the gap by legal name. A
GLEIF hit is accepted **only** when it is a Philippine entity *and* its legal name matches
the PSE name exactly under this package's name normalization. GLEIF holds `SM INVESTMENTS,
LLC` (US), `SM Investments ehf.` (Iceland) and `SM INVESTMENTS LTD.` (Belize) alongside the
Philippine issuer; a near-match is **withheld rather than attached**, because no LEI is
better than a wrong one. This follows the KAP (Türkiye) precedent.

Verified live: `SM` → `254900YB8UATFP21AF80`, `SMPH` → `254900SZK83MIAB8CU32`,
`SMC` → `549300AGC9NFF12PHN68`.

## Two endpoints, two different company parameters

This is a real trap, found by live verification and **contradicting the triage finding**
that specified `companyId` for both:

| Endpoint | Filters by | Sending the wrong one |
|---|---|---|
| `companyDisclosures/search.ax` | **`keyword=<cmpyId>`** | `companyId` is silently ignored — you get the whole market (35,658 rows) instead of one issuer's 358 |
| `financialReports/search.ax` | **`companyId=<cmpyId>`** | `keyword` returns `[Total 0]` |

`financialReports/search.ax` additionally **requires** an explicit `fromDate`/`toDate`
window: omitting it returns `[Total 0]` rather than everything, so a windowless call would
falsely report "no annual report" for an issuer that has three. The adapter supplies a
default 6-year window.

## The document flow is three hops

```
GET /openDiscViewer.do?edge_no=<hash>    → viewer shell
    ↳ <iframe src="/downloadHtml.do?file_id=1804533">   ← parsed out of it
    ↳ <select id="file_list"><option value="1900968">…  ← attachment list
GET /downloadHtml.do?file_id=1804533     → the document body (HTML)
GET /downloadFile.do?file_id=1900968     → an attachment's bytes (PDF/xlsx)
```

Every URL after the first is **rebuilt from an id parsed out of upstream HTML**, so each is
validated to be `https` on exactly `edge.pse.com.ph` before any request leaves the process
(SSRF guard). An off-host `transaction_id` is refused without a single fetch — including a
full URL like `https://evil.example.com/openDiscViewer.do?edge_no=…`.

Document bodies are **structured HTML, not PDFs**, which is why insiders, owners and
financials can parse real detail rather than linking out.

### Bounds, stated honestly

- **Index rows are always returned.** Parsed detail is a bounded enrichment on top.
- **Document fetches are capped at 10 per insiders call** (1 for the owners roster, which is
  a single point-in-time report). Rows beyond the cap are listed as
  `(see linked disclosure)` and link to the official viewer — never dropped, never guessed.
- **A document that fails to fetch or parse degrades to a link-only row**, and the response
  says how many did so.
- `CompanyFilings` walks at most 5 pages (50 rows each) and reports truncation.
- PDF downloads are capped at 25 MB; a larger file is refused with its URL.

## Worked example — SM Investments (SM, cmpyId 599), verified live 2026-08-29

`CompanyInsiders`:

| Person | Position | Announced | Transaction | Trade date | Shares | Holdings after |
|---|---|---|---|---|---|---|
| Henry T. Sy, Jr. | Vice Chairman | 2025-08-19 | Acquired | 2025-08-12 | 2,771,777 | direct 1,861,182, indirect 77,788,965 |
| Teresita T. Sy | Vice Chairperson | 2025-08-19 | Acquired | 2025-08-12 | 2,771,776 | direct 25,440,594, indirect 63,278,868 |
| Harley T. Sy | Executive Director | 2025-08-19 | Disposed | 2025-08-12 | -2,267,762 | direct 87,604,857, indirect 3,112,679 |

`CompanyOwners` (POR-1, report date 2026-06-30):

| Holder | Category | Total shares | % of outstanding |
|---|---|---|---|
| Harley T. Sy | Directors | 90,717,536 | 7.46% |
| Teresita T. Sy | Directors | 88,719,462 | 7.3% |
| Hans T. Sy | Principal/Substantial Stockholders | 101,951,900 | 8.38% |
| Herbert T. Sy | Principal/Substantial Stockholders | 101,865,772 | 8.38% |

`CompanyFinancials` (17-A, period ended 2025-12-31): Total Assets ₱1,811,801,000;
Gross Revenue ₱681,733,000; Net Income After Tax ₱123,772,000; EPS (basic) ₱74.16.

## Threshold / disclosure regime

Named from what the templates themselves cite, not assumed:

- Form **13-1** cites *"SRC Rule 23 (SEC Form 23-B) and Section 13 of the Revised Disclosure
  Rules"*.
- Form **17-7** cites *"SRC Rule 23 and Section 17.5 of the Revised Disclosure Rules"*.
- Form **POR-1** cites the *"Amended Rule on Minimum Public Ownership"*.

So the regime this package reports is **SRC Rule 23 beneficial ownership + the PSE Amended
Rule on Minimum Public Ownership** — explicitly **not** SRC Rule 18, which governs SEC Forms
18-A/18-AS filed with the SEC rather than these PSE EDGE templates.

## Not supported, and why

- **Unlisted Philippine companies.** PSE EDGE covers PSE-listed issuers only. The national
  register is the SEC's **eFAST** (`efast.sec.gov.ph`), a login-walled React SPA whose
  AFS/GIS retrieval needs a registered account and **paid** document requests — no keyless
  structured feed. So there is no PH equivalent of the ACRA/DBD private-company resolver.
- **`PrivateRaises`.** The Philippines publishes no Form D equivalent as open data. Exempt-
  transaction notices (SRC Rule 10.1) go to the SEC, behind eFAST. Private placements by
  listed issuers do appear as ordinary disclosures — use `CompanyFilings`.
- **`CompanyCharges` / `PersonAppointments`.** No keyless Philippine open-data source for a
  security-interest register or a person-level directorship index. (Directors are named in
  POR-1 and in the GIS attachments, but neither is a queryable person index.)
- **`CompanyFilings` modes `latest_annual` / `latest_quarterly`.** PSE serves reports from a
  separate financial-reports index rather than as a normalized latest-report record; use
  `CompanyFinancials`, which returns the figures and the report link.
- **Full audited financial statements.** `CompanyFinancials` returns the headline statement
  PSE's own form carries. The complete audited statements are in the report's PDF
  attachments — reachable with `CompanyDocument` `mode="pdf"`.
- **17-7 bodies that are attachment-only.** Many beneficial-ownership filings carry only
  *"Please refer to the attached disclosure"* in the HTML body. Those rows name the
  reporting person and their relationship and stop there, with no invented figures.

## Rate limiting

`pseRateLimiter` — 90 requests per 60 s. PSE documents no limit; one filings call is up to 5
search pages and one insiders call adds up to 10 two-hop document reads, so a single bounded
call can legitimately spend ~25 requests. The budget never self-trips on one lookup while
cross-call abuse still trips it. A 429 from PSE surfaces as an honest rate-limit error.

## Provenance

Every endpoint, response shape and parameter here was verified live against
`edge.pse.com.ph` on **2026-08-29**, and the six intents were exercised end-to-end through
the built `dist/server.mjs` against SM Investments (`SM`), SM Prime (`SMPH`) and San Miguel
(`SMC`). The offline fixtures in `tests/fixtures/pse/` are verbatim captures of those
responses. The ToS quoted above was fetched from `/page/disclaimer.do` on the same date.

Two corrections to the [`SEASIA-TRIAGE.md`](../../SEASIA-TRIAGE.md) §5 finding were
established during the build: the disclosure search filters by `keyword`, not `companyId`;
and the financial-reports search requires an explicit date window.
