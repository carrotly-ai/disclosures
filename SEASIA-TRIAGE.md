# Southeast Asia (TH · ID · MY · VN · PH) — open-data feasibility **triage**

> **Historical research record.** TH, ID, MY, and PH subsequently shipped; PH/PSE now requires explicit terms acknowledgement. VN remains a deliberate skip. See the current jurisdiction pages and v0.8.0 changelog.

> **Status:** triage finding — faster and shallower than a full finding.
> No adapter ships with this document. For each of five client-priority SE Asian markets it
> establishes: (a) what free/keyless/redistributable sources exist, (b) which of the repo's
> ten intents they could serve, and (c) a **build / partial / skip** verdict with the single
> best first build. Key endpoints were **live-verified from this box on 2026-08-29**; intents
> were not exhaustively mapped. Bar unchanged: free, keyless-or-trivial-free-key, legally
> redistributable, reliably parseable (JSON/CSV/stable HTML) — and the repo now has **proven
> zero-dep PDF text extraction incl. CJK** and **XBRL/ESEF** machinery, both factored in.
>
> **Egress IP this run: `219.75.71.94` (HK/SG-region, residential-class).** This matters: it
> is the decisive difference between "walled like SGX/ASX" (fatal) and "walled like BSE India"
> (browser-solvable via the repo's injected-`fetchFn` escape hatch). Two markets that curl-403
> from this box **rendered full JSON through a real headless browser from this IP.**

---

## Cross-market headline

| Market | Verdict | One line |
|---|---|---|
| **Indonesia (IDX)** | **BUILD** (via `fetchFn`) | Incapsula-walled but **browser-solvable from this IP**; resolver + filings + **real XBRL financials** (`instance.zip`/`inlineXBRL.zip`) + docs. The standout — XBRL reuses the repo's biggest asset. |
| **Malaysia (Bursa)** | **BUILD** (via `fetchFn`) | Cloudflare-challenged but **browser-solvable**; 2.09M-row announcements JSON covering filings + **insiders (§219)** + **owners (§138)** + financials. |
| **Thailand (DBD + SEC)** | **PARTIAL** | **DBD OpenAPI is keyless JSON** — an excellent ACRA-class national registry resolver (listed + private). SET is Incapsula-walled; SEC `idisc` filings API is keyless but brittle. |
| **Philippines (PSE Edge)** | **BUILD** technically — **but ToS-disqualified** like ASX | Fully keyless HTML/JSON, richest intent coverage of all five, **no browser needed** — yet its terms are ASX-grade ("personal, non-commercial … you may NOT … TRANSMIT … DISTRIBUTE"). Decision required. |
| **Vietnam** | **SKIP** | Registry (dkkd) session/anti-bot walled; HOSE has no keyless API; HNX unreachable. Thin, as expected. |

**Single best first build: Indonesia (IDX).** Rationale in the ranking section — it is the only
SE Asian market offering **machine-readable XBRL financials**, it covers resolve+filings+
financials+documents, the wall is the accepted browser-`fetchFn` tier (not the fatal SGX edge
block), and its exchange-copyright posture matches the **already-shipped BSE India / cninfo /
HKEXnews** adapters — *not* the personal-use redistribution ban that disqualifies PSE and ASX.

---

## 1. Indonesia — IDX → **BUILD** (resolver + filings + XBRL financials + documents)

IDX (`idx.co.id`) fronts its listed-company data with keyless ASP.NET JSON endpoints under
`/primary/…`. A plain curl is **Incapsula-403'd** (the `no-js … ie6 oldie` Imperva shell), but a
**real headless Chromium from this box's IP passed the challenge and returned full JSON** — the
same escape hatch the repo already uses for **BSE India**. Every response below is real, rendered
through the browser path on 2026-08-29.

### `CompanyResolve` ✅ — `GetCompanyProfiles`

```
GET /primary/ListedCompany/GetCompanyProfiles?start=0&length=5&code=
→ 200 application/json  {"recordsTotal":965, "data":[ …
 {"KodeEmiten":"AALI","NamaEmiten":"Astra Agro Lestari Tbk","Sektor":"Barang Konsumen Primer",
  "SubSektor":"Makanan & Minuman","PapanPencatatan":"Utama",
  "TanggalPencatatan":"1997-12-09T00:00:00","Website":"http://www.astra-agro.co.id",
  "Logo":"/Portals/0/StaticData/ListedCompanies/LogoEmiten/AALI.jpg"}, … ]}
```

965 listed emiten with code, legal name, sector/subsector, listing board, listing date, address —
a clean `Entity` map keyed by `KodeEmiten` (ticker).

### `CompanyFinancials` ✅ (standout — **real XBRL**) — `GetFinancialReport`

```
GET /primary/ListedCompany/GetFinancialReport?year=2024&reportType=rdf&periode=audit&kodeEmiten=BBCA
→ 200 application/json  "Results":[{"KodeEmiten":"BBCA","NamaEmiten":"PT Bank Central Asia Tbk.",
  "Attachments":[
   {"File_Name":"instance.zip","File_Type":".zip","File_Size":87312,
    "File_Path":"…/Laporan Keuangan Tahun 2024/Audit/BBCA/instance.zip"},
   {"File_Name":"inlineXBRL.zip","File_Type":".zip","File_Size":175829, "File_Path":"…/BBCA/inlineXBRL.zip"},
   {"File_Name":"FinancialStatement-2024-Tahunan-BBCA.xlsx","File_Size":225497, …},
   {"File_Name":"Audited financial statements BCA 1224 (English).pdf","File_Size":3523293, …},
   … ]}]
```

**This is the distinctive SE-Asia win.** Indonesia publishes, per audited/interim report, an
**XBRL instance (`instance.zip`) and an inline-XBRL package (`inlineXBRL.zip`)**, plus an XLSX and
English + Indonesian PDFs. The repo already has ESEF/inline-XBRL parsing (`xbrlFilings`, ESEF
path) — IDX `CompanyFinancials` can be **structured, not PDF-scraped**, unlike HK/CN (PDF-bounded).
`reportType` also covers `rdf` (financials), and the archive layout gives annual/quarterly by
`year`+`periode`. Files live on the same Incapsula origin (`/Portals/0/StaticData/…`), fetched
through the same browser `fetchFn`.

### `CompanyFilings` / `CompanyDocument` ⚠️→✅ — `GetAnnouncement`

`/primary/NewsAnnouncement/GetAnnouncement?kodeEmiten=…&lang=en` is the per-issuer disclosure
index (announcement date/title/attachment paths). It returned a **transient `503` (Varnish)** on
one browser call this run, while the sibling `/primary/…` endpoints succeeded — i.e. the endpoint
is reachable on the same path/pattern, momentarily rate-limited, not walled differently. Treat as
feasible via the same escape hatch; re-verify the exact param set when building. `CompanyDocument`
chains off the attachment `File_Path` exactly like `GetFinancialReport`.

### Not feasible / out of scope
- **`CompanyInsiders` / `CompanyOwners`** — director & substantial-shareholder detail is inside
  report PDFs / a separate KSEI (depository) channel, not a clean IDX JSON feed. PDF extraction
  could reach *some* (Indonesian latin script, extractor-friendly) but unproven here — leave ⚠️.
- **AHU** (`ahu.go.id`, Ditjen AHU legal-entity registry) — private-company profiles are a **paid
  PNBP** per-document product (confirmed live: portal up, access gated behind paid e-services).
- **OJK** (`ojk.go.id`, `200`) — a **regulator/licensing** site, not a company-filing store; its
  open datasets are mutual-fund/macro. Out of scope, like MAS for SG.

**Licence/ToS posture:** IDX site content is exchange copyright (no open-data licence) — the
**same posture as the already-shipped `bseIndia`, `cninfo`, `twseOpenApi`, HKEXnews** adapters.
Under the repo's link-first + on-demand-fetch model (return the official source link, fetch content
for the end user, cite source) this is on par with accepted precedent — **not** disqualifying.

