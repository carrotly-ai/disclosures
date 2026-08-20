# HK (Hong Kong) + SG (Singapore) adapter — open-data feasibility finding

> **Status:** finding only — no adapter or tool change ships with this document. Records
> the research for future `HK` and `SG` jurisdiction adapters behind the existing intent
> tools, using only free, keyless-or-trivial-free-key sources, reliably parseable, and
> served under the repo's established link-first + on-demand-fetch model, with **zero
> runtime dependencies**.

**Question:** can `HK` and `SG` jurisdiction adapters surface listed-company disclosures,
company resolution, insider/ownership data, financials, filed-document content, charges,
and appointments under the existing intent tools, on free open data only?

**Verdict — two very different markets:**

- **Hong Kong: BUILD.** `CompanyFilings` and `CompanyDocument` are **feasible and a
  standout** via **HKEXnews** — an official portal exposing keyless JSON search endpoints
  and direct, keyless disclosure PDFs across the *entire* SEHK/GEM securities universe
  (17,987 active + 872 inactive securities). Listed-issuer `CompanyResolve` rides the same
  source. This **materially extends** the existing CN `cninfo` HKEX mirror (which only
  reaches a China-cross-referenced subset). Everything else on HK is honestly **not
  feasible**: `CompanyOwners`/`CompanyInsiders` sit behind the Disclosure-of-Interests
  system (**captcha + ASP.NET form wall**), `CompanyFinancials` is locked in report PDFs,
  and the Companies Registry (charges, private-company resolution/documents) is **paid**.

- **Singapore: THIN — CompanyResolve only, or skip.** The **ACRA** dataset on
  **data.gov.sg** is an excellent keyless, Open-Data-Licensed resolver (UEN, status, type,
  incorporation date, **former names**, auditor firms) — genuinely feasible for
  `CompanyResolve`. But **every other SG intent fails the bar**: **SGX/SGXNet** (listed
  filings, substantial-shareholder and director-dealings announcements, financials,
  document PDFs) is **Akamai-walled to datacenter IPs *and* API-auth-gated** — blocked even
  through a real headless browser — and BizFile's officer/shareholder/financial extracts
  are **paid**. So SG is a one-intent adapter at best.

Assessed against **live** endpoints on **2026-08-21** from this box. Verification issuers:
**Tencent** (SEHK `00700`, internal HKEXnews `stockId 7609`) for HK; **ACRA** corporate
entities and Singapore Airlines / "AIRLINE" name searches for SG. Every endpoint,
parameter, and response fragment below was fetched from this box unless explicitly marked
unreachable.

---

## Per-intent verdict — Hong Kong (`HK`)

| Intent | HK feasibility | Primary source |
|---|---|---|
| `CompanyResolve` | ✅ feasible — **listed only** | HKEXnews `activestock_sehk_e.json` (name/code → internal stockId) + GLEIF; private cos ❌ (ICRIS paid) |
| `CompanyFilings` | ✅ feasible — **standout** | HKEXnews `titleSearchServlet.do` (keyless JSON) + `tierone/tiertwo` taxonomy |
| `CompanyInsiders` | ❌ not feasible | Director list (`dirsearch`) is session/anti-CSRF-walled; DI system captcha-walled |
| `CompanyOwners` | ❌ not feasible | Disclosure of Interests (`di.hkex.com.hk` / `sdinotice.hkex.com.hk`) — ASP.NET form + **captcha** |
| `CompanyFinancials` | ❌ not feasible | Figures live only inside annual-report PDFs (category 40000); no structured feed (same as CN) |
| `PrivateRaises` | ❌ not feasible | No Form D analogue |
| `CompanyDocument` | ✅ feasible — **standout** | HKEXnews `FILE_LINK` → direct keyless PDF (verified `200 application/pdf`) |
| `CompanyCharges` | ❌ not feasible | No free charges register (Companies Registry is paid) |
| `PersonAppointments` | ❌ not feasible | `dirsearch` "List of Directors" is session-gated, not a clean keyless feed |
| `OwnershipChain` | ✅ already global via GLEIF | GLEIF |

