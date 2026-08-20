# AU (Australia) adapter — open-data feasibility finding

> **Status:** finding only — no adapter or tool change ships with this document. Records
> whether an `AU` jurisdiction adapter can sit behind the existing intent tools using only
> **free, keyless-or-trivial-free-key, redistributable, reliably parseable** data with
> **zero runtime dependencies**.

**Question:** can an `AU` adapter surface Australian company registration, listed-company
announcements, substantial-holder / director-interest disclosures, officer/appointment data,
and financials under the existing intent tools, on free open data only?

**Verdict: thin PARTIAL — build a narrow adapter, do not chase the interesting intents.**
The only cleanly **redistributable** Australian sources are the Commonwealth open-data
datasets on **data.gov.au** (ASIC registers, ABN Lookup — all **CC BY 3.0 AU**) and **GLEIF**.
Those carry `CompanyResolve` and a *narrow* `PersonAppointments` (banned/disqualified persons
only). Everything that makes Australian disclosure interesting — market announcements,
Form 603/604/605 substantial-holder notices, Appendix 3Y director-interest notices, annual
reports/financials — lives on the **ASX website**, whose JSON endpoints are keyless and
parseable **but whose Terms of Use explicitly prohibit redistribution, commercial use, and
even "download onto a computer."** The ASX path is therefore technically easy and **legally
disqualified** under the project's redistributability bar. This is the decisive finding.

Assessed against **live** endpoints on **2026-08-21**. Verification issuers: **BHP Group
Limited** (`ASX:BHP`, `ISIN AU000000BHP4`, `LEI WZE1WSENV6JSZFK0JC28`, `ACN 004 028 077`) and
**Commonwealth Bank** (`ASX:CBA`). Every endpoint, status, and response fragment below was
fetched from this box unless explicitly marked otherwise.

---

## Per-intent verdict

| Intent | AU feasibility | Primary source | Blocking reason if not ✅ |
|---|---|---|---|
| `CompanyResolve` | ✅ feasible | data.gov.au **ASIC Company Dataset** (CC-BY bulk) + **ABN Lookup** (free GUID, CC-BY) + GLEIF | — |
| `CompanyFilings` | ❌ not feasible (redistribution) | ASX announcements (markitdigital JSON) | ASX ToU forbids redistribution; feed also **capped at 5 latest/company** |
| `CompanyInsiders` | ❌ not feasible | Appendix 3Y director-interest notices = **ASX announcement PDFs** | ASX ToU + PDF-only + 5-item cap |
| `CompanyOwners` | ❌ not feasible | Form 603/604/605 substantial-holder notices = **ASX announcement PDFs** | ASX ToU + PDF-only + 5-item cap |
| `CompanyFinancials` | ❌ not feasible (AU-specific) | ASX annual-report PDFs / markitdigital stats | No free ESEF/XBRL; ASX ToU. Cross-listed AU issuers already in **US EDGAR** (20-F) |
| `PrivateRaises` | ❌ not feasible | — | No Form D analogue |
| `CompanyDocument` | ❌ not feasible (redistribution) | ASX PDF via `documentKey` | ASX ToU forbids download/redistribution |
| `CompanyCharges` | ❌ not feasible | PPSR | Pay-per-search (~A$2), no free bulk/API |
| `PersonAppointments` | ⚠️ partial | ASIC **Banned & Disqualified Persons/Orgs** (CC-BY) | Disqualification list only; directorship extracts are **paid** |
| `OwnershipChain` | ✅ already global via GLEIF | GLEIF (AU verified) | — |

✅ supported · ⚠️ partial · ❌ honest unsupported-jurisdiction explanation

The shape is the inverse of DE/FR: there **DE/FR** had keyless regulator databases (BaFin,
info-financiere) carrying owners/insiders/filings and a token-gate only on financials. In
**AU** the registry side is clean open data but the *disclosure* side (ASX) is a proprietary,
non-redistributable, rate-capped website. So AU is genuinely thinner than DE or FR.

---

## Source 1 — data.gov.au ASIC + ABN datasets (CKAN) → `CompanyResolve`, partial `PersonAppointments`

Commonwealth open data, served through the standard **CKAN Action API**
(`https://data.gov.au/data/api/3/action/…`). `package_search?q=ASIC` returns **166** datasets.
All the relevant ones are **Creative Commons Attribution 3.0 Australia (`cc-by`)** — verified
per-dataset via `package_show` `license_id`. Redistributable with attribution; **no key**.

### ASIC Company Dataset (`asic-companies`) → `CompanyResolve` ✅

`GET /api/3/action/package_show?id=asic-companies` → `license_id: cc-by`, updated **weekly
every Tuesday** (per dataset notes), 3 resources. The data resource is a **398 MB tab-delimited
CSV** (also a 78 MB ZIP):

