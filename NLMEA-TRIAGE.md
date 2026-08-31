# NL + MEA/TR triage — Netherlands, Saudi Arabia, UAE, Turkey, Nigeria

> **Historical research record.** NL, AE/DFM, and TR/KAP subsequently shipped; SA and NG remain deliberate skips. See the current jurisdiction pages and v0.8.0 changelog.

> **Status:** research triage only — no adapter or tool change ships with this document.
> Records whether `NL`, `SA`, `AE`, `TR`, `NG` jurisdiction adapters can sit behind the
> existing ten intent tools using only **free, keyless-or-trivial-free-key, legally
> redistributable, reliably parseable** data with **zero runtime dependencies**. Same bar and
> honesty standard as `HKSG-FEASIBILITY.md` and `AU-FEASIBILITY.md`.

**Assessed live from this box on 2026-08-29.** Verification issuers per market are named in
each section. Every endpoint, status code, and response fragment below was fetched from this
box unless explicitly marked unreachable.

The ten intents: `CompanyResolve`, `CompanyFilings`, `CompanyInsiders`, `CompanyOwners`,
`CompanyFinancials`, `PrivateRaises`, `CompanyDocument`, `CompanyCharges`,
`PersonAppointments`, `OwnershipChain`. `OwnershipChain` is already global via GLEIF (CC0)
everywhere; `PrivateRaises` has no non-US analogue in any of these five markets.

---

## Executive verdict + cross-market ranking

| Rank | Market | Verdict | Best first build | Why |
|---|---|---|---|---|
| **1** | **Netherlands (NL)** | **BUILD — standout** | AFM substantial-holdings (`CompanyOwners`) + MAR Art.19 (`CompanyInsiders`) via keyless **XML/CSV register export** | Keyless full-register XML/CSV for the *exact* disclosure intents that are hardest everywhere else — shareholder holdings, net short positions, insider dealings. Clean structured XML. **Distinct ADD** over the ESEF financials NL already has via `EU`. |
| **2** | **UAE (AE)** | **BUILD (DFM only)** | DFM `CompanyFilings` + `CompanyDocument` via `api2.dfm.ae/efsah` keyless JSON + keyless PDFs | Clean keyless JSON disclosure API, per-issuer filterable, direct keyless PDFs — mechanics identical to shipped `cninfo`/EDGAR. **Caveat: Dubai only** — ADX (Abu Dhabi) and DIFC/ADGM registers are bot-walled from datacenter IPs. |
| **3** | **Turkey (TR)** | **BUILD (KAP) — with caveat** | KAP `CompanyResolve` (SSR directory) + `CompanyDocument` (keyless `BildirimPdf`) | Whole-BIST coverage; keyless SSR company directory + keyless disclosure PDFs. **Caveat:** KAP's documented JSON API moved to a non-public backend (`kapsitebackend.mkk.com.tr`, unresolvable); per-company disclosure *enumeration* now needs SSR/RSC HTML parsing, not a clean JSON feed. |
| 4 | **Saudi Arabia (SA)** | **SKIP (resolve-only, fragile)** | — (optionally `CompanyResolve` from inline market-watch HTML) | Portal HTML renders the company/market-watch table inline, but the actual disclosure & financial data files under `/Resources/` are **Imperva-walled** (`Request Rejected`) to datacenter IPs — same class as SGX. |
| 5 | **Nigeria (NG)** | **SKIP** | — | No free, keyless, redistributable structured source. NGX is a WordPress news site (no issuer feed); doclib is `401`; CAC search is `403`. Only GLEIF (already global) touches NG. |

**The single highest-value find across all five markets is NL/AFM** — it is the only one of
the five that keylessly delivers the *owners* and *insiders* intents (not just filings/docs),
as clean structured XML, and it is a genuine ADD on top of NL's existing ESEF financials.

---

## 1. Netherlands (`NL`) — BUILD (standout)

**Already served today:** NL listed-issuer **financials** via jurisdiction `EU`
(filings.xbrl.org ESEF annual financial reports) and **`OwnershipChain`** via GLEIF. This
triage asks what an **NL-native** adapter would ADD. Verification issuers: IMCD N.V.
(`NL0010801007`), Iveco Group N.V., argenx SE, Shell Plc.

### Per-intent verdict

