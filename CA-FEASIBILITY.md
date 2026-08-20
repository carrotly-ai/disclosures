# CA (Canada) adapter — open-data feasibility finding

> **Status:** finding only — no adapter or tool change ships with this document.
> Records whether a `CA` jurisdiction adapter could surface
> Canadian corporate-disclosure data under the existing intent tools, using only free,
> keyless-or-trivial-free-key, **legally redistributable**, reliably parseable data with
> zero runtime dependencies.

**Question:** can a `CA` adapter surface Canadian regulated filings, insider trades, major
holdings, filed documents, and officer data under the existing intents, on free open data?

**Verdict: SKIP as a disclosures jurisdiction.** The entire Canadian securities-disclosure
surface — filings, insider reports, early-warning/major-holding reports, exempt-distribution
reports, and the filed documents themselves — lives in **two CSA-operated systems, SEDAR+
(`sedarplus.ca`) and SEDI (`sedi.ca`)**, and both fail the bar **twice over**: (1) they are
**hard anti-bot walled** — every request from this box, browser-UA and Playwright-rendered
alike, returns **`403 Forbidden` from a Radware (`server: rdwr`) WAF**; and (2) even setting
the wall aside, the **SEDAR+ Terms of Use explicitly prohibit automated access**, scraping,
database construction, and mass/commercial redistribution (quoted verbatim below). That is a
legal **NOT FEASIBLE** independent of the technical block, and it is disqualifying for a
redistributable open-data project.

The **only** clean, keyless, redistributable win in Canada is **`CompanyResolve` for
federal corporations** via **Corporations Canada** (bulk CSV under the Open Government
Licence – Canada, plus a keyless per-corporation JSON API) — but that is corporate-registry
resolution with **no disclosure surface attached**, so it does not make Canada a viable
*disclosures* jurisdiction. Separately, large Canadian issuers that cross-list in the US
already file **40-F / 6-K under the MJDS** and are captured today via `jurisdiction: "US"`
(SEC EDGAR): ~**4,100** 40-F filings are in EDGAR's full-text index and ~**1,600** 40-F
annual reports were filed in 2025 alone.