```
CSV  Company Dataset - Current  size 398,809,851
  https://data.gov.au/.../download/company_202608.csv
ZIP  Company Dataset - Current  size  78,872,818
```

Verified header + rows (range request, real bytes — note it is **tab-separated** despite the
`.csv` name):

```
Company Name  ACN  Type  Class  Sub Class  Status  Date of Registration  Date of Deregistration  Previous State of Registration  State Registration number  Modified since last report  Current Name Indicator  ABN  Current Name  Current Name Start Date
LOVINI HOLDINGS PTY LTD  000000019  APTY  LMSH  PROP  REGD  08/01/1990    NSW  46869041      89000000019  MONAKA PTY LTD  28/01/2016
CHRISTENSEN & ASSOCIATES PTY LTD  000000028  APTY  LMSH  PSTC  REGD  15/09/1987    NSW  40398926    Y  91000000028
```

This gives AU a full national company register keyed by **ACN** (and cross-linked **ABN**),
with legal name, type, status (`REGD`/`DRGD`/…), and registration/deregistration dates — a
clean `Entity` mapping. **Honest friction:** it is a **bulk file, not a query API** — there is
no per-company `datastore_search` endpoint on this resource, so resolving one company means
downloading + indexing the weekly 78 MB ZIP. That is consistent with the project's existing
large-reference-download cache pattern (OpenDART corp-code archive, EDINET code list), but it
would be the **largest** such download in the project. The lighter live alternative is Source 2.

### ASIC Banned & Disqualified Persons (`asic-banned-disqualified-per`) → `PersonAppointments` (partial) ⚠️

`license_id: cc-by`, updated **weekly**. Resources: CSV / TSV / XLSX (~1.3 MB). Verified header
+ rows:

```
REGISTER_NAME,BD_PER_NAME,BD_PER_TYPE,BD_PER_DOC_NUM,BD_PER_START_DT,BD_PER_END_DT,BD_PER_ADD_LOCAL,BD_PER_ADD_STATE,BD_PER_ADD_PCODE,BD_PER_ADD_COUNTRY,BD_PER_COMMENTS
"Banned and Disqualified Persons","ABBOTT, BILL","Banned Securities","#004289112","29/03/1994","29/03/1999","TEMPLESTOWE LOWER","VIC","3107","AUSTRALIA","No comment made"
"Banned and Disqualified Persons","AITKEN, WARREN JOHN","Banned Securities","#014859572","28/03/2001","","MAWSON","ACT","2607","AUSTRALIA","No comment made"
```

A companion `asic-banned-disqualified-org` dataset exists (organisations, same licence). This
is a real, redistributable, structured person-level enforcement feed — it maps to the
**disqualifications** facet of `PersonAppointments` (the DE/FR adapters return "not available"
there). **The honest limit:** this is a *ban list*, not a directorships index. ASIC's actual
**current & historical directorship extract** (person → companies they are/were a director of)
is a **paid** registry product, not open data — so AU cannot do the GB/FR-style "appointments"
mode. AU `PersonAppointments` can therefore honestly answer *"is this person banned or
disqualified, and for what period"* but **cannot** list a person's directorships.

### ABN Lookup — bulk extract (`abn-bulk-extract`) → supporting `CompanyResolve`

`license_id: cc-by`. Two ~500 MB ZIP parts of the full ABR register plus an XML schema + readme.
Keyless bulk, redistributable. Same "bulk not query" friction as the ASIC company file.

---

## Source 2 — ABN Lookup web services (abr.business.gov.au) → live `CompanyResolve` (free GUID)

The ABR JSON web service is the **live per-company** counterpart to the bulk extract. It is
**not keyless** — every call needs a registered **GUID**. Verified live: calling without a valid
GUID returns a structured refusal, not data:

```
GET https://abr.business.gov.au/json/AbnDetails.aspx?abn=49004028077&callback=cb
→ 200  text/javascript
cb({"Abn":"","AbnStatus":"", … ,"Message":"The GUID entered is not recognised as a Registered Party"})

GET https://abr.business.gov.au/json/MatchingNames.aspx?name=BHP&maxResults=5
→ {"Message":"The GUID entered is not recognised as a Registered Party","Names":[]}
```

The GUID is **free** (self-service registration at the ABR web-services portal), so this is a
**trivial-free-key** source in the same tier as `OPENDART_API_KEY` — acceptable under the bar,
but not keyless. Data is CC-BY. If AU ships, this is the cleaner live resolver (ACN/ABN/name →
entity) and avoids the 398 MB weekly download; gate it behind an optional `ABN_LOOKUP_GUID`
env var, degrading to the bulk file when absent.