| Intent | NL feasibility | Primary source | Note vs. existing `EU`/GLEIF |
|---|---|---|---|
| `CompanyResolve` | ⚠️ partial | AFM registers (listed, by name/ISIN) + GLEIF | GLEIF already global; KVK private-co register is **paid API** (`401`) |
| `CompanyFilings` | ⚠️ partial | AFM "openbaarmaking voorwetenschap" (inside-info) CSV/XML | Publication date + issuer + title feed; new vs. ESEF (which is annual reports only) |
| `CompanyInsiders` | ✅ **standout ADD** | AFM **MAR Art.19** managers'-transactions register + directors/commissioners register (keyless CSV/XML) | **Not in ESEF** — this is the insider-dealing feed |
| `CompanyOwners` | ✅ **standout ADD** | AFM **substantial-holdings** (meldingen zeggenschap) + **net-short-positions** registers (keyless CSV/XML) | **Not in ESEF** — shareholder holdings + short interest |
| `CompanyFinancials` | ➖ already `EU` | filings.xbrl.org ESEF | AFM "financiële verslaggeving" register is oversight metadata, not figures — no change |
| `PrivateRaises` | ❌ | — | No Form D analogue |
| `CompanyDocument` | ⚠️ partial | Document links embedded in substantial-holdings rows (`wmzk_documents/*.pdf`) | Chains off the register row |
| `CompanyCharges` | ❌ | — | No free Dutch pledge/charge register |
| `PersonAppointments` | ❌ | KVK (paid) | — |
| `OwnershipChain` | ✅ already global | GLEIF | — |

### AFM register export — keyless CSV **and** XML (the decisive find)

Every AFM disclosure register (`afm.nl/en/sector/registers/meldingenregisters/*`) exposes a
keyless bulk export at `https://www.afm.nl/export.aspx?type=<GUID>&format=csv|xml`. No key, no
login, no token. GUIDs harvested live from the register pages:

| Register (intent) | Export GUID |
|---|---|
| Substantial holdings — *meldingen zeggenschap* (`CompanyOwners`) | `1331d46f-3fb6-4a36-b903-9584972675af` |
| Net short positions — current (`CompanyOwners`) | `8a46a4ef-f196-4467-a7ab-1ae1cb58f0e7` |
| Net short positions — history | `3ca31b3d-23d9-4fa2-b846-29c7e3f0e5ff` |
| **MAR Art.19** managers' transactions (`CompanyInsiders`) | `0ee836dc-5520-459d-bcf4-a4a689de6614` |
| Directors/commissioners holdings (`CompanyInsiders`) | `1b934036-12ad-4950-9773-31361d5adbd9` |
| Issued capital (`geplaatst kapitaal`) | `f25d2ca1-b93c-4331-b025-85df328cd505` |
| Disclosure of inside information (`CompanyFilings`) | `fb94a1d1-ee14-4103-b6ca-02ad6ec9d8b6` |

**Substantial holdings** (`format=csv`) — verified `HTTP 200`, **108,516,396 bytes**,
293,488 rows, `;`-delimited, Windows-1252 encoded (`Reëel` → `Re?el` when mis-read as UTF-8):

```
"Datum meldingsplicht";"Uitgevende instelling";"Meldingsplichtige";"Kvk-nr";"Plaats";"Soort aandeel";
"Kapitaalbelang";"Stemrecht";"Aantal aandelen";"Aantal stemmen";"Totale deelneming";"Rechtstreeks";"Middellijk"
"2026-08-27 00:00:00";"Iveco Group N.V.";"BlackRock Inc.";"";"Turijn";"Gewoon aandeel";"Reëel";"Reëel";
"2227413.00000";"2227413.00000"; ... "<a href=wmzk_documents/199404_12-Page Org Chart ....pdf>...</a>"
```

The **XML** variant is cleaner (named elements, no encoding trap) — verified on net-short:

```xml
<register name="Netto shortposities actueel"><vermelding>
  <PositieHouder>BlackRock Advisors, LLC</PositieHouder><Issuer>IMCD N.V.</Issuer>
  <ISIN>NL0010801007</ISIN><NettoShortpositie>0.49</NettoShortpositie>
  <Positiedatum>8/27/2026 12:00:00 AM</Positiedatum></vermelding> ...
```

**MAR Art.19 insider transactions** (verified `200`):
```
"Transactie";"Uitgevende instelling";"Meldingsplichtige";"MeldingsPlichtigeAchternaam"
"2026-08-26 00:00:00";"argenx SE";"DelGiacco E.";"DelGiacco"
```
**Inside-info disclosures** (verified `200`):
```
"Publicatie datum";"Statutaire naam";"Titel"
"2026-08-28 11:16:00";"Shell Plc";"Transaction in Own Shares"
```