## Per-intent verdict — Singapore (`SG`)

| Intent | SG feasibility | Primary source |
|---|---|---|
| `CompanyResolve` | ✅ feasible — **standout (and the only one)** | ACRA on data.gov.sg `datastore_search` (UEN, status, type, former names, auditor, SSIC) + GLEIF |
| `CompanyFilings` | ❌ not feasible | SGX/SGXNet `api.sgx.com` — **Akamai datacenter-IP block + 401 auth** |
| `CompanyInsiders` | ❌ not feasible | SGXNet director dealings walled; ACRA gives only an officer *count*, no names; BizFile extract paid |
| `CompanyOwners` | ❌ not feasible | SGXNet substantial-shareholder announcements walled; no keyless source |
| `CompanyFinancials` | ❌ not feasible | SGX financials walled; ACRA/BizFile financial extracts paid |
| `PrivateRaises` | ❌ not feasible | No Form D analogue |
| `CompanyDocument` | ❌ not feasible | SGX PDF host (`links.sgx.com`) needs IDs from the walled search; Akamai blocks datacenter IPs anyway |
| `CompanyCharges` | ❌ not feasible | ACRA charges only via paid BizFile |
| `PersonAppointments` | ❌ not feasible | No keyless officer-name source (ACRA exposes count only) |
| `OwnershipChain` | ✅ already global via GLEIF | GLEIF |

✅ supported · ⚠️ partial · ❌ honest unsupported-jurisdiction explanation

---

## HK Source 1 — HKEXnews (`hkexnews.hk`) → `CompanyFilings`, `CompanyDocument`, `CompanyResolve`

HKEXnews is the official electronic-disclosure portal for **all** Hong Kong-listed issuers
(SEHK Main Board + GEM). Its Title Search front-end is a static SPA driven by **keyless
JSON reference files** and a **keyless JSON search servlet**; the servlet returns document
metadata whose `FILE_LINK` is a directly fetchable PDF. No key, no login, no token. The
data-file paths and search action come straight from the site's own
`/ncms/eds/titlesearch/config.js`.

- **Search page:** `https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en`
- **Search servlet:** `https://www1.hkexnews.hk/search/titleSearchServlet.do`
- **Reference JSON (verified `200 application/json`):**
  - `/ncms/script/eds/activestock_sehk_e.json` — **17,987** active securities (1.06 MB)
  - `/ncms/script/eds/inactivestock_sehk_e.json` — **872** delisted/inactive
  - `/ncms/script/eds/tierone_e.json` — headline-category taxonomy (11 top codes)
  - `/ncms/script/eds/tiertwo_e.json` / `tiertwogrp_e.json` — sub-category taxonomy (~30 KB)
- **Anti-bot posture:** none observed for these endpoints. A plain `Mozilla/5.0`
  User-Agent (optionally a `Referer`) succeeded on every call. (An Akamai "sensor" script
  is referenced on the HTML page, but the JSON reference files, the search servlet, and the
  PDFs are reachable without it.)
- **Licence / redistribution:** **not** an open-data licence — see the honest note below.

### Resolution seed — the stock-list JSON

Each active-securities row is `{"i":<stockId>,"c":"<5-digit code>","n":"<short name>","s":<seq>}`.
Verified (Tencent):

```json
{"i":7609,"c":"00700","n":"TENCENT","s":15375}
```

`i` is the **internal HKEXnews stockId** the search servlet requires (not the public
5-digit code, and *not* the `s` field — verified: `stockId=7609` returns rows, `stockId=15375`
returns `[]`). So `HK` `CompanyResolve` for a listed issuer is: fetch/cache the stock list,
match by 5-digit code or name → carry `stockCode` + internal `stockId`. Private companies
do **not** resolve here (ICRIS, paid — see HK Source 3).