---

## Source 3 — ASX website JSON (asx.api.markitdigital.com) → technically easy, legally disqualified

The ASX front end is backed by a keyless **markitdigital** JSON API. It works cleanly from this
box and is the *only* place Australian listed-company disclosures are aggregated. Every endpoint
below was verified live.

**Per-company announcements** (keyless, no token needed for the list):

```
GET https://asx.api.markitdigital.com/asx-research/1.0/companies/bhp/announcements?count=5
→ 200 application/json
{"data":{"displayName":"BHP GROUP LIMITED","items":[
  {"announcementType":"PERIODIC REPORTS","date":"2026-08-18T21:52:18Z",
   "documentKey":"2924-03122554-3A699070","fileSize":"17790KB",
   "headline":"2026 US Annual Report (Form 20-F)","isPriceSensitive":false,"url":""},
  … ],"symbol":"BHP","xid":"60947"}}
```

Substantial-holder and director-interest disclosures **are** in this feed as their own types /
headlines (verified on CBA):

```
SECURITY HOLDER DETAILS | Appendix 3Y - Jane McAloon   | 2924-03123763-2A1690837
SECURITY HOLDER DETAILS | Appendix 3Y - Alistair Currie | 2924-03123758-2A1690836
```

(Appendix 3Y = director's interest notice; Forms 603/604/605 = substantial-holder notices —
both appear here as announcement rows whose actual content is a **PDF**, exactly the FR "% is
inside the PDF" situation.)

**Document retrieval** works: `documentKey` → PDF via the front end's embedded public
`access_token`:

```
GET https://asx.api.markitdigital.com/asx-research/1.0/file/2924-03122554-3A699070?access_token=<frontend token>
→ 200 application/pdf  (BHP 20-F, 1028 pages, ~19 MB)
```

**Key statistics / income statement** are also keyless (`/companies/bhp/key-statistics`
returns `isin`, shares, and an `incomeStatement[]` array with revenue/netIncome).

### Two blockers, one fatal

1. **The feed is hard-capped at 5 items per company.** `count=5`, `count=20`, `count=50`,
   `count=200`, and `timescale`/`timeframe` variants **all return exactly the 5 most-recent**
   announcements (verified on BHP and CBA). The market-wide firehose
   (`/markets/announcements?count=100`) returns 100+ but **cannot be filtered by company** (a
   `securities=cba` param is ignored). So even ignoring licensing, there is **no keyless full
   per-company filing history** — only the latest five. Full history sits behind
   `asx-research-auth` (login) and, for older material, ASX's paid Historical Announcements.

2. **Terms of Use forbid redistribution — the fatal one.** ASX Terms of Use
   (`https://www.asx.com.au/legals/terms-of-use`, fetched live) state, verbatim:

   > **Permitted uses:** "…access the Site … **for your own information purposes only**,
   > including research, study or other **personal, non-commercial use**, but only if you keep
   > all content intact and in the same form as presented on the Site…"

   > **Prohibited uses:** "You agree not to: **modify, copy, reproduce, republish, frame,
   > download onto a computer, upload to a third party, post, transmit or distribute any
   > content on the Site** in any way except as expressly provided for in these terms, on the
   > Site or with ASX's prior written consent."

   > **Ownership:** "ASX and its licensors are the owners or licensees of all intellectual
   > property rights in the Site and in the content published on it… protected by copyright…
   > All such rights are reserved."

   Market Announcements are "the sole responsibility of the listed entity," but ASX asserts
   copyright over the Site and its content and grants only personal, non-commercial use.
   An MCP data source that fetches, reshapes, caches, and re-serves ASX announcement metadata
   and PDFs is precisely "reproduce / download / transmit / distribute," and the tool's purpose
   is not personal use. This **fails the "legally redistributable" bar** — the same bar that
   makes SEC EDGAR (public domain) and the ASIC/ABN CC-BY datasets fine. It is the reason ASX
   cannot back `CompanyFilings`, `CompanyInsiders`, `CompanyOwners`, `CompanyDocument`, or
   `CompanyFinancials`, despite being trivially parseable.

---

## Not feasible on free **redistributable** data (honest unsupported)

- **`CompanyFilings` / `CompanyDocument` / `CompanyInsiders` / `CompanyOwners`** — all live on
  ASX (announcements feed + Appendix 3Y + Forms 603/604/605), which is non-redistributable
  (ToU above) **and** 5-item capped **and** PDF-only for the holder/director content. No free,
  redistributable, structured alternative exists (ASIC's own company-document images are a paid
  registry extract). Honest unsupported.
- **`CompanyFinancials` (AU-specific)** — Australia has **no ESEF/inline-XBRL public filing
  regime**; the machine-readable financial-reporting channel (**SBR / Standard Business
  Reporting**) is business-to-government, not a public disclosure store. Listed-company annual
  reports are ASX-announced **PDFs** (ToU-restricted). The redistributable overlap is
  **SEC EDGAR**: dual-listed AU majors (BHP, Rio Tinto, etc.) file **Form 20-F** and are already
  covered by the shipped **US** adapter. Point users there; keep AU `CompanyFinancials`
  unsupported (same pattern as DE/JP).
- **`CompanyCharges`** — the national security-interest register is the **PPSR**
  (Personal Property Securities Register), which is **pay-per-search (~A$2)** with no free bulk
  or open API. Consistent with the cross-jurisdiction finding that `CompanyCharges` stays
  GB-only. Honest unsupported.
- **`PrivateRaises`** — no Form D / Reg D analogue in the Australian regime. Not feasible.

---

## Auth / licence / rate / redistribution summary

| Source | Auth | Licence | Redistributable? | Reachable from box |
|---|---|---|---|---|
| data.gov.au ASIC Company Dataset (CKAN) | none | **CC BY 3.0 AU** | ✅ yes | ✅ verified (398 MB CSV / 78 MB ZIP) |
| data.gov.au ASIC Banned & Disqualified Persons/Orgs | none | **CC BY 3.0 AU** | ✅ yes | ✅ verified |
| data.gov.au ABN Bulk Extract | none | **CC BY 3.0 AU** | ✅ yes | ✅ verified (2× ~500 MB ZIP) |
| ABN Lookup web services (JSON) | **free GUID** | CC BY (ABR) | ✅ yes | ✅ verified (refuses without GUID) |
| GLEIF | none | CC0 | ✅ yes | ✅ AU verified (`WZE1WSENV6JSZFK0JC28`) |
| ASX markitdigital announcements/file/stats JSON | none (token for PDF) | **ASX proprietary / © reserved** | ❌ **no — ToU prohibits** | ✅ technically works, **5-item cap** |
| ASIC directorship / company-document extracts | — | paid registry product | ❌ paid | — |
| PPSR (charges) | — | pay-per-search | ❌ paid | — |
| SBR (financials machine channel) | B2G credentials | not public | ❌ not public | — |

**Anti-bot / walls to flag:** none technical on the open-data or ASX APIs (both served cleanly
keyless). The wall here is **legal, not technical** — ASX's copyright/ToU — plus the ASX 5-item
per-company cap. ABN Lookup's GUID gate is the only key, and it is free.

---

## Recommended implementation order + effort

| Priority | Work | Why | Effort |
|---|---|---|---|
| **1** | **`CompanyResolve`** via ABN Lookup web services (free `ABN_LOOKUP_GUID`) with a fallback to the ASIC Company Dataset bulk index | Only cleanly redistributable AU resolver; ACN/ABN/name → `Entity`; live path avoids the 398 MB download | **S–M**: one JSON shape + a cached bulk-CSV indexer (reuse OpenDART-archive pattern) for the keyless fallback |
| 2 | **`PersonAppointments` (disqualifications only)** via ASIC Banned & Disqualified Persons/Orgs CSV | Real CC-BY structured enforcement feed; more than DE/FR give (they return "not available") | **S**: two small CSVs, weekly cache |
| — | `OwnershipChain` | already global via GLEIF (AU verified) | none |
| ✋ | `CompanyFilings`, `CompanyInsiders`, `CompanyOwners`, `CompanyDocument`, `CompanyFinancials`, `CompanyCharges`, `PrivateRaises` | ASX ToU non-redistributable (+5-item cap); PPSR/SBR/directorship extracts paid or B2G; cross-listed financials already in US EDGAR | Honest unsupported-jurisdiction explanations |

**Single highest-value first adapter:** **`CompanyResolve` from ABN Lookup + the ASIC Company
Dataset.** It is the one AU capability that is simultaneously free, redistributable (CC-BY),
and reliably parseable, and it slots into the existing resolver + large-reference-cache
machinery with no new runtime dependency.

**Overall recommendation: PARTIAL, and a genuinely thin one.** Ship AU only if a
resolve-plus-disqualifications adapter is worth a jurisdiction slot on its own; the disclosure
intents that would make AU compelling (announcements, substantial holders, director dealings,
financials) are **blocked by ASX's terms, not by technical difficulty**, and no free
redistributable substitute exists. A defensible alternative is to **defer AU entirely** and
note that dual-listed Australian issuers are already reachable via the US (EDGAR 20-F) and
global GLEIF paths. Do **not** ship an ASX-backed adapter under the current Terms of Use.
