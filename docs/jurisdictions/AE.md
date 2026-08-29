# AE — Dubai Financial Market (DFM) — **Dubai only, not the whole UAE**

**Data source:** [Dubai Financial Market](https://www.dfm.ae/)'s keyless
`api2.dfm.ae` gateway — the **efsah** (`إفصاح`, "disclosure") feed
`/efsah/v1/prototype_efsah`, its `efsah_count` sibling, and the widget gateway's
`Command=LiteSecuritiesLists` issuer roster — plus the keyless document host
`feeds.dfm.ae/documents/efsah`. **Credentials:** none. **Licence:** exchange /
issuer copyright, no open-data licence — so this adapter is **link-first and
on-demand**, the same posture as the shipped `cninfo`, `bseIndia` and
`twseOpenApi` adapters. It never republishes DFM content in bulk.

Implemented from the live-verified [`NLMEA-TRIAGE.md`](../../NLMEA-TRIAGE.md) §2
finding, which ranked the UAE second of five MEA/TR markets — a clean keyless
JSON disclosure API with direct keyless PDFs, mechanically identical to the
shipped cninfo/HKEXnews paths — **with one material caveat, stated here first
because it is the thing most likely to mislead a caller.**

## ⚠️ Scope: this is Dubai, not the UAE

The UAE has two exchanges and two English-law free-zone registers. **Only Dubai
is reachable keyless from a server.** Verified from this box on 2026-08-29:

| Surface | Result | Consequence |
|---|---|---|
| **DFM** (Dubai) + Nasdaq Dubai | ✅ keyless JSON + keyless PDFs | served by this adapter |
| **ADX** (Abu Dhabi Securities Exchange) | ❌ `www.adx.ae` → **`403`** (Imperva/Cloudflare edge) | **not covered** |
| **DIFC** public register | ❌ `www.difc.ae/public-register` → persistent **`429`** Cloudflare bot-wall, including `/api/public-register/search` | not covered |
| **ADGM** registration authority | ❌ `registration.adgm.com/.../searchRegister` → **`403`** | not covered |

This matters more than a normal coverage gap, because **ADX carries the UAE's
largest listed issuers** — the ADNOC group, IHC, Aldar Properties, Alpha Dhabi,
e& (Etisalat). A caller who asks `AE` for one of those is asking for exactly the
half this library cannot see. So:

- Every AE tool response — resolve, filings, document, and each unsupported
  intent — carries the **Dubai-only note naming ADX, DIFC and ADGM and their
  actual status codes**, and states that an Abu Dhabi or free-zone issuer's
  absence is a coverage gap, **not** evidence that the issuer has nothing filed.
- `CompanyResolve` additionally detects the specific failure mode this creates.
  Asking for an ADX issuer used to return a tidy table of real Dubai issuers
  that shared only a generic word — "Aldar **Properties**" ranking Emaar
  Properties first — which reads as an answer. Candidates with **zero** token
  overlap are now dropped outright, and a result whose best row matched **only**
  on shared generic words ("Properties", "Holding", "PJSC") is headed with an
  explicit **"No confident match … do not read these rows as the issuer you
  searched for"** warning that names ADX as the issuer's likely home.

`adxservices.adx.ae` is alive and answers structured JSON `404`s to guessed
paths, so an ADX route may be possible with path discovery plus residential
egress. It is not possible keyless from a datacenter IP today.

## Accepted `company` inputs

A **DFM issuer symbol** — `EMAAR`, `EMIRATESNBD`, `SALIK`, `TALABAT`, `PARKIN`,
`DEWA`, `UPP`. Case-insensitive; symbols may contain `-` or `_`
(`TAKAFUL-EM`, `SALAM_BAH`). This is the id every other AE intent takes.

Or the **issuer's name in English or Arabic** — `Emaar Properties PJSC` or
`إعمار العقارية ش.م.ع` both resolve to `EMAAR`. The roster is loaded in both
languages and merged by symbol, so either script ranks. Arabic is carried as an
alias, rendered in the resolve table, and round-trips through the Markdown
output and every query string as UTF-8.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | DFM + Nasdaq Dubai listed securities — symbol, English **and Arabic** name, sector, listing venue. LEI enriched from GLEIF where a UAE match exists. |
| `CompanyFilings` | Per-issuer efsah disclosures, newest first, with a **direct keyless PDF per attachment**. Date window (`start_date`/`end_date` → the feed's own `from`/`to`), `limit`, and the feed's `general_meetings` / `financial_reports` type filter; any other `forms` term is a client-side text match. |
| `CompanyDocument` | The disclosure PDF by its efsah `r_path`: `metadata` (content type, size, last-modified), `xhtml` (text-layer extraction, paged, fenced as untrusted), `pdf` (download to disk, 25 MB cap, path + bytes + page count). |
| `CompanyInsiders` | Unsupported — see below. |
| `CompanyOwners` | Unsupported — see below. |
| `CompanyFinancials` | Unsupported — see below. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## The endpoints

```
POST https://api2.dfm.ae/web/widgets/v1/data
     Command=LiteSecuritiesLists&Language=en|ar          → 200, the issuer roster
GET  https://api2.dfm.ae/efsah/v1/prototype_efsah
     ?lang=en&announcement_type=Disclosure&symbol=EMAAR
     &from=&to=&types=&keyword=&cms_resources=true
     &take=20&skip=0&h7_datetime_format=yyyy-MM-dd HH:mm:ss  → 200 application/json
GET  https://api2.dfm.ae/efsah/v1/efsah_count?<same filters>  → 200 (row count)
GET  https://feeds.dfm.ae/documents/efsah/<r_path>            → 200 application/pdf
```

There is **no issuer-list endpoint under `efsah/v1`** — every such path
(`issuers`, `symbols`, `mw/v1/*`, `cms/v1/companies`) answers a structured
`{"statusCode":404,"message":"Resource not found"}`. The roster comes from the
site's own widget gateway command, harvested from the DFM front end's Nuxt
bundle. It returns securities grouped by class; this adapter keeps
**`Equities`, `REITs`, `ETFs` and `Funds`** and drops `Bonds` and `Sukuks`,
which are hundreds of mostly-matured debt tranches ("Emaar Sukuk Ltd 6.400%
18-07-2019") sharing an issuer with an equity line — they would swamp a name
search without adding a disclosure filer. Every symbol observed in the
disclosure feed belongs to a kept list.

## `transaction_id` scheme

**The efsah resource's own `r_path`, exactly as `CompanyFilings` returned it:**

```
/2026/Aug/7/52433569-0887-4100-ba14-58ee448166f1/Emaar Properties H1 2026 Press Release   English.P.pdf
```

Chosen over the disclosure `id` or the resource `id` (both UUIDs the feed also
carries) because:

1. **It fully determines the document URL.** The path hangs directly off
   `feeds.dfm.ae/documents/efsah`, so `CompanyDocument` needs no second lookup.
2. **There is no reverse lookup.** No keyless endpoint turns a resource UUID
   back into a path, so a UUID-based id would be unusable on its own.
3. **A disclosure can carry several documents.** The disclosure `id` is not
   unique per file — Emirates NBD's Q2 2026 disclosure carries the statements
   *and* a results presentation, and each needs its own fetchable id. This is
   why `CompanyFilings` emits **one row per attached document**, and why a
   results announcement can legitimately appear twice in the table.

A full `https://feeds.dfm.ae/documents/efsah/…` URL is accepted too. The rebuilt
URL's host is **validated to `dfm.ae` or a subdomain over HTTPS before any
fetch** (the SSRF guard the HK and FR routes use); an off-host or non-HTTPS id
is refused with an explicit message and **no request is issued**.

## Why owners, insiders and financials are unsupported

Not a wall — an absence. **DFM's efsah feed has exactly one structured
`announcement_type`, `Disclosure`**, and its only machine-readable narrowing is
`general_meetings` / `financial_reports`. Everything else is free text:

- **Financial results** arrive as statement and press-release **PDFs** under the
  `financial_reports` type. There is no XBRL, no normalized facts API, and no
  key-data table with a stable shape across issuers. Use `CompanyFilings` with
  `forms: ["financial_reports"]` for the statements, then `CompanyDocument`
  (`mode: "xhtml"`) for their text.
- **Board changes and related-party dealings** appear as headlines like
  "Resignation of BOD member and CEO" or "Formation Of A Temporary Committee" —
  disclosure PDFs, not an insider-dealing register.
- **Ownership disclosure** likewise reaches DFM as free-text PDFs. Neither DFM
  nor the **SCA** (Securities and Commodities Authority) publishes a keyless
  structured major-shareholder or threshold-crossing register.

Each unsupported intent says this specifically, and repeats the Dubai-only note.

## Caveats

- **`take` is clamped to 20 upstream.** `take=50`, `take=100` and `take=500` all
  return exactly 20 rows, so a larger `limit` pages on `skip` — capped at 5
  pages (100 rows) per call, and the response says so when the cap was reached.
- **The gateway intermittently answers `200 text/html` with a zero-length
  body** — measured at roughly 1 request in 20 against an otherwise-valid query.
  This is retried once; a persistent empty body is surfaced as an explicit
  upstream glitch whose message states it is **not** an empty result for the
  issuer. It must never be conflated with `{"root":[]}`, the real
  end-of-results envelope, which would report "no disclosures" for an issuer
  with hundreds.
- **Pre-2012 rows come from DFM's `/Archive/` store** and behave differently:
  their PDFs are often **scanned with no text layer** (`mode: "xhtml"` reports
  that honestly, with the extractor's own note, and still returns the link), and
  some are filed as a **ZIP of the statements rather than a PDF**
  (`/Archive/Financial Reports/upp_2011_Q3_e.zip`, verified live). A ZIP is
  reported as a ZIP — *"the transaction_id is correct … this release does not
  unpack it"* — never as a wrong id.
- **Dates.** The feed is asked for `yyyy-MM-dd HH:mm:ss` stamps rather than its
  default `MMM dd, yyyy hh:mm:ss a`, so date parsing does not depend on an
  English month table; the named form is still parsed as a fallback.
- **Arabic filings.** `mode: "xhtml"` on an Arabic PDF returns Arabic in
  **logical order without shaping or bidi reordering** — correct UTF-8, but not
  a rendered view. The response says so. English and Arabic renditions of the
  same disclosure are separate rows with separate `r_path`s.
- The roster carries **no LEI and no ISIN**. LEIs come from GLEIF by legal name,
  bounded to the top 3 candidates and best-effort — a GLEIF failure leaves the
  DFM match untouched. GLEIF files UAE entities under **ISO 3166-2 emirate
  subdivisions** at least as often as a bare `AE` (Emaar is `AE-DU`), so the
  match accepts the `AE-` prefix; a non-UAE same-named entity is rejected.
- The roster includes **delisted and historic securities** (EMAARMALLS, ARTC,
  MARKA, TAMWEEL). They resolve and their historic disclosures are readable,
  which is the useful behaviour, but a hit is not proof of a current listing.
- **Absence is not proof.** Neither an empty filings window nor an unmatched
  name shows an issuer has nothing on file — it may be listed on ADX.

## Live verification

Verified through the built artifact (`dist/server.mjs`) on 2026-08-29, keyless:

| Call | Result |
|---|---|
| `CompanyResolve` `EMAAR` | Emaar Properties PJSC / **إعمار العقارية ش.م.ع**, Real Estate, Listed (DFM) |
| `CompanyResolve` `Emirates NBD` | EMIRATESNBD — Emirates NBD PJSC / **الامارات دبي الوطني ش.م.ع**, Financials |
| `CompanyResolve` `إعمار العقارية ش.م.ع` | EMAAR, "Exact normalized alias match" |
| `CompanyResolve` `Aldar Properties` (ADX) | **"No confident match"** warning + ADX pointer; no false Dubai answer |
| `CompanyFilings` `EMAAR` limit 6 | 2026-08-07 H1 press release, 2026-08-07 Q2 statements, 2026-08-05 earnings call, … each with an `r_path` and a `feeds.dfm.ae` PDF |
| `CompanyFilings` `EMIRATESNBD` 2026-01-01→2026-06-30 | 5 rows, all inside the window (RBL Bank acquisition completion, Q1 2026 statements) |
| `CompanyFilings` `SALIK` `["financial_reports"]` | Q2 2026, Q1 2026, FY2025 and preliminary FY2025 statements |
| `CompanyDocument` metadata | `application/pdf`, 554,089 bytes, `Fri, 07 Aug 2026 03:57:29 GMT` |
| `CompanyDocument` xhtml (English) | 12,813 chars — *"Net Profit before Tax increased by 23% to AED 12.8 billion"* |
| `CompanyDocument` xhtml (Arabic) | 14,488 chars of Arabic, logical order, UTF-8 intact |
| `CompanyDocument` pdf | 554,089 bytes, 6 pages, saved to disk |
| `CompanyDocument` xhtml on a 2011 archive PDF | *"no reliable extractable text layer"* + link (honest degradation) |
| `CompanyDocument` xhtml on a 2011 archive ZIP | *"filed this disclosure as a ZIP archive … the transaction_id is correct"* |
| `CompanyDocument` off-host id | Refused, no request issued |
| `CompanyOwners` / `CompanyInsiders` / `CompanyFinancials` | Honest unsupported with the specific reason + the Dubai-only note |
