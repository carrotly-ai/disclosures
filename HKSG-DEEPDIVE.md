# HK + SG deep-dive re-probe — what the zero-dep PDF extractor and harder wall-probing open

> **Status:** finding only — no code change ships with this document. Follow-up to
> `HKSG-FEASIBILITY.md`. Re-verifies each surface the original finding marked blocked, in
> light of two changes since: (1) the repo now ships a zero-dependency PDF text-layer
> extractor (`src/core/pdfText.ts`, 0.5.0; corpus-driven parsing proven for FR
> threshold-crossings in `parseThresholdCrossing`, 0.6.0), so PDF-locked data is no longer
> automatically infeasible; and (2) first-pass walls sometimes have side doors.
>
> All endpoints re-verified **live from this box on 2026-08-21**. This box's egress IP is
> **`219.75.71.94`** (Hong Kong, HKT) — material for the SGX verdict below.

## Headline

- **Two cells genuinely open** that the original finding marked ❌:
  1. **HK `CompanyFinancials` via results-announcement PDF extraction** — **FEASIBLE** (bounded,
     honest). The shipped extractor pulls consolidated income-statement and balance-sheet
     line items out of standard HK results announcements with **labels adjacent to figures in
     correct reading order**. This is the biggest unlock: it fills the HK financials cell using
     **only infrastructure we already ship** (HKEXnews servlet + `pdfText.ts`). Table
     fragmentation does *not* kill it for the common case; the dominant real failure mode
     (pages packed in compressed object streams) is **detectable**, so the mode degrades
     honestly instead of emitting wrong numbers.
  2. **HK `CompanyOwners` (partial) via CCASS shareholding search** — **FEASIBLE, keyless,
     no captcha**. `searchsdw.aspx` is a plain ASP.NET viewstate POST that returns clean
     participant-level shareholding. Strong caveat: it is **custodian/participant** level
     (HKSCC nominees, banks, brokers), **not** the beneficial-owner (DI) register.

- **Everything else stays as the original finding had it**, though the SGX *reason* changed:
  the wall is IP-reputation-based (this HK IP passes the edge and the securities API) but the
  announcements API is still auth-gated — not feasible for a portable server-hosted MCP.

---

## Per-surface verdict table (vs. the original finding)

| # | Surface | Original verdict | New verdict | What changed |
|---|---|---|---|---|
| A | **HK financials via results announcements** | ❌ PDF-locked | ✅ **FEASIBLE (bounded)** | Shipped extractor recovers IS+BS line items for standard issuers; ObjStm-packed glossy filings miss statements but are **detectable** |
| B | HK DI (owners/insiders) | ❌ captcha + form | ❌ **unchanged** | `NSSrchCorp/Date/Person.aspx` all 302→`Error.htm`; `sdinotice` login is **hCaptcha + password** |
| C | **HK CCASS shareholding** | (not separately assessed) | ⚠️ **FEASIBLE — partial owners** | `searchsdw.aspx` scriptable keylessly, **no captcha**; returns participant-level holdings (custodian, not beneficial) |
| D | data.gov.hk | marginal | marginal **unchanged** | Only the CR weekly newly-incorporated delta |
| E | HK CR e-Search (ICRIS) | ❌ paid | ❌ **unchanged** | `e-services.cr.gov.hk` 303; no free name→CR-number tier |
| F | **SGX side doors** | ❌ Akamai datacenter block + 401 | ❌ **not reliably feasible** (wall thinner than reported) | From this **HK IP**: `securities/v1.1` = **200**, main site = **200**; but announcements API = **Forbidden** (auth gate) and datacenter IPs still edge-blocked (403) |
| G | data.gov.sg beyond ACRA | ❌ resolve-only | ❌ **unchanged** | Full ACRA field list confirmed: officer **count** only, no names/financials/charges. No director/financial/charge dataset exists |
| H | MAS APIs | ❌ wrong domain | ❌ **unchanged** | FID (`/fid/institution`) is an HTML licensing directory, maps to no intent |

---

## A. HK financials via results-announcement extraction — the big unlock ✅ (bounded)

### How the data is fetched (all shipped infrastructure)