Assessed against **live** endpoints on **2026-08-20/21**. Verification issuers: **Shopify**
(federal corp #11125885, BN 721968915; also `SHOPIFY INC.` BC reg A0098975), **TELUS**, and
Corporations Canada demo corp #1007. Every endpoint, status code, and response fragment
below was fetched from this box unless explicitly marked unreachable.

---

## Per-intent verdict

| Intent | CA feasibility | Primary source | Blocker |
|---|---|---|---|
| `CompanyResolve` | ✅ feasible — **federal only** | Corporations Canada bulk CSV (OGL-Canada) + keyless JSON API; OrgBook BC (OGL-BC) for BC | — |
| `CompanyFilings` | ❌ not feasible (securities) · ⚠️ trivial registry-events only | SEDAR+ (walled + prohibited); CC API `activities[]` is corporate-register events, not filings | SEDAR+ 403 + ToU |
| `CompanyInsiders` | ❌ not feasible | **SEDI** (insider reports) | SEDI 403 + CSA ToU regime |
| `CompanyOwners` | ❌ not feasible | SEDAR+ early-warning / SEDI (major holdings) | SEDAR+/SEDI 403 + ToU |
| `CompanyFinancials` | ❌ not feasible (CA-specific) | SEDAR+ PDFs; **no Canadian XBRL/ESEF mandate** | walled + PDF-only; use `jurisdiction:"US"` for cross-listed |
| `PrivateRaises` | ❌ not feasible | 45-106F1 exempt-distribution reports on SEDAR+ | SEDAR+ 403 + ToU |
| `CompanyDocument` | ❌ not feasible | SEDAR+ document store | SEDAR+ 403 + ToU |
| `CompanyCharges` | ❌ not feasible | provincial PPSA registries (all paid) | no free national register |
| `PersonAppointments` | ❌ not feasible | no open director-name dataset (federal or provincial) | CC exposes only director *count*; OrgBook has no directors |
| `OwnershipChain` | ✅ already global via GLEIF | GLEIF | — (CA verified globally) |

✅ supported · ⚠️ trivial/partial · ❌ honest unsupported-jurisdiction explanation

**One intent lands (`CompanyResolve`, federal), and it is the one with the least disclosure
value.** Everything a corporate-disclosure tool actually exists to surface is behind the
SEDAR+/SEDI wall.

---

## Source 1 — SEDAR+ (`sedarplus.ca`) → the entire securities-disclosure surface — ❌ walled + prohibited

SEDAR+ (launched 2023-07-25) is the CSA's single national system; it **consolidated and
replaced** the old SEDAR, the National Cease Trade Order database, and the Disciplined List.
It holds essentially every intent a disclosures tool wants for Canada: continuous-disclosure
filings, financial statements (as PDFs), early-warning/major-holding reports, exempt-market
(45-106F1) reports, prospectuses, and the filed documents themselves.

### It is hard anti-bot walled (technical NOT FEASIBLE)

Every path returns `403 Forbidden` from a **Radware** bot manager (`server: rdwr`), including
the landing page, with a real browser User-Agent **and** with full Playwright JS rendering:

```
GET https://www.sedarplus.ca/landingpage/
→ HTTP/2 301 → https://www.sedarplus.ca → 403 Forbidden   (server: rdwr)

GET https://www.sedarplus.ca/csa-party/records/filing_selective_search.json → 403 Forbidden
GET https://www.sedarplus.ca/csa-party/service/searchRecords                → 403 Forbidden
```

Body of every response is a Radware challenge page:

```html
<title>403 Forbidden</title>
...
<h2>403 Forbidden</h2>
<h2>Transaction ID:</h2> 2d0fecac2a8be19c20c5306d7185ba6d094dc74122e18e14c6e8a4238044d383
```

Playwright render (scraper-mcp, `render_js: true`) from this box: identical
`status_code: 403`, `title: "403 Forbidden"`. There is no reachable JSON/CSV API surface; the
SPA's back-end (`/csa-party/...`) is behind the same wall. Even the public **Cease Trade
Orders** and **Disciplined List** searches now live inside SEDAR+ and share the wall.

### It is legally prohibited (legal NOT FEASIBLE — decisive on its own)

SEDAR+ **Terms of Use** (`sedarplus.ca/onlinehelp/terms-of-use/`, 301→
`systems.securities-administrators.ca/onlinehelp/terms-of-use/`), verbatim:

> *"using any robot, spider or other automatic device, software program or manual process to
> monitor, access, scrape, copy or interfere with any web pages or the content contained
> thereon on the SEDAR+ Public Website"*

is prohibited, as is repeatedly accessing/reloading pages so as to "unduly burden" the site.
On ownership and permitted use:

> *"copyright subsists in the SEDAR+ Public Website, including in the selection or arrangement
> of Content, and that such copyright is owned by the ASC or the other CSA Members"*

Permitted use is limited to "limited unaltered extracts or unaltered copies of the Public
Information" for informational/educational/research/internal purposes **only if** the user
does **not** "construct a database of any kind", does **not** use "automated means to use or
reproduce multiple pieces", and does **not** engage in "frequent, public, commercial or mass
distribution", with unauthorized reproduction exposing the user to injunctive relief.

An MCP adapter is, definitionally, an automated device building a database for redistribution
— squarely inside the prohibition. **This is a NOT FEASIBLE verdict regardless of the
technical wall**, and it cannot be engineered around with a nicer User-Agent or slower rate.

**Consequence:** `CompanyFilings`, `CompanyOwners`, `CompanyFinancials`, `PrivateRaises`, and
`CompanyDocument` for Canada are all blocked at the source. There is no second free national
store of regulated information (Canada has no info-financiere/EDGAR-style open OAM).

---

## Source 2 — SEDI (`sedi.ca`) → `CompanyInsiders` — ❌ walled + same CSA regime

SEDI is the CSA's System for Electronic Disclosure by Insiders — the Canadian analogue of
SEC Section 16 filings (named insiders, buy/sell, holdings). Historically an unfriendly
JSP/servlet web form; today it is behind the **same Radware wall**:

```
GET https://www.sedi.ca/                       → 403 Forbidden   (server: rdwr)
GET https://www.sedi.ca/sedi/SVTStartServlet   → HTTP/2 403      (server: rdwr)
```

No JSON/CSV export exists, the form is 403 to automated clients, and SEDI is governed by the
same CSA public-systems terms as SEDAR+. `CompanyInsiders` for Canada is **not feasible** —
and, unlike DE (BaFin DealingsInfo) which the server ships, there is no keyless machine-
readable alternative. Note also that Canadian issuers that are US foreign private issuers are
**exempt from Section 16**, so their insider data does *not* appear on EDGAR either.

---

## Source 3 — Corporations Canada (`ised-isde.canada.ca` / `www.ic.gc.ca`) → `CompanyResolve` (federal) — ✅ the one clean win

The federal corporate registry is genuinely open, keyless, and licensed for redistribution.
**Two** access modes, both live-verified:

### 3a. Bulk dataset — "Federal Corporations" (open.canada.ca CKAN)

- **Dataset:** `0032ce54-c5dd-4b66-99a0-320a7b5e99f2`, publisher ISED / Corporations Canada.
- **Licence:** **Open Government Licence – Canada** (`ca-ogl-lgo`) — redistributable with
  attribution. ✅ passes the bar.
- **Files (CloudFront, keyless, `text/csv`), updated ~daily**, split active/inactive ×
  CBCA/non-CBCA, EN+FR. Verified download:

```
GET https://d4bf66bykfyaf.cloudfront.net/corporations-active-cbca-en.csv
→ 200  content-type: text/csv; charset=utf-8  size: 103,461,335 bytes  (643,951 rows)
```

Header (18 columns):

```
Corporation number, Business number (BN), Corporate name - form 1, Corporate name - form 2,
Governing legislation, Status, Status Detail, Anniversary date, Year of last annual filing,
Date of last annual meeting, Street, Street 2, City/town, Province/territory, Country,
Postal code, Minimum number of directors, Maximum number of directors
```

Verified `grep -i shopify` rows (real):

```
11125885,721968915,SHOPIFY STUDIOS HOLDINGS INC.,,Canada Business Corporations Act,Active,,2018-12-03,2025,2025-12-03,151 O'Connor Street,Ground Floor,Ottawa,ON,CA,K2P 2L8,1,10
13480640,767887607,Shopify Quebec Inc.,,Canada Business Corporations Act,Active,,...,ON,CA,...
16500749,701010357,Shopify Payment Activities Inc.,,Canada Business Corporations Act,Active,,...
```

This is a clean name→(corporation number, BN9, status, address, governing act) resolver for
**federal** corporations. **It carries no director names** (only min/max director *counts*),
and no securities identifiers (no ISIN/ticker/CIK).

### 3b. Live per-corporation JSON API (documented, keyless)

Documentation: *"Accessing federal corporation JSON datasets"*
(`ised-isde.canada.ca/eic/site/cd-dgc.nsf/eng/cs07265.html`). Lookup is **by corporation id
or BN9**, not by name (name search comes from the bulk CSV):

```
GET https://www.ic.gc.ca/app/scr/cc/CorporationsCanada/api/corporations/11125885.json?lang=eng
→ 200 application/json;charset=utf-8
```

Real (parsed) response for Shopify Studios Holdings:

```json
{ "corporationId": "...", "status": "Active", "act": "Canada Business Corporations Act",
  "corporationNames": [{"CorporationName":{"name":"SHOPIFY STUDIOS HOLDINGS INC.","current":true}}],
  "businessNumbers": {"businessNumber": "721968915"},
  "directorLimits": {"minimum": 1, "maximum": 10},
  "annualReturns": [{"annualReturn":{"yearOfFiling":"2025"}}, {"..2024.."}, {"..2023.."}],
  "activities":  [{"activity":{"activity":"Incorporation","date":"2018-12-03"}}] }
```

Notes: the legacy host `www.ic.gc.ca/app/scr/cc/CorporationsCanada/api/...` serves live JSON
(200); the newer `ised-isde.canada.ca/cc/api/corporations/{id}.json` path currently `500`s, so
pin the legacy host. The `/cc/lgcy/api/corporations/search` path is a **catch-all error stub**
(`["could not find corporation search", ...]`) — there is **no** keyword-search JSON endpoint;
resolve names from the bulk CSV, then enrich per-corp via this API.

### Why this does not rescue the jurisdiction

The CC `activities[]` array (Incorporation, By-Laws Filing, Amendment, annual returns) is a
**corporate-register event log, not a securities-filing index** — it never contains the
continuous-disclosure filings, financials, insider trades, or ownership data the intents
exist to surface. Mapping it to `CompanyFilings` would be a misleading label. So CC delivers
`CompanyResolve` (federal) cleanly and nothing else. Federal coverage also **excludes** the
many issuers incorporated provincially (Ontario, BC, Alberta, Québec).

---

## Source 4 — Provincial registries → resolution only, patchy, licence traps

- **OrgBook BC** (`orgbook.gov.bc.ca/api/v4/`) — ✅ keyless JSON API over BC-registered
  organisations (Verifiable Organizations Network). Live-verified:
  `GET /api/v4/search/topic?q=shopify` → `SHOPIFY INC.` `source_id A0098975`
  (`type registration.registries.ca`), with attributes `entity_status`, `entity_type`,
  `home_jurisdiction`, `registered_jurisdiction`, `registration_date`. Licence: Open
  Government Licence – British Columbia. **No director names** exposed. Useful only as a
  secondary/BC `CompanyResolve` corroborator.
- **Québec REQ** (`donneesquebec.ca`) — the *Registre des entreprises* bulk dataset exists
  but is licensed **CC-BY-NC-SA 4.0** — the **NC (non-commercial)** term **fails the
  redistributable/commercial-friendly bar**. Exclude. (The separate RENA public-contract-
  ineligibility list is CC-BY 4.0 but is a debarment list, not a registry.)
- **Ontario Business Registry** — no free public bulk/API; access is paid via authorized
  service providers. Excluded.

Net: provincial coverage would add only more `CompanyResolve` (BC keyless; others walled,
paid, or NC-licensed) — still no disclosure surface.

---

## Source 5 — TMX / TSX (`tmx.com`) → not a disclosure source, licence-restricted

- `www.tmx.com` and `www.tsx.com/json/company-directory/...` → **`403` from CloudFront**
  ("Request blocked").
- `app-money.tmx.com/graphql` is reachable and returns real GraphQL errors (`400
  {"errors":[{"message":"Syntax Error: Expected Name, found }"}]}`), i.e. a live but
  undocumented private GraphQL endpoint. TMX market data carries **restrictive commercial
  market-data licensing**, and quotes/listing directories map to **none** of the ten intents
  (they are not filings/insiders/owners/financials). Exclude as both licence-unfriendly and
  intent-irrelevant.

---

## Source 6 — SEC EDGAR (cross-listed Canadian issuers) → already covered by `jurisdiction:"US"`

Large Canadian issuers cross-listed in the US file under the **Multijurisdictional Disclosure
System (MJDS)**: annual reports on **Form 40-F** and material/interim disclosure on **Form
6-K**, in EDGAR. These are already served by the shipped US adapter. Quantified live via
EDGAR full-text search (`efts.sec.gov/LATEST/search-index`):

```
forms=40-F                         → hits.total.value = 4,149   (all-time FTS index, 2001+)
forms=40-F, 2025, "annual report"  → hits.total.value = 1,605
```

So a user wanting a big Canadian issuer's (banks, miners, railways, Shopify, etc.) annual
disclosure and financials can already get the MJDS filings via `jurisdiction: "US"`. This is
the honest "you already have the important part" pointer — exactly as FR/DE point listed
issuers at `jurisdiction: "EU"`. Caveat: 40-F/6-K are the US-filed subset; the **full**
Canadian continuous-disclosure record (and all TSXV/CSE-only names) is SEDAR+-only and thus
out of reach.

---

## Source 7 — Financials / XBRL → no structured Canadian source

Canada has **no ESEF/XBRL filing mandate**. Canadian issuers file financial statements as
**PDFs on SEDAR+** (walled + prohibited). There is no `filings.xbrl.org`-style structured
feed for Canadian domestic issuers. The only structured financials for Canadian names are the
**40-F/6-K** documents already in EDGAR (Source 6). CA-specific `CompanyFinancials` is
therefore **not feasible**; point users at `jurisdiction: "US"` for cross-listed issuers,
consistent with the DE/JP pattern.

---

## Auth / licence / rate-limit / reachability summary

| Source | Auth | Licence | Reachable from box | Redistributable | Verdict |
|---|---|---|---|---|---|
| SEDAR+ (`sedarplus.ca`) | — | CSA/ASC copyright, **ToU forbids automation** | ❌ 403 Radware (UA + Playwright) | ❌ prohibited | **NOT FEASIBLE** |
| SEDI (`sedi.ca`) | — | CSA public-systems terms | ❌ 403 Radware | ❌ prohibited | **NOT FEASIBLE** |
| Corporations Canada bulk CSV | none | **OGL – Canada** (`ca-ogl-lgo`) | ✅ 200 `text/csv` (100 MB) | ✅ yes | ✅ `CompanyResolve` (federal) |
| Corporations Canada JSON API | none | OGL – Canada | ✅ 200 JSON (`www.ic.gc.ca` host) | ✅ yes | ✅ per-corp enrich |
| OrgBook BC API | none | OGL – British Columbia | ✅ 200 JSON | ✅ yes | ✅ BC resolve (secondary) |
| Québec REQ bulk | none | **CC-BY-NC-SA 4.0 (NC!)** | ✅ (CKAN) | ❌ non-commercial | excluded |
| Ontario Business Registry | — | paid / service-provider | — | ❌ | excluded |
| TMX GraphQL (`app-money.tmx.com`) | — | restrictive market-data licence | ⚠️ reachable, undocumented | ❌ | excluded (no intent fit) |
| SEC EDGAR (40-F/6-K, MJDS) | UA only | US public domain | ✅ (already shipped US path) | ✅ | already via `jurisdiction:"US"` |
| GLEIF | none | CC0 | ✅ CA verified | ✅ | `OwnershipChain` (global) |

**Anti-bot / walls to flag:** SEDAR+ and SEDI are both `server: rdwr` (Radware) → `403` to
all automated clients including headless Chromium; TMX/TSX are CloudFront-`403`. The two
government registries (Corporations Canada, OrgBook BC) are the **only** cooperative,
redistributable, keyless surfaces — and they carry no disclosure data.

---

## Recommendation

**Skip Canada as a disclosures jurisdiction.** The value of this server is regulated
disclosures — filings, insiders, owners, financials, documents — and in Canada **100% of
that surface is inside SEDAR+/SEDI**, which are simultaneously (a) Radware-`403` walled from
server-grade infrastructure and (b) under Terms of Use that **explicitly prohibit** automated
access, scraping, database construction, and redistribution. Either condition alone is
disqualifying; together they are decisive. No amount of adapter engineering changes the legal
prohibition.

**"CA is not viable beyond `CompanyResolve` (federal)."** If a thin CA adapter is ever
wanted anyway, the **single and only defensible first adapter** is:

> **Corporations Canada `CompanyResolve`** — bulk "Federal Corporations" CSV (OGL – Canada,
> keyless, `text/csv`, ~644k active CBCA rows, daily) for name→(corporation number, BN9,
> status, address), enriched per-corp by the keyless JSON API at
> `www.ic.gc.ca/app/scr/cc/CorporationsCanada/api/corporations/{id}.json?lang=eng`.
> Effort **S** (one CSV loader + name matcher reusing existing infra; one GET enrich). BC
> resolution via OrgBook BC can layer on later (**S**).

But be honest about its low value: it resolves **federal** corporations only, exposes **no
directors** and **no securities identifiers**, and — critically — **chains to no disclosure
intent**, because `CompanyFilings`/`CompanyInsiders`/`CompanyOwners`/`CompanyFinancials`/
`CompanyDocument`/`PrivateRaises` all dead-end at the SEDAR+/SEDI wall. It would add a
Canada row to the coverage matrix that supports exactly one intent (plus global
`OwnershipChain` via GLEIF).

For every blocked intent, ship the standard **honest unsupported-jurisdiction explanation**,
and for large issuers point users at **`jurisdiction: "US"`** (MJDS 40-F/6-K on EDGAR, ~1,600
40-F/yr) — that already covers the disclosure data most users would ask Canada for. Given
that, the pragmatic call is **do not build a CA adapter**: a resolve-only jurisdiction with
no disclosure surface is more coverage-matrix noise than user value, and the genuinely
important Canadian issuers are already reachable through the US path.