### `CompanyFilings` → ✅ feasible (standout)

`GET titleSearchServlet.do` with the internal `stockId`, a date range, and `searchType=0`
returns a JSON envelope whose `result` is a stringified array of filing rows. **Verified
live** (Tencent, `stockId=7609`, Jul–Aug 2026, `rowRange=3`):

```json
{"result":"[{
  \"NEWS_ID\":\"12292377\",
  \"TITLE\":\"Next Day Disclosure Return\",
  \"LONG_TEXT\":\"Next Day Disclosure Returns - [Share Buyback]\",
  \"STOCK_CODE\":\"00700<br/>80700\",
  \"STOCK_NAME\":\"TENCENT<br/>TENCENT-R\",
  \"DATE_TIME\":\"20/08/2026 17:35\",
  \"FILE_TYPE\":\"PDF\",  \"FILE_INFO\":\"88KB\",
  \"FILE_LINK\":\"/listedco/listconews/sehk/2026/0820/2026082000673.pdf\"
}, ...]","hasNextRow":false,"rowRange":3,"lang":"E"}
```

Key params (all verified): `market=SEHK`, `stockId=<i>`, `searchType=0` (single-stock),
`fromDate`/`toDate` (`YYYYMMDD`), `sortDir=0`, `sortByOptions=DateTime`, `rowRange=<n>`,
`lang=E`, and category filters `t1code` / `t2Gcode` / `t2code` (default `-2` = all). This is
a genuine per-issuer filing index — the HK analogue of SEC EDGAR's submissions feed —
reachable as **JSON, not HTML scraping**. Maps directly onto `FilingRecord`:
`description`/`form` = `TITLE`/`LONG_TEXT`, `filedDate` = `DATE_TIME`, `sourceUrl` =
`www1.hkexnews.hk` + `FILE_LINK`, `accession` = `NEWS_ID`, `category` from the taxonomy.

**Category taxonomy is keyless** (`tierone_e.json`, verified) — enables `forms`/category
filtering exactly like the CN adapter's periodic-report category codes:

```
10000  Announcements and Notices          40000  Financial Statements/ESG Information
20000  Circulars                          50000  Next Day Disclosure Returns
30000  Listing Documents                  51500  Monthly Returns
```

### `CompanyDocument` → ✅ feasible (standout)

Every filing row's `FILE_LINK` is a direct, keyless PDF on the same host. **Verified live:**

```
GET https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0820/2026082000673.pdf
→ 200  content-type: application/pdf  size: 90568 bytes  (PDF 1.7, 7 pages)
```

Mirrors the shipped `cninfo` / US EDGAR `CompanyDocument` pattern exactly (chain the
document URL off the filing the index already returned; reuse the 25 MB cap +
save-to-disk machinery). A `metadata`/save-to-disk mode is trivial; a `text` mode needs PDF
text extraction (out of scope for a zero-dep v1 — same honest limitation as CN/GB
image-only accounts).

### What HK-native HKEXnews **adds** over the existing CN `cninfo` HKEX mirror

The repo's `cninfo` adapter (`src/adapters/cninfo.ts`) already mirrors *some* HKEX filings
via the `hke` column (org-id prefix `gshk`, labelled "Hong Kong (via cninfo)"). A native
`HK`/HKEXnews adapter adds materially:

1. **Full universe vs. subset.** `cninfo`'s HKEX mirror only carries HK issuers that are
   cross-referenced into the mainland CSRC portal (predominantly H-share / dual-listed /
   Stock-Connect names). HKEXnews covers **all 17,987 active SEHK securities + 872
   inactive** — every Main Board and GEM issuer, including HK-only companies `cninfo` never
   mirrors.