HKEXnews publishes standardized **Results Announcement** PDFs under headline category
`10000` ("Announcements and Notices"), sub-category group `t2Gcode=3`:

| t2code | Name |
|---|---|
| `13300` | **Final Results** (annual) |
| `13400` | **Interim Results** |
| `13600` | Quarterly Results |

(Verified live from the shipped `tiertwo_e.json`.) The existing `titleSearchServlet.do` with
`t1code=10000&t2Gcode=3&t2code=13300` returns the latest results announcement per issuer, and
its `FILE_LINK` is the same keyless PDF the `HK` adapter already fetches. So a
"latest results figures" mode needs **only** a new t2code filter + the already-shipped
`extractPdfText` — no new source, no new dependency.

**Verified servlet call** (Final Results, Tencent `stockId=7609`):
```
GET /search/titleSearchServlet.do?...&t1code=10000&t2Gcode=3&t2code=13300&stockId=7609&rowRange=5
→ 18/03/2026  ANNOUNCEMENT OF THE ANNUAL RESULTS ...  PDF 742KB
   FILE_LINK /listedco/listconews/sehk/2026/0318/2026031800388.pdf
```

### Corpus: 9 real results announcements, extracted with the shipped `pdfText.ts`

| Issuer | Code | PDF | Extractor pages | Declared pages | Font notes | IS+BS recovered? |
|---|---|---|---|---|---|---|
| China Mobile | 00941 | 167KB | 32 | 32 ✓ | 2 (harmless) | **Full — clean** |
| Tencent | 00700 | 742KB | 58 | 58 ✓ | 0 | **Full — clean** |
| HSBC | 00005 | 1.2MB | 31 | 31 ✓ | 0 | **Full — clean (3-yr)** |
| SHK Properties | 00016 | 874KB | 42 | 42 ✓ | 0 | **Full — clean** |
| Techtronic | 00669 | 445KB | 26 | 26 ✓ | 0 | **Full — clean** |
| HKEX | 00388 | 1MB | 98 | 98 ✓ | 0 | Present but **numbers fragmented + multi-column** ⚠ |
| Link REIT | 00823 | 248KB | 54 | 54 ✓ | 0 | Clean, but **unitholder label variants** ⚠ |
| CK Asset | 01113 | 549KB | 27 | 27 ✓ | 0 | IS clean; BS uses HK "assets less current liabilities" ⚠ |
| CK Hutchison | 00001 | 11MB | **33** | **183** ✗ | 0 | **Statements MISSING — pages in ObjStm** ✗ |

### Evidence — the tables survive extraction well (this was the central worry)

**China Mobile** — consolidated income statement, labels adjacent to *both-year* figures on
one line (verbatim from `extractPdfText`):
```
CONSOLIDATED STATEMENT OF COMPREHENSIVE INCOME ...
2025 2024
Revenue from principal businesses 895,530 889,468
Revenue from other businesses 154,657 151,291
1,050,187 1,040,759
...
Profit before taxation 175,608 178,389
Taxation 10 (38,344) (39,863)
PROFIT FOR THE YEAR 137,264 138,526
```
…and its balance sheet:
```
Total assets 2,128,182 2,108,127
Total liabilities 695,331 711,588
Total equity attributable to equity shareholders of the Company 1,428,475 1,392,032
Total equity 1,432,851 1,396,539
```

**Tencent** — same fidelity, one figure per line but reading order preserved:
```
Total assets
2,038,986
1,780,995
...
Total equity
1,241,065
1,053,896
```

**HSBC** (a bank, zero font notes) — balance-sheet highlights, three years adjacent:
```
Total assets ($m)  3,233,034  3,017,048  3,038,677
Total equity       205,666    192,273
```