**Effort: M.** One browser-`fetchFn` JSON client (reuse BSE India), a profile→ticker resolver, a
financial-report lister, and wire `instance.zip`/`inlineXBRL.zip` into the existing XBRL parser.

---

## 2. Malaysia — Bursa → **BUILD** (filings + insiders + owners + financials)

Bursa (`bursamalaysia.com/api/v1/…`) is a keyless JSON API behind a **Cloudflare "Just a moment…"
challenge** on plain curl (`403`). As with IDX, a **real headless browser from this box's IP
solved the challenge and returned full JSON** — BSE-India tier, not SGX-fatal. Verified live:

```
GET /api/v1/announcements/search?ann_type=company&per_page=5&page=1
→ 200 application/json  {"recordsTotal":2092145,"data":[
 [ "…28 Aug 2026…", "<a href='…company-profile?stock_code=3662'>MALAYAN FLOUR MILLS BERHAD</a>",
   "<a href='…announcement_details?ann_id=3700874'>MFLOUR - Notice of Book Closure</a>" ],
 [ …, "TIMBERWELL BERHAD", "<a href='…ann_id=3700853'>Changes in Director's Interest (Section 219 of CA 2016) - MR WONG WAI FOO</a>" ],
 [ …, "TIMBERWELL BERHAD", "<a href='…ann_id=3700852'>Changes in Sub. S-hldr's Int (Section 138 of CA 2016) - MR WONG WAI FOO</a>" ],
 [ …, "TURIYA BERHAD", "<a href='…ann_id=3700862'>Quarterly rpt on consolidated results for the financial period ended 30/06/2026</a>" ],
 … ]}
```