**Shape / friction.** These are **full-register bulk exports** (filter by issuer client-side),
not per-company query APIs — the same "bulk not query" friction as the AU ASIC dataset, and it
fits the project's existing large-reference-cache pattern (OpenDART archive, EDINET code list).
Prefer `format=xml` for parse-safety. Refresh daily/weekly.

### KVK (Handelsregister) — paid API, free web search only

- `https://api.kvk.nl/api/v2/zoeken?naam=philips` → **`HTTP 401`** (registered paid key
  required). `https://www.kvk.nl/zoeken/?q=philips` → `200` HTML (free web search, ToS-bound,
  no bulk/JSON). So KVK adds nothing keyless the repo needs — GLEIF already resolves NL, and
  AFM covers the listed-issuer disclosure side.

### Licence / ESAP posture (honest)

- **AFM asserts rights** — page footer: *"© Copyright AFM 2026 - alle rechten voorbehouden"*
  (all rights reserved). No open-data licence attached. These are **statutory public registers**
  (Wft) published under AFM's public task; the exports are keyless but not CC-licensed. This is
  the **same posture as the shipped `cninfo`/`bseIndia`/`twseOpenApi` adapters** — use the
  register data as an **internal lookup** and return the **official AFM source link**,
  fetching on demand and citing the source; do not re-publish the bulk file as an open dataset.
- **ESAP factor.** The EU **European Single Access Point** phases in from **2027** (first data
  categories mid-2027, shareholder/short-selling/MAR categories in later 2028–2030 waves) and
  will eventually aggregate exactly these AFM registers into one EU API. Building NL/AFM now
  still buys a multi-year useful window, and AFM stays the authoritative national source; but
  flag that ESAP may later supersede the NL-native path (parallel to how ESEF already lives
  under `EU`). Net: build the *owners/insiders* value now; expect to point at ESAP later.

**NL verdict: BUILD.** Best first adapter: **AFM `CompanyOwners` (substantial holdings + net
short) + `CompanyInsiders` (MAR Art.19 + directors) from the keyless XML export.** Effort
**S–M** (one export fetcher + issuer filter over the large-reference cache; XML parse). This is
the strongest single find in this triage and a clean ADD over the existing ESEF financials.

---

## 2. UAE (`AE`) — BUILD (DFM only), partial market

Verification issuers: EMAAR (Emaar Properties PJSC), TALABAT, UPP (Union Properties). The UAE
has **two** exchanges; they behave very differently from this box.

### Per-intent verdict

| Intent | AE feasibility | Primary source |
|---|---|---|
| `CompanyResolve` | ⚠️ feasible (DFM-listed) | DFM issuer symbols (small set; from efsah feed / market-watch widget) + GLEIF |
| `CompanyFilings` | ✅ feasible (Dubai) | **`api2.dfm.ae/efsah/v1/prototype_efsah`** — keyless JSON, per-symbol |
| `CompanyDocument` | ✅ feasible (Dubai) | **`feeds.dfm.ae/documents/efsah/<r_path>`** — keyless PDF (verified `200`) |
| `CompanyFinancials` | ❌ structured | Financial results arrive as **Disclosure PDFs** (press releases), no structured figures |
| `CompanyInsiders` / `CompanyOwners` | ❌ | Not exposed as structured disclosure types |
| `CompanyDocument`/filings for **Abu Dhabi (ADX)** | ❌ (walled) | `www.adx.ae` → `403`; `adxservices.adx.ae` alive but path-undiscovered |
| DIFC / ADGM free-zone registers | ❌ (walled) | `difc.ae` → `429` (Cloudflare); `registration.adgm.com` → `403` |
| `PrivateRaises` / `CompanyCharges` / `PersonAppointments` | ❌ | — |
| `OwnershipChain` | ✅ global | GLEIF |

### DFM — `api2.dfm.ae/efsah` (keyless JSON + keyless PDF)

The DFM front end (Nuxt) is backed by `https://api2.dfm.ae`. The disclosures route
`/en/the-exchange/news-disclosures/disclosures` calls (captured live via headless Chromium):

```
GET https://api2.dfm.ae/efsah/v1/prototype_efsah?lang=en&announcement_type=Disclosure
    &symbol=+&take=20&skip=0&cms_resources=true      → 200 application/json
GET https://api2.dfm.ae/efsah/v1/efsah_count?...                        → 200
```