The `TJ`/`Td` line-break heuristics in `pdfText.ts` keep each row's label immediately
followed by its numeric cells. A `parseThresholdCrossing`-style, corpus-driven parser keyed
on standard HKFRS/IFRS labels (`Revenue`, `Profit before taxation`, `Profit for the year`,
`Total assets`, `Total equity`) parses these reliably. Every issuer's **narrative highlights
block** near the top is even cleaner and independently carries revenue/operating-profit/
net-profit (e.g. China Mobile: "Operating revenue was RMB1,050.2 billion … Profit from
operations reached RMB148.9 billion").

### Honest failure modes (and which are detectable)

1. **Pages in compressed object streams (ObjStm) — the dominant real failure.** CK Hutchison's
   11MB announcement declares **183 pages** but the extractor reached only **33** — the linear
   `N G obj` scanner does not decompress `/ObjStm`, so ~150 pages (including the consolidated
   statements) are invisible. Ground-truth check with poppler `pdftotext` extracts **505KB**
   and finds "Consolidated Income Statement", "Total assets", "Total equity" — i.e. **the data
   is there; the extractor can't reach it**. Critically, this is **detectable**: the extractor
   returned 33 pages against a real 183. A "figures" mode can compare pages-reached to the
   PDF's declared `/Count` (or flag heavy `/ObjStm` presence with low page yield) and **degrade
   to link-only** rather than return a truncated/wrong balance sheet. In the 9-issuer corpus
   this was the **only** page-count mismatch (1/9).

2. **Multi-column segmented balance sheets fragment numbers.** HKEX's own balance sheet is a
   5-column "Corporate / Clearing-House-Funds / combined" layout; figures come out split across
   line breaks, e.g. `Total assets` → `547,\n221 ... 580,\n775 ... 353,576`. Numbers are
   *present* but need intra-token whitespace stripping **and** are column-ambiguous (which of
   five figures is "total"?). Banks/exchanges with segmented statements are the hard case.

3. **Label variants (recoverable with a lexicon).** REITs report "Net assets attributable to
   unitholders", not "Total equity"; HK-format property balance sheets use "Total assets less
   current liabilities", not a US-style "Total assets" line. The figures extract cleanly; only
   the label anchor differs. A modest label lexicon covers these.

### Realistic parse-success estimate & recommended shape

On this corpus:
- **Headline P&L (revenue / operating or gross profit / net profit):** ~**8/9** reliably —
  present in both the clean highlights block and the income statement. This is the safe core.
- **Total assets / total equity:** ~**5/9** clean directly; **+3/9** recoverable with a label
  lexicon + intra-number whitespace normalization; **1/9** (CKH) detectably missing.

**Verdict: FEASIBLE and honest, NOT "fragmentation kills it."** The right shape is a bounded
**"latest results announcement figures"** mode that (a) anchors on the highlights + consolidated
income statement for revenue/operating profit/net profit (highest reliability), (b) attempts
total assets/equity with a HKFRS/REIT/HK-property label lexicon and strips whitespace inside
number tokens, (c) uses the **page-shortfall signal** to detect ObjStm loss and degrade to
link-only, and (d) always returns the source PDF link. Rows it can't parse stay link-only —
exactly the `getInfoFinanciereOwners` pattern (`machineReadable` false vs. undefined).

> **Highest-leverage enabling enhancement:** add **ObjStm / cross-reference-stream
> decompression** to `pdfText.ts`. That single upgrade fixes the CKH-class files (the one hard
> failure here) *and* strengthens every PDF-reading adapter in the repo (US/CN/GB document
> text). Moderate effort, broad payoff.

---

## B. HK Disclosure of Interests (DI) — still ❌

DI is the SFO Part XV beneficial-owner / substantial-shareholder register — the real prize for
`CompanyOwners`/`CompanyInsiders`. Re-probed harder; still walled:

- `di.hkex.com.hk/di/NSSrchMethod.aspx` → 200, but a **frameset** loading
  `NSSrchCorp.aspx` / `NSSrchDate.aspx` / `NSSrchPerson.aspx`.
- Each of those, fetched directly, **302 → `/Error.htm?aspxerrorpath=...`** (entry/session
  gated; must arrive through the captcha flow). `NSSrch.aspx`, `NSList.aspx`,
  `summary/DSSSearch.aspx`, `NSNProfile.aspx` all 302 likewise.
- `sdinotice.hkex.com.hk/` → 302 → `/Home/Login`; that page contains **`hCaptcha` + password**
  (verified: `hCaptcha` ×4, `Password` ×48 in the HTML).
- No JSON/CSV/XML endpoint, no downloads/open-data section, no bulk file. `data.gov.hk` search
  for DI/shareholder returns nothing.

The contrast with CCASS (§C) is the tell: CCASS's `searchsdw.aspx` serves its form **directly
(200)**; DI's search pages **302 to an error page** unless entered through captcha. DI stays
honestly unsupported.

---

## C. HK CCASS shareholding search — NEW partial-owners door ⚠️ FEASIBLE

`www3.hkexnews.hk/sdw/search/searchsdw.aspx` (CCASS Shareholding Search) is a plain ASP.NET
WebForms page — **no captcha** anywhere in the HTML. A single viewstate round-trip yields
structured participant-level shareholding, keyless.

**Verified live** — fetch the page for `__VIEWSTATE`/`__VIEWSTATEGENERATOR`/`today`, then POST
`txtStockCode=00700`, `txtShareholdingDate=2026/08/20`, `__EVENTTARGET=btnSearch`:
```
POST searchsdw.aspx → 200, 405,966 bytes, 427 participant rows
```
Parsed rows (verbatim, Tencent):
```
Participant ID: C00019  THE HONGKONG AND SHANGHAI BANKING   Shareholding: 2,982,059,860   32.75%
Participant ID: A00003  CHINA SECURITIES DEPOSITORY AND CLEARING          606,939,263    6.66%
Participant ID: C00010  CITIBANK N.A.                                     601,156,113    6.60%
Participant ID: A00004  CHINA SECURITIES DEPOSITORY AND CLEARING          466,678,278    5.12%
```
plus the summary line "Shareholding in CCASS … 77.51% of issued shares" and a "Consenting
Investor Participants" section.

**Honest caveat — what this is and isn't.** CCASS shows shareholding at the **CCASS
participant** level (custodian banks, brokers, HKSCC Nominees, and China's CSDC for
Stock-Connect holdings) — the HK analogue of "Cede & Co / DTC" concentration. It is **not** the
beneficial-owner register (that's DI, §B). So it partially serves `CompanyOwners` as a
*custodian-concentration* view, and it must be labelled as such, not as substantial
shareholders. Effort: **M** (ASP.NET viewstate POST + row parser; same host/copyright posture
as the shipped `HK` adapter). Genuinely new and worth building as an explicitly-caveated
partial-owners signal.

---

## D. data.gov.hk — unchanged (marginal)

CKAN `package_search?q=companies` → 12 datasets; the only registry-relevant one is the CR
**"List of Newly Incorporated / Registered / Re-domiciled Companies…"** — a **weekly delta**,
not a searchable register (as the original finding recorded). No company-registry full index,
no listed-company data, no licensed-moneylender dataset (`q=moneylender` → 0). Leave out.

## E. HK Companies Registry e-Search — unchanged (paid)

`www.e-services.cr.gov.hk/ICRIS3EP/` → 303 (stateful portal). No free company-name→CR-number
tier surfaced. ICRIS remains per-search/per-document paid. Private-company resolve/docs/charges
stay unsupported.

---

## F. SGX side doors — wall is thinner than reported, but still ❌ for a portable MCP

This is the most-changed *diagnosis*, though not the verdict. From this box's **HK egress IP
`219.75.71.94`**:

| Endpoint | Original finding | Now (HK IP) |
|---|---|---|
| `api.sgx.com/securities/v1.1?...` | (implied blocked) | **200, 85KB JSON** (`{"meta":{"code":"200"...}}`) |
| `www.sgx.com/securities/company-announcements` | 403 to headless Chromium (datacenter) | **200** via direct curl |
| `investors.sgx.com/` | — | **200** |
| `api.sgx.com/announcements/v1.1/` (and v1.0, companyannouncements, securitiesissuer) | 403 Akamai + 401 | **403** — origin gateway `{"message":"Forbidden"}` (auth gate), `server: AkamaiGHost` |

So the original "**blanket** datacenter-IP block on all of `api.sgx.com`" is **not** what's
happening from a residential/HK IP: general securities data is openly reachable, and the main
site loads. **But** the *announcements / corporate-filings* API — the one that maps to
`CompanyFilings`/`CompanyOwners`/`CompanyInsiders` — is **auth-gated at the origin** (Forbidden
without a client-minted token) even from the passing IP.

Cross-check confirming it's **IP-reputation-based**: the datacenter-hosted `scraper-mcp`
(render_js, real Chromium) got **403 Access Denied (`errors.edgesuite.net`)** on the same
`company-announcements` URL that direct curl from this box returned 200. Same request, different
egress IP, opposite result.

**Verdict: still not feasible for a portable server-hosted MCP.** Reaching SGX announcements
requires *both* (a) an egress IP Akamai doesn't flag (this box happens to qualify; a cloud MCP
won't) *and* (b) reverse-engineering the client-minted authorization token. Neither is a stable
foundation. The nuance is worth recording in `SG.md` (the wall is auth-gate + IP reputation,
not a universal datacenter block), but SGX filings/owners/insiders/financials/docs stay ❌.

## G. data.gov.sg beyond ACRA — unchanged (resolve-only)

Full ACRA field set re-confirmed live (`datastore_search`, 'A' resource, 57 fields). It adds
`annual_return_date`, `account_due_date`, secondary SSIC, up to 15 former names, up to 5 audit
firms — but the ownership/officer/financial columns simply **do not exist**: only
`no_of_officers` (a **count**), no officer names, no shareholders, no financial figures, no
charges. No separate director/officer/financial-statement/charges dataset is published on
data.gov.sg (those are BizFile paid extracts). ACRA stays **resolve-only**; the extra date
fields are at most a minor `CompanyResolve` enrichment, not a new intent.

## H. MAS APIs — unchanged (not a disclosure source)

`eservices.mas.gov.sg/fid/institution` → 200 (60KB **HTML**) — the Financial Institutions
Directory (a licensing register of banks/insurers/capital-markets licensees), not a JSON API
and not company filings/owners/financials. `api.mas.gov.sg` / `secure.mas.gov.sg/fid/` don't
resolve. Maps to no intent. Out of scope, as before.

---

## Build recommendations — ranked by value / effort

| Rank | Build | Intent filled | Value | Effort | Notes |
|---|---|---|---|---|---|
| **1** | **HK `CompanyFinancials` — "latest results announcement figures"** mode | HK financials (currently ❌) | **High** | **M** | New t2code filter (13300/13400) + `pdfText.ts` (both shipped). Parse highlights + income statement for revenue/operating profit/net profit; label-lexicon BS; page-shortfall ⇒ link-only. Honest degrade built in. |
| **1a** | **Enhance `pdfText.ts` with ObjStm / xref-stream decompression** | (enables #1's hard case + all PDF adapters) | **High** | **M** | The single failure in the 9-issuer corpus (CKH) is ObjStm page loss. Fixing it in the shared extractor lifts every document-reading adapter, not just HK. Do alongside #1. |
| **2** | **HK CCASS partial-owners** (`searchsdw.aspx`) | HK owners (partial, custodian-level) | Med | **M** | Keyless viewstate POST, no captcha; clean participant rows. Must be labelled "CCASS participant/custodian holdings", **not** beneficial owners. |
| — | SGX announcements | SG filings/owners/insiders | — | High/fragile | Needs residential-IP egress + reverse-engineered token; not portable. Record the thinner-wall nuance in `SG.md`; keep ❌. |
| ✋ | HK DI, HK CR (ICRIS), data.gov.hk resolve, data.gov.sg officers/financials, MAS | — | — | — | Honest unsupported — unchanged. |

**Single best build:** **HK financials via results-announcement extraction (#1, with the
`pdfText.ts` ObjStm enhancement #1a)**. It converts a hard ❌ ("PDF-locked") into a real ✅
using only sources and machinery the repo already ships, the extraction quality is genuinely
good for standard issuers (proven on 8 of 9 real filings), and the one hard failure mode is
detectable so the mode never lies. CCASS partial-owners is a strong, clearly-caveated second.
SG opened nothing new; its walls hold (with a corrected explanation of *why* SGX blocks).