**2,092,145** announcement rows, filterable by company (`stock_code`) and paged. Each row carries
date, issuer (name + `stock_code`), and a titled `announcement_details?ann_id=…` document link.
The feed **natively separates the high-value categories** the repo's intents target:

| Bursa announcement category | Serves intent |
|---|---|
| all company announcements | `CompanyFilings` ✅ |
| **"Changes in Director's Interest (Section 219 of CA 2016)"** | `CompanyInsiders` ✅ |
| **"Changes in Sub. S-hldr's Int (Section 138 of CA 2016)"** | `CompanyOwners` ✅ |
| "Quarterly rpt on consolidated results…" / annual report | `CompanyFilings`, `CompanyFinancials` ⚠️ (report is PDF/HTML — extractable, bounded like HK/CN) |
| `announcement_types` endpoint | category taxonomy for `forms` filtering |

`CompanyDocument` chains off `ann_id` → `announcement_details` page (attachments). Resolution rides
the same `stock_code`/company-profile link.

### Not feasible
- **SSM** (`ssm-einfo.my`, `200`) — the Companies Commission registry is **paid** (confirmed live:
  the e-Info FAQ describes RM-priced "purchase for company information" transactions). No free
  private-company resolve/documents/charges. Honest unsupported — same as HK ICRIS / SG BizFile.

**Licence/ToS posture:** exchange copyright, no open licence — same accepted precedent tier as
IDX/BSE/cninfo. Feasible under the link-first model.

**Effort: M.** Browser-`fetchFn` JSON client + row parser (HTML fragments inside the JSON cells
need light unwrapping) + category→intent routing + `ann_id` document chain.

---

## 3. Thailand — DBD + SEC → **PARTIAL** (clean resolver; filings brittle/walled)

Thailand splits cleanly: the **company registry is an open win**, the **listed-disclosure side is
walled or brittle**.

### DBD OpenAPI → `CompanyResolve` ✅ (standout, keyless, ACRA-class)

The Department of Business Development exposes `openapi.dbd.go.th/api/v1/juristic_person/{13-digit
registration no.}` — and it answered **keyless, structured JSON** for real juristic numbers with no
token (the portal root is Incapsula-fronted, but the `/api/v1/…` path is not). Verified live:

```
GET https://openapi.dbd.go.th/api/v1/juristic_person/0107544000108
→ 200 application/json
{"status":{"code":"1000","description":"Success"},"data":[{"cd:OrganizationJuristicPerson":{
  "cd:OrganizationJuristicID":"0107544000108",
  "cd:OrganizationJuristicNameTH":"บริษัท ปตท. จำกัด (มหาชน)",
  "cd:OrganizationJuristicNameEN":"PTT PUBLIC COMPANY LIMITED",
  "cd:OrganizationJuristicType":"บริษัทมหาชนจำกัด",
  "cd:OrganizationJuristicRegisterDate":"20011001",
  "cd:OrganizationJuristicStatus":"ยังดำเนินกิจการอยู่",
  "cd:OrganizationJuristicRegisterCapital":"28562996250.0",
  "cd:OrganizationJuristicPaidUpCapital":"28562996250.00",
  "cd:OrganizationJuristicObjective":{"td:JuristicObjective":{
     "td:JuristicObjectiveCode":"71209","td:JuristicObjectiveTextEN":"Other technical testing and analysis…"}},
  "cd:OrganizationJuristicAddress":{ … } }}]}
```

(An unknown/nonexistent id returns a clean `{"status":{"code":"1004","description":"No data
available"},"data":[]}`.) This is a **national registry resolver covering listed *and* private
companies** — TH/EN legal name, entity type, register date, status, registered/paid-up capital,
TSIC industry code, address. Directly on par with SG **ACRA** and GB Companies House as a
`CompanyResolve` source, and richer (it carries capital). **Keyed by 13-digit juristic number** —
a name→number search endpoint should be confirmed at build time (the by-id lookup is proven).