Verified **keyless from this box** (plain `curl` + `Origin`/`Referer` headers), per-issuer via
`symbol=EMAAR`:

```json
{"root":[{
  "id":"52433569-0887-4100-ba14-58ee448166f1",
  "publication_date":"Aug 07, 2026 09:01:11 AM",
  "headline":"Press Release regarding financial results for the 2nd QTR of 2026",
  "issuer_symbol":"EMAAR","issuer":"EMAAR - Emaar Properties PJSC",
  "announcement_type":"Disclosure",
  "resources":[{"description":"...Pdf","r_path":"/2026/Aug/27/<uuid>/DFM Notice ....pdf",
                "category":"cap","language":"en","type":"news"}]
}]}
```

`announcement_type` observed values: `Disclosure`, `DFM News`. **Document retrieval verified**
— URL-encode the `r_path` onto the feeds host:

```
GET https://feeds.dfm.ae/documents/efsah/2026/Aug/27/<uuid>/DFM%20Notice%20...pdf
  → 200  content-type: application/pdf  size: 591,473 bytes  (PDF 1.4)
```

This maps straight onto `FilingRecord` + `CompanyDocument`, exactly like `cninfo`/EDGAR
(chain the PDF off the filing row; reuse the 25 MB cap + save-to-disk). Company/securities list
endpoints (`mw/v1/*`, `efsah/v1/issuers|symbols`) were **not** guessable (all `404` structured
JSON), but the issuer set is small (~60) and enumerable from the disclosures feed / market-watch
widget, so DFM `CompanyResolve` is feasible.

### ADX, DIFC, ADGM — walled from datacenter IPs

- **ADX (Abu Dhabi):** `https://www.adx.ae/en` → **`403`** (Imperva/Cloudflare edge). The API
  host `adxservices.adx.ae` is alive (returns structured JSON `404` on guessed paths) but the
  main domain blocks datacenter egress. **Not feasible** without residential egress / path
  discovery. This is material: ADX carries the UAE's largest caps (ADNOC group, IHC, Aldar), so
  DFM-only = **Dubai coverage, not full-UAE**.
- **DIFC public register:** `www.difc.ae/public-register` → persistent **`429`** (Cloudflare
  bot-wall on datacenter IP), including its `/api/public-register/search` path.
- **ADGM registration authority search:** `registration.adgm.com/.../searchRegister` → **`403`**.
- Both English-law free-zone registers therefore exist but are **bot-walled from this box** —
  the SGX/ADX pattern, no clean keyless path from a server.

**Licence:** DFM efsah content is exchange/issuer copyright (no open licence) — same link-first,
on-demand posture as `cninfo`. **AE verdict: BUILD DFM only** (`CompanyFilings` +
`CompanyDocument`, effort **S–M**); honestly flag Dubai-only coverage with ADX/DIFC/ADGM walled.

---

## 3. Turkey (`TR`) — BUILD (KAP), with an enumeration caveat

KAP (`kap.org.tr`) is Turkey's Public Disclosure Platform for all BIST issuers. It was
**rebuilt as a Next.js app**; the historically documented JSON API surface (`/tr/api/...`) is
gone — those paths now `404`. The backend moved to `https://kapsitebackend.mkk.com.tr`, which
**does not resolve publicly from this box** (`getent hosts` empty, `curl` exit 6). But the
**public host serves keyless SSR pages and keyless document/export API routes.** Verification:
Adel Kalemcilik (BIST, id `832`), disclosure id `1500000`.

### Per-intent verdict

| Intent | TR feasibility | Primary source |
|---|---|---|
| `CompanyResolve` | ✅ feasible | SSR `https://www.kap.org.tr/en/bist-sirketler` — **827 BIST companies**, each linking `/en/sirket-bilgileri/ozet/<id>-<slug>` |
| `CompanyFilings` | ⚠️ feasible-with-friction | Disclosure detail SSR `/en/Bildirim/<id>` (keyless); per-company **enumeration** is client-fetched from the non-public backend |
| `CompanyDocument` | ✅ feasible | **`/en/api/BildirimPdf/<id>`** → keyless `application/pdf` (verified) + Excel/Word exports |
| `CompanyFinancials` | ⚠️ present, reachability TBD | Company detail exposes "Financial Statement Item Search"; structured feed likely on the non-public backend |
| `CompanyInsiders` / `CompanyOwners` | ❌ structured | Shareholding-change events appear as disclosure types, not a structured holdings register |
| `PrivateRaises` / `CompanyCharges` / `PersonAppointments` | ❌ | MKK e-YATIRIMCI login-gated; Ticaret Sicili/MERSIS paid |
| `OwnershipChain` | ✅ global | GLEIF |