2. **Source of record, native taxonomy.** HKEXnews is the authoritative primary filer, with
   native English titles and the official HKEX headline/sub-category taxonomy (Next Day
   Disclosure Returns, Monthly Returns, Financial Statements/ESG, etc.) — richer and more
   faithful than `cninfo`'s Chinese-context mirror metadata, with no mirror latency/gaps.
3. **Native document host.** PDFs served directly from `www1.hkexnews.hk`, not a re-hosted
   mirror.

Recommend the `HK` adapter **resolve HK listed issuers natively** and leave `cninfo`'s
`hke` path as-is for CN-context users (parallel to how listed FR issuers can resolve via
either the FR OAM or the EU ESEF path).

---

## HK Source 2 — Disclosure of Interests (DI) → `CompanyOwners` / `CompanyInsiders` ❌ (form + captcha wall)

Hong Kong's SFO Part XV substantial-shareholder and director "disclosure of interests"
regime is served through the DI system, **not** the HKEXnews Title Search. The legacy
`di.hkex.com.hk/di/summary/DSSSearch.aspx` now `302`s to an `Error.htm`; the live entry
points are:

- `https://di.hkex.com.hk/di/NSSrchMethod.aspx` — **verified `200`**, but an ASP.NET
  **WebForms** page ("Please select … stock code") requiring `__VIEWSTATE` navigation and a
  stock-code selection. HTML-only, stateful, no JSON API.
- `https://sdinotice.hkex.com.hk/` — **verified `200`**, redirects to `/Home/Login` and
  serves a page containing **`captcha`**. Login + captcha wall.

Neither exposes a keyless, structured feed. HK `CompanyOwners` and the
directors'-interests half of `CompanyInsiders` are therefore **not feasible** on free
parseable data. (The HKEXnews taxonomy does carry a "Change in Shareholding" announcement
sub-code `17200`, but that is issuer-side share-capital movement, not the shareholder-side
DI holdings table — it cannot substitute for the DI register.)

The related "List of Directors" search (`www3.hkexnews.hk/reports/dirsearch`, an ASP.NET
MVC app) posts to `/reports/dirsearch/search`; **verified** it responds `302` to a redirect
and `/reports/dirsearch/dirlist` responds `301`/`403` without a browser session and
anti-forgery token. It is session-gated HTML, not a clean keyless JSON feed, so
`PersonAppointments`/`CompanyInsiders` for HK listed directors is **not cleanly feasible**.

---

## HK Source 3 — Companies Registry (ICRIS / e-Services) → paid ❌

`https://www.e-services.cr.gov.hk/ICRIS3EP/` — **verified `200`** but a stateful `.do`
WebForms portal (`system/home.do?systemclock=…`). Hong Kong's company register (Cyber
Search Centre / ICRIS) has historically required a registered account and **charges
per-search / per-document fees** (company particulars, document images, charges). It is not
a free keyless search, so private-company `CompanyResolve`, `CompanyDocument`, and
`CompanyCharges` for HK are **not feasible** under the bar. Honest unsupported.

---

## HK Source 4 — data.gov.hk → marginal, not a resolver

data.gov.hk runs a **CKAN** API (`/en-data/api/3/action/package_search` — verified `200`).
The only company-registry-relevant dataset is the Companies Registry **"List of Newly
Incorporated / Registered / Re-domiciled Companies and Companies which have changed
Names"** (org: Companies Registry). **Verified** it is a **weekly delta** published as
per-week XLS/CSV, e.g. `RNC063L_20241230.csv`, fields:

```
Seq, Current Company Name (EN), Current Company Name (CN), BR Number,
Date of Incorporation, Date of Change of name
```

This is a **weekly newly-registered feed**, *not* a searchable full register — resolving a
company would mean ingesting hundreds of weekly CSVs, and it carries no filings/officers/
financials. Useful only as an optional name→BR-number enrichment for *recently* registered
entities. **data.gov.hk licence** (verified terms page) is free-to-reuse **with attribution
and an indemnity clause** — usable, but not needed for a v1. Recommend leaving it out.