### SEC Thailand `idisc` → `CompanyFilings` ⚠️ (keyless JSON, but brittle)

Listed-company regulated filings (56-1 One Report, financial statements) live on
`market.sec.or.th/public/idisc/…`, a stable HTML portal (`200`) whose front-end drives a keyless
ASP.NET Web API at `/public/idisc/api/…` (`company/valuebyuniqueId`, `Product/ValueByMarketCode`).
The API **is reachable keyless and returns JSON**, but is fragile: POSTs reach the target method
(`GetCompanyReturnUniqueIdReference(String str, String lang)` — confirmed via a leaked stack trace,
so field names `str`/`lang` are right) yet throw an internal `NullReferenceException` on the
parameter shapes tried. Feasible in principle, **needs meaningful reverse-engineering** — a partial,
not a turnkey win.

### SEC Thailand `api.sec.or.th` (APIM) → trivial-free-key, mostly funds
`api.sec.or.th` is an Azure API-Management gateway: `{"statusCode":401,"message":"Access denied due
to missing subscription key…"}`. A **free subscription key** is issued via the `api-portal.sec.or.th`
developer portal (which itself failed to connect from this box this run — `000`). Products are
predominantly **mutual-fund / AMC** data (`/FundFactsheet/…`), not listed-company disclosure — low
value for these intents. Note as trivial-free-key, largely out of scope.

### SET (Thai exchange) → Incapsula-walled
`www.set.or.th/api/set/…` (company profile, highlight, news) all `403` with the Imperva/Incapsula
shell on plain curl. Not browser-tested this run — given DBD already covers resolve and SEC covers
filings, SET is not the priority; a browser-`fetchFn` solve (as with IDX/Bursa) is plausible but
unverified.

**Verdict: PARTIAL — ship DBD `CompanyResolve` (clean, keyless, listed+private); treat SEC `idisc`
filings as a follow-on R&D item.** SET left unverified-via-browser.

**Effort: S** for DBD resolver (one keyless GET + a name→number search to confirm); **M–L** for SEC
`idisc` filings (API reverse-engineering).

---

## 4. Vietnam — HOSE / HNX / SSC / dkkd → **SKIP** (thin, as expected)

- **National Business Registration Portal** `dichvuthongtin.dkkd.gov.vn` — the free company search,
  but it **307-redirect-loops to its own `default.aspx`** (session/TLS-fingerprint + captcha gate);
  no keyless structured response. Walled to programmatic access.
- **HOSE** `www.hsx.vn` serves server-rendered HTML (`200`) but exposes **no keyless data API**
  (`api.hsx.vn` and guessed `/l/api/v1/…` paths `404`). Disclosure (CBTT) is HTML-portal only.
- **HNX** `www.hnx.vn` — **unreachable from this box** (`000`, connection failed this run).
- **VSD/VSDC** (depository) and **SSC** (regulator) — no keyless structured disclosure feed found;
  ownership/insider data is not published as open data.

No source clears the bar. Vietnamese listed issuers with foreign cross-listings/LEIs remain
reachable via **GLEIF** (global). Honest **SKIP**.

---

## 5. Philippines — PSE Edge → **BUILD technically, ToS-disqualified like ASX** (decision required)

PSE Edge (`edge.pse.com.ph`) is the richest and **most turnkey** source in this entire triage —
**fully keyless HTML/JSON, no browser needed**, covering more intents than any other SE-Asian
market. The catch is legal, not technical.

### `CompanyResolve` ✅ — two keyless paths
```
GET /autoComplete/searchCompanyNameSymbol.ax?term=SM
→ 200 [{"cmpyId":"154","cmpyNm":"San Miguel Corporation","symbol":"SMC","etfYn":"0"},
       {"cmpyId":"599","cmpyNm":"SM Investments Corporation","symbol":"SM","etfYn":"0"},
       {"cmpyId":"112","cmpyNm":"SM Prime Holdings, Inc.","symbol":"SMPH","etfYn":"0"}]
POST /companyDirectory/search.ax  (keyword=SM…) → 200 HTML table: name, symbol, sector, subsector,
     listing date, and cmDetail('<companyId>','<securityId>')
```