### Evidence (all keyless, verified `200`)

```
GET https://www.kap.org.tr/en/bist-sirketler            → 200  1.53 MB  (827 companies, SSR)
    e.g. href="/en/sirket-bilgileri/ozet/832-adel-kalemcilik-ticaret-ve-sanayi-a-s"
GET https://www.kap.org.tr/en/Bildirim/1500000          → 200  266 KB  (SSR RSC: companyTitle,
    "Notification Subjects", "Independent Audit Firm", attachments — structured disclosure)
GET https://www.kap.org.tr/en/api/BildirimPdf/1500000   → 200  application/pdf  84,573 bytes
GET https://www.kap.org.tr/en/api/notification/export/excel/1500000  → 200  (structured export)
GET https://www.kap.org.tr/en/api/company/generic/pdf/IGS/A/companies-IGS → 200 application/pdf
```

The company detail page (`/en/sirket-bilgileri/...`) returns `200` (178 KB) and contains
"Financial Statement" / "Financial Statement Item Search", confirming KAP hosts financial
statements — but the structured financial feed rides the non-public backend.

**The caveat that keeps this from being a clean "standout":** with `kapsitebackend.mkk.com.tr`
unresolvable, per-company disclosure **lists** are not available as a keyless JSON call. You can
resolve companies (SSR directory), open any disclosure by id (SSR + PDF, keyless), and export
it — but *enumerating* a given issuer's disclosures means parsing the SSR/RSC HTML of the
company page (or discovering a still-public list route). That is messier than the DFM/HKEX JSON
feeds, though still within the "stable HTML" bar. Text is Latin-with-diacritics (Turkish) — no
non-Latin-script PDF-extraction problem.

**Licence:** KAP/MKK content is copyright (rights reserved) — cninfo posture (link-first,
on-demand). **TR verdict: BUILD (KAP)** — best first: `CompanyResolve` (SSR directory) +
`CompanyDocument` (keyless `BildirimPdf`), effort **M** (SSR/RSC parsing for enumeration is the
extra cost vs. a JSON API). Whole-BIST coverage makes it worth the slot.

---

## 4. Saudi Arabia (`SA`) — SKIP (resolve-only, fragile)

Verification issuers: Saudi Aramco (`2222`), Al Rajhi (`1120`). The Saudi Exchange
(`saudiexchange.sa`, ex-Tadawul) sits behind **Imperva/Incapsula**. The initial `403` was a
missing-header block; with a full browser header set the **portal HTML pages return `200`**, but
the **data files the pages depend on are hard-walled.**

### Per-intent verdict

| Intent | SA feasibility | Evidence |
|---|---|---|
| `CompanyResolve` | ⚠️ fragile | Market-watch portal page renders the **full company table inline** (`2222 SAUDI ARAMCO`, `1120 AL RAJHI`, prices) — parseable, but HTML-scrape of an Imperva-fronted portal |
| `CompanyFilings` / `CompanyDocument` / `CompanyFinancials` | ❌ walled | Disclosure/financial data loads from `/Resources/...` which returns **Imperva "Request Rejected"** (`go-mpulse` boomerang) to datacenter IPs |
| CMA disclosures | ❌ not verified reachable | `cma.org.sa/.../Disclosures` → `301`; no keyless structured feed found |
| Ministry of Commerce CR registry | ❌ | `mc.gov.sa` eservices → connection timeout/blocked from box |
| `OwnershipChain` | ✅ global | GLEIF |

Evidence:
```
GET https://www.saudiexchange.sa/wps/portal/.../watch-list-main-market  → 200  617 KB
    inline: "2222 SAUDI ARAMCO", "1120 AL RAJHI REIT", change/price columns
GET https://www.saudiexchange.sa/Resources/fenews/todaysDisclosures_en.html
    → 200 but body = "Request Rejected" + go-mpulse boomerang (Imperva bot-wall)
GET https://www.saudiexchange.sa/wps/portal/.../today-disclosures  → 200 shell,
    references /Resources/ 399× (data itself is walled)
```

This is the **SGX class of block**: the portal shell is reachable but the structured
disclosure/financial JSON under `/Resources/` is Imperva-walled to non-residential egress. The
only reachable thing is the inline market-watch table (a fragile `CompanyResolve`).