---

## SG Source 1 — ACRA on data.gov.sg → `CompanyResolve` ✅ (standout, and the only feasible SG intent)

Singapore's Accounting and Corporate Regulatory Authority publishes **"ACRA Information on
Corporate Entities"** on data.gov.sg — a keyless, full-text-searchable registry over the
legacy **CKAN `datastore_search`** API. This is the SG analogue of the GB Companies House
resolver, including **previous-name history**.

- **Base:** `https://data.gov.sg/api/action/datastore_search?resource_id=<id>&q=<name>&limit=<n>`
- **Auth:** none. **Licence:** **Singapore Open Data Licence v1.0** (verified) — "worldwide,
  perpetual, royalty-free, non-exclusive licence to Use … whether commercially or
  non-commercially"; attribution required; personal data excluded. Cleanly redistributable.
- **Datasets:** split by first letter of entity name (26 resources), e.g. `'A'` =
  `d_8575e84912df3c28995b8e6e0e05205a`, `'N'` = `d_67e99e6eabc4aad9b5d48663b579746a`, `'S'`
  = `d_df7d2d661c0c11a7c367c9ee4bf896c1`. A thinner **consolidated** "Entities Registered
  with ACRA" (`d_3f960c10fed6145404ca7b821f263b87`) also exists.

**Verified live** (`'A'` dataset, `q=airline`, `limit=2`) → `total: 86`, `success: true`.
The alphabet-split datasets carry a **rich** field set:

```
uen, entity_name, entity_type_description, company_type_description,
entity_status_description, registration_incorporation_date, uen_issue_date,
former_entity_name1..15,               # previous-name history (like GB)
primary_ssic_code / _description,      # industry classification
no_of_officers,                        # COUNT only — no officer names
name_of_audit_firm1..5 / uen_of_audit_firm1..5,   # auditor(s)
block, street_name, building_name, postal_code, ...
```

Sample record (truncated):

```json
{"uen":"197600045Z","entity_name":"ASIAN AIRLINE LEASING PTE. LTD.",
 "entity_type_description":"Local Company",
 "company_type_description":"Exempt Private Company Limited by Shares",
 "entity_status_description":"Struck Off",
 "registration_incorporation_date":"1976-01-06",
 "primary_ssic_description":"MANUF/ASSEMBLY/REPAIR/SERVICING AIRCRAFT & PARTS",
 "no_of_officers":"6","issuance_agency_id":"ACRA"}
```