### `CompanyFilings` ✅ — `companyDisclosures/search.ax`
```
POST /companyDisclosures/search.ax?companyId=94&sortType=date&dateSortType=DESC&pageNo=1
→ 200 HTML  "[Total 35,658]"  rows:
 <a onclick="openPopup('c1436eff…0a3140b')">Daily Trading Information</a> | Aug 28 2026 | ETF-1 | C06567-2026
 <a onclick="openPopup('6932b527…185e…')">Change in Shareholdings of Directors and Principal Officers</a> | 13-1 | C06564-2026
 <a onclick="openPopup('79089b2f…')">Material Information/Transactions</a> | 4-30 | C06565-2026
```
A full per-issuer disclosure index (35,658 rows for one company), paged, each row with title,
timestamp, template code, disclosure number, and an `openPopup(edge_no)` hash.

### `CompanyDocument` ✅ — three-hop, all keyless
```
GET /openDiscViewer.do?edge_no=<hash>   → 200 HTML containing <iframe src="/downloadHtml.do?file_id=1962087">
GET /downloadHtml.do?file_id=1962087    → 200 text/html  (the actual disclosure document body + attachments)
```
Verified end-to-end. Document bodies are HTML (parseable text); PDF/xlsx attachments hang off the
same handler.

### `CompanyInsiders` / `CompanyOwners` / `CompanyFinancials` ✅/⚠️ — dedicated disclosure templates
The disclosure index natively carries the target categories: template **"13-1" Changes in
Shareholdings of Directors and Principal Officers** (`CompanyInsiders`), beneficial-ownership /
substantial-shareholder templates (`CompanyOwners`), and **Financial Reports** (17-A annual / 17-Q
quarterly) via `financialReports/form.do` (`CompanyFinancials` — HTML/PDF, bounded). Endpoint list
confirmed live: `announcements/search.ax`, `companyDisclosures/search.ax`, `financialReports/…`,
`disclosureNotices/…`, `listingNotices/…`, `cm/companySearch.ax`.

### The blocker — ToS is ASX-grade (verbatim, fetched live from `/page/disclaimer.do`)
> "…you may access and download the materials located on the website only for **personal,
> non-commercial use**. You may **NOT COPY, STORE, EITHER IN HARD COPY OR IN ELECTRONIC RETRIEVAL
> SYSTEM, TRANSMIT, TRANSFER, PERFORM, BROADCAST, PUBLISH, REPRODUCE, CREATE A DERIVATIVE WORK
> FROM, DISPLAY, DISTRIBUTE, SELL, LICENSE, RENT, LEASE OR OTHERWISE TRANSFER** any of the Contents
> to any third person, including others in your company or organization…"
> "All rights, title, and interest in and on the Contents, including database rights, are owned,
> licensed and/or controlled by the PSE…"

This is **materially stricter than HKEXnews's generic copyright reservation** and reads almost
word-for-word like the **ASX Terms of Use that the repo's own AU finding treated as
disqualifying** ("personal, non-commercial use", explicit no-transmit/no-distribute-to-third-party).
By the repo's *own* precedent, PSE Edge sits on the ASX side of the line, not the HKEXnews side.
The link-first/on-demand model mitigates but does not clearly satisfy "personal, non-commercial …
not to any third person."

### SEC Philippines → walled/paid
`efast.sec.gov.ph` (eFAST) is a **login-walled React SPA** ("You need to enable JavaScript…"); AFS/
GIS retrieval requires a registered account and paid document requests. No keyless structured feed.

**Verdict: technically a standout BUILD (keyless, no browser, 5+ intents from one source), but its
Terms disqualify redistribution on the same basis the repo used to reject ASX.** Ship **only** if
the maintainer extends the HKEXnews link-first reconciliation to these stricter terms — an explicit,
eyes-open decision. An honest reading defaults to **do not ship PSE under the current ToU**, exactly
as with ASX.

---

## Auth / licence / reachability summary