**SA verdict: SKIP** (or ship a resolve-only `SA` from the inline market-watch HTML if a
one-intent, HTML-scrape adapter is acceptable — but it is brittle and Imperva may tighten). Do
**not** promise SA filings/insiders/owners/financials on free keyless data.

---

## 5. Nigeria (`NG`) — SKIP (honestly thin)

Verification: NGX Group, SEC Nigeria, CAC. As anticipated, thin.

| Intent | NG feasibility | Evidence |
|---|---|---|
| `CompanyResolve`/`CompanyFilings`/`CompanyDocument` | ❌ | NGX (`ngxgroup.com`) is a **WordPress site** — `wp-json/wp/v2/*` is open (`200`) but serves only website content/news, **no structured issuer or disclosure feed**. `doclib.ngxgroup.com` → **`401`** (auth). `issuers/corporate-disclosures` → `301` |
| SEC Nigeria | ❌ | `sec.gov.ng` up (`200`) but no keyless structured disclosure API |
| CAC (Corporate Affairs Commission) public search | ❌ | `search.cac.gov.ng` → **`403`**; `pre.cac.gov.ng` portal is registered/paid |
| `OwnershipChain` | ✅ global | GLEIF (the only NG-touching source, already shipped) |

**NG verdict: SKIP.** No free, keyless, redistributable, parseable structured source exists;
NGX's real market/disclosure data sits behind vendor/subscription and CAC behind a `403` wall.
Nigeria is reachable today only through the global GLEIF path the repo already has.

---

## Auth / licence / reachability summary (all markets)

| Source | Auth | Licence | Reachable from box | Verdict |
|---|---|---|---|---|
| **AFM** `export.aspx?type=<GUID>&format=csv\|xml` | none | AFM © rights-reserved (statutory register) | ✅ `200` CSV **and** XML | **NL `CompanyOwners` + `CompanyInsiders` ✅ (standout)** |
| KVK API `api.kvk.nl` | **paid key** | — | ❌ `401` | private resolve/appointments ❌ |
| **DFM** `api2.dfm.ae/efsah` + `feeds.dfm.ae/documents` | none | DFM/issuer © | ✅ JSON `200` + PDF `200` | **AE `CompanyFilings` + `CompanyDocument` ✅ (Dubai)** |
| ADX `www.adx.ae` | — | — | ❌ `403` (Imperva) | Abu Dhabi ❌ |
| DIFC `difc.ae/public-register` | — | — | ❌ `429` (Cloudflare) | free-zone register ❌ |
| ADGM `registration.adgm.com` | — | — | ❌ `403` | free-zone register ❌ |
| **KAP** `kap.org.tr` SSR + `/en/api/BildirimPdf/<id>` | none | KAP/MKK © | ✅ SSR `200` + PDF `200` | **TR `CompanyResolve` + `CompanyDocument` ✅** |
| KAP `kapsitebackend.mkk.com.tr` (JSON backend) | — | — | ❌ DNS unresolvable | disclosure enumeration friction |
| Saudi Exchange portal HTML | browser headers | Imperva © | ⚠️ shell `200`, inline market-watch only | `CompanyResolve` fragile |
| Saudi Exchange `/Resources/*` data | — | — | ❌ Imperva "Request Rejected" | filings/financials ❌ |
| NGX `wp-json` / `doclib.ngxgroup.com` | none / **auth** | — | ⚠️ news only / `401` | ❌ no issuer feed |
| CAC `search.cac.gov.ng` | — | — | ❌ `403` | ❌ |
| GLEIF | none | CC0 | ✅ all five markets | `OwnershipChain` ✅ everywhere |

## Recommended build order

1. **NL / AFM** — `CompanyOwners` (substantial holdings + net short) + `CompanyInsiders` (MAR
   Art.19 + directors) from keyless XML export. Effort **S–M**. Highest value; distinct ADD over
   ESEF; mind the ESAP-2027 overlap.
2. **AE / DFM** — `CompanyFilings` + `CompanyDocument` via `efsah` keyless JSON + PDF. Effort
   **S–M**. Flag Dubai-only (ADX/DIFC/ADGM walled).
3. **TR / KAP** — `CompanyResolve` (SSR directory) + `CompanyDocument` (keyless `BildirimPdf`).
   Effort **M** (SSR/RSC enumeration parsing). Whole-BIST coverage.
4. ✋ **SA** — SKIP or resolve-only from inline market-watch HTML (fragile, Imperva).
5. ✋ **NG** — SKIP; GLEIF-only, honestly thin.