The consolidated dataset (verified, `total` in the tens of thousands per query) is thinner —
only `uen, uen_status_desc, entity_name, entity_type_desc, uen_issue_date, reg_street_name,
reg_postal_code`. **Recommendation:** use the **alphabet-split** resources (route the query
to the resource for the name's first letter, or a stock-code/UEN lookup) to get former
names + auditor + status; they are the stronger resolver.

`SG` `CompanyResolve` maps directly: `legalName` = `entity_name`, `sourceIdentifiers.uen` =
`uen`, `status` = `entity_status_description`, `aliases`/previous names = `former_entity_name*`,
plus incorporation date and SSIC. Full-text `q=` search returns a ranked `total`.

**Honest limits of ACRA:** it is a **registry snapshot**, not a filing/disclosure feed. It
exposes **no officer names** (only `no_of_officers`), **no shareholders**, **no financial
figures**, and **no charges** — those live in ACRA **BizFile** paid extracts (business
profile / financial statements), which fail the free bar. So ACRA underwrites
`CompanyResolve` and nothing else.

---

## SG Source 2 — SGX / SGXNet → walled ❌ (`CompanyFilings`, `CompanyInsiders`, `CompanyOwners`, `CompanyFinancials`, `CompanyDocument`)

SGX company announcements (SGXNet) — including substantial-shareholder notices and director
dealings — are published through `api.sgx.com`, historically a keyless JSON API. **It is now
comprehensively walled to server/datacenter traffic:**

- `GET https://api.sgx.com/announcements/v1.1/?...` — **`403` Access Denied** (Akamai
  `edgesuite.net` edge block) on a plain request from this box, and on `WebFetch`.
- Through a **real headless Chromium** (Playwright, `render_js`), the Akamai edge is passed
  but the origin returns **`401 {"message":"Unauthorized"}`** — the API additionally
  requires an authorization token the public site mints client-side.
- The **main site** `https://www.sgx.com/securities/company-announcements` itself returns
  **`403` Access Denied** to headless Chromium from a datacenter IP — i.e. Akamai blocks the
  whole domain from non-residential egress, so even a Playwright-injected `fetchFn` (the
  repo's anti-bot escape hatch for BSE India) **cannot reach the token flow** from a server.
- `api.sgx.com/announcements/v1.0` → `403`; `api2.sgx.com` → `404`. The PDF host
  `links.sgx.com/1.0.0/corporate-announcements/...` only `302`-redirects a *known*
  announcement id — useless without the walled search to enumerate ids.

This is a **harder wall than BSE India** (which is merely throttled and works with an
injected browser `fetchFn`): SGX blocks datacenter IPs at the CDN edge *and* auth-gates the
API. For a server-hosted MCP, SG listed-company filings, insiders, owners, financials, and
document PDFs are all **not feasible**. Honest unsupported.

---

## SG Source 3 — MAS → not relevant ❌

MAS `eservices.mas.gov.sg` API paths probed returned `404` (no keyless FI-directory JSON at
the guessed routes), and — more fundamentally — MAS holds a **financial-institution
licensing register**, not company filings/insiders/owners/financials. It maps to no
existing intent cleanly. Note as out of scope, not a disclosure source. (MAS's data.gov.sg
open datasets are macro series — exchange rates, money supply — irrelevant to these
intents.)

---

## Auth / licence / limits summary

| Source | Auth | Licence | Reachable from box | Verdict |
|---|---|---|---|---|
| HKEXnews reference JSON (`activestock`/`tierone`/`tiertwo`) | none | HKEX copyright (not open-licence) | ✅ verified `200/json` | listed resolve seed + taxonomy |
| HKEXnews `titleSearchServlet.do` | none | HKEX copyright | ✅ verified JSON rows | `CompanyFilings` ✅ |
| HKEXnews filing PDFs (`/listedco/listconews/...`) | none | HKEX/issuer copyright | ✅ verified `200/pdf` | `CompanyDocument` ✅ |
| HKEX DI (`di.hkex.com.hk`, `sdinotice.hkex.com.hk`) | login + **captcha** | — | ⚠️ form/captcha wall | owners/insiders ❌ |
| HKEXnews `dirsearch` (List of Directors) | session + anti-CSRF | — | ⚠️ 301/302/403 | appointments ❌ |
| HK Companies Registry ICRIS | account + **paid** | — | ⚠️ paid WebForms | private resolve/docs/charges ❌ |
| data.gov.hk (CKAN) | none | free + attribution + indemnity | ✅ verified | marginal enrichment only |
| ACRA on data.gov.sg (`datastore_search`) | none | **Singapore Open Data Licence v1.0** | ✅ verified | `CompanyResolve` ✅ |
| ACRA BizFile (officers/shareholders/financials/charges) | **paid** | — | — | insiders/owners/financials/charges ❌ |
| SGX `api.sgx.com` / SGXNet | **token** | — | ❌ `403` (Akamai) + `401` (auth) | filings/owners/insiders/financials/docs ❌ |
| SGX `www.sgx.com` (site) | — | — | ❌ `403` to headless Chromium (datacenter IP) | no `fetchFn` escape hatch |
| MAS `eservices.mas.gov.sg` | — | — | ⚠️ `404` on probes; wrong domain | not a disclosure source |
| GLEIF | none | CC0 | ✅ HK+SG global | `OwnershipChain` ✅ |

**Honest licence note (HKEXnews).** Unlike info-financiere (etalab-2.0), data.gov.sg
(Singapore Open Data Licence), or GLEIF (CC0), **HKEXnews content is copyrighted** — HKEX's
terms state copyright in the materials "may belong to HKEX, to the author or to any other
party" and that "reproduction, distribution, use and/or linking without consent … is not
permitted." This is **the same posture as the already-shipped `cninfo`, `bseIndia`, and
`twseOpenApi` adapters** (official portals, no open-data licence). The repo's model does not
*redistribute* documents: it returns the **official source link** and fetches document
content **on demand** for the end user, citing the source — exactly as it does for cninfo/
BSE/TWSE/EDGAR. Framed that way, HKEXnews is on par with accepted precedent; it should not
be treated as a bulk-redistributable open dataset, and the stock-list/taxonomy JSONs should
be used as internal lookups, not re-published.

---

## Recommended implementation order + effort

| Priority | Work | Why | Effort |
|---|---|---|---|
| **1** | **HK: HKEXnews `CompanyFilings` + `CompanyDocument`** (cache stock-list JSON → resolve stockId; `titleSearchServlet.do` → filing index; `FILE_LINK` → keyless PDF) | One keyless JSON source, no scraping, entire SEHK/GEM universe, direct PDFs, chains filings→document exactly like `cninfo`/US EDGAR. Fills **two** intents and extends the CN mirror to full HK coverage. Highest value, lowest risk. | **S–M**: one servlet query builder + row mapper + stock-list cache; document path reuses the 25 MB cap / save-to-disk. No new runtime dep. |
| 2 | **HK: HKEXnews listed `CompanyResolve`** (stock-list JSON, code/name → stockCode + internal stockId; carry GLEIF LEI/ISIN) | Lets HK listed issuers resolve natively and bridge to GLEIF; prerequisite already built for #1. | **S**: same cached JSON. |
| 3 | **SG: ACRA `CompanyResolve`** (data.gov.sg `datastore_search`, alphabet-split resources; UEN, status, type, former names, auditor) | Only clean, open-licensed SG intent; strong resolver with previous-name history. Worth shipping **only if** a resolve-only SG is acceptable. | **S**: one CKAN GET shape + letter routing; Open Data Licence. |
| — | data.gov.hk newly-incorporated enrichment | Recent-registration name→BR-number only. | Defer. |
| ✋ | **HK**: `CompanyOwners`, `CompanyInsiders`, `CompanyFinancials`, `CompanyCharges`, `PersonAppointments`, private `CompanyResolve`/`CompanyDocument` | DI captcha-walled; financials PDF-locked; Companies Registry paid; dirsearch session-gated. | Honest unsupported. |
| ✋ | **SG**: `CompanyFilings`, `CompanyInsiders`, `CompanyOwners`, `CompanyFinancials`, `CompanyDocument`, `CompanyCharges`, `PersonAppointments` | SGX/SGXNet Akamai+auth-walled to datacenter IPs (no `fetchFn` escape hatch); BizFile paid; MAS irrelevant. | Honest unsupported. |

**Single highest-value first adapter across both markets:** the **HKEXnews
`CompanyFilings` + `CompanyDocument`** pair. It is a keyless JSON API (not HTML scraping),
spans every Hong Kong listed issuer's regulated filings with direct PDF URLs, delivers two
intents from one source using mechanics the codebase already has (`cninfo`/US EDGAR), and
strictly extends the existing CN HKEX mirror. **Singapore is a distant second and thin** —
ACRA `CompanyResolve` is the *only* feasible SG intent; ship it as a resolve-only `SG`
adapter if desired, or skip SG until a keyless SGX path exists (unlikely while Akamai blocks
datacenter egress). An honest thin SG verdict beats an optimistic one: do **not** promise SG
filings/owners/insiders/financials.