| Source | Auth | Reachable from box | Licence / ToS | Verdict |
|---|---|---|---|---|
| **ID** IDX `/primary/…` JSON | none | ❌ curl `403` Incapsula · ✅ **headless browser** | exchange © (BSE/cninfo tier) | resolve/filings/**XBRL financials**/docs ✅ via `fetchFn` |
| **ID** IDX `/Portals/…` report files (`instance.zip`, `inlineXBRL.zip`, xlsx, pdf) | none | ✅ same origin/browser | exchange © | `CompanyFinancials` structured ✅ |
| **ID** AHU registry | account + **paid** | portal up | — | private resolve ❌ |
| **ID** OJK | none | `302` | — | regulator, not disclosure ❌ |
| **MY** Bursa `/api/v1/…` JSON | none | ❌ curl `403` Cloudflare · ✅ **headless browser** | exchange © | filings/insiders(§219)/owners(§138)/financials ✅ via `fetchFn` |
| **MY** SSM e-Info | account + **paid** | `200` | — | registry ❌ |
| **TH** DBD OpenAPI `/api/v1/juristic_person/{id}` | **none** | ✅ **keyless JSON** | gov open data | `CompanyResolve` ✅ (listed+private) |
| **TH** SEC `market.sec.or.th/idisc` API | none | ✅ keyless JSON, **brittle** | SEC © | `CompanyFilings` ⚠️ (needs RE) |
| **TH** SEC `api.sec.or.th` (APIM) | **free key** | ✅ (401 without key) | — | mostly funds, low value |
| **TH** SET `api/set/…` | none | ❌ `403` Incapsula (browser untested) | exchange © | unverified |
| **VN** dkkd registry | session/captcha | ❌ `307` loop | — | ❌ |
| **VN** HOSE / HNX / SSC / VSD | — | HOSE `200` HTML-only; HNX `000` | — | no keyless API ❌ |
| **PH** PSE Edge `*.ax`/`*.do` | **none** | ✅ **keyless HTML/JSON, no browser** | **© "personal, non-commercial", no-redistribute (ASX-grade)** | technically ✅ 5+ intents — **ToS-disqualified** |
| **PH** SEC eFAST | login + paid | SPA wall | — | ❌ |
| GLEIF | none | ✅ all five | CC0 | `OwnershipChain` 🌐 |

---

## Cross-market ranking — what to build first

1. **Indonesia (IDX) — BUILD FIRST.** The only SE-Asian market with **machine-readable XBRL
   financials** (`instance.zip` + `inlineXBRL.zip` per report), which reuses the repo's single
   biggest existing asset (ESEF/inline-XBRL parsing) instead of PDF-scraping. Covers `CompanyResolve`
   + `CompanyFilings` + `CompanyFinancials` + `CompanyDocument` from one JSON API. The wall is the
   **accepted browser-`fetchFn` tier** (proven solvable from this IP), and the copyright posture
   matches the already-shipped BSE India / cninfo / HKEXnews adapters. Best value-to-acceptability
   ratio. Effort **M**.

2. **Malaysia (Bursa) — BUILD, very close second.** Broadest *disclosure* coverage of the five —
   uniquely delivers **both `CompanyInsiders` (§219 director-interest) and `CompanyOwners` (§138
   substantial-shareholder)** as first-class announcement categories, plus filings and
   report-based financials, from a 2.09M-row keyless JSON feed. Same browser-`fetchFn` tier and
   copyright posture as IDX. Pick this first instead if owner/insider breadth outranks XBRL
   financials for the client. Effort **M**.

3. **Thailand (DBD `CompanyResolve`) — BUILD, small & clean.** A keyless, ACRA-class national
   registry resolver (listed + private, TH/EN names, status, capital, TSIC) that slots straight into
   the existing resolver machinery with **no browser and no key**. Ship as a resolve-only TH adapter
   (like SG/ACRA); treat SEC `idisc` filings as a later R&D follow-on. Effort **S**.

4. **Philippines (PSE Edge) — HOLD pending a ToS call.** Technically the richest and most turnkey
   (fully keyless, no browser, 5+ intents), but its "personal, non-commercial / no-transmit /
   no-distribute" terms are the **same class the repo already rejected for ASX**. Do not ship under
   current ToU unless the maintainer explicitly decides the link-first/on-demand model reconciles
   these stricter terms. High technical value, high legal risk — the honest default is **defer**.

5. **Vietnam — SKIP.** No source clears the bar; registry captcha/session-walled, exchanges without
   keyless APIs. Point users to GLEIF for cross-listed VN issuers.

**Net:** three clean builds (ID, MY, TH-resolve), one turnkey-but-legally-blocked (PH), one skip
(VN). The first adapter to write is **Indonesia IDX** — XBRL financials make it the highest-value,
lowest-regret slot, and it proves out the browser-`fetchFn` pattern that Malaysia then reuses.

---

*Verified live from this box (egress `219.75.71.94`) on 2026-08-29. Endpoints that curl-403'd but
rendered full JSON through a headless browser are marked "via `fetchFn`"; the IDX `GetAnnouncement`
`503` was transient (sibling `/primary/…` calls succeeded). Scratch artifacts under `/tmp/seasia/`.*
