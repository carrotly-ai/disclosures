# Document / charges / person-lookup parity — cross-jurisdiction feasibility finding

> **Historical research record.** US/JP/KR/DE/CN recommendations subsequently shipped. IN `CompanyDocument` remains the clearest pending parity item; charges outside GB remain unsupported by design. See current jurisdiction pages and the changelog.

**Question (roadmap task #43):** PR #18 added three Companies-House-specific tools —
`CompanyDocument` (filed-document content), `CompanyCharges` (security-interest register),
and `PersonAppointments` (person-level appointments + disqualifications). Which of the
other supported jurisdictions have free, open, machine-readable equivalents that could
extend these capabilities beyond GB, under the project's zero-runtime-dependency and
no-scraping-of-login-walled-sources invariants?

**Verdict, per capability:**

- **Filed-document content (`CompanyDocument` analog): broadly feasible.** US (SEC EDGAR),
  KR (OpenDART), and JP (EDINET) all have live-verified free document-content endpoints;
  CN and IN already expose per-filing PDF links through the shipped adapters. **US is the
  strongest and should go first.**
- **Person-level lookup (`PersonAppointments` analog): feasible for US and DE only.**
  SEC EDGAR treats reporting owners as first-class entities with their own CIKs and a
  cross-company role view (live-verified); BaFin DealingsInfo supports searching directors'
  dealings by *person* name (live-verified). No other jurisdiction has a usable free
  person-level search.
- **Charges register (`CompanyCharges` analog): not feasible anywhere else.** No other
  supported jurisdiction has a free national machine-readable security-interest register.
  The UK charges register is genuinely unusual. Recommend leaving `CompanyCharges` GB-only
  permanently and documenting that honestly.

Assessed against live endpoints on 2026-08-07. Verification subjects: Tesla/Elon Musk
(CIK 0001494730), Samsung Electronics (DART corp 00126380, rcept 20240312000736), EDINET
docID S100YRS6, SAP SE / "Klein" (BaFin), TSMC (TW GCIS 22099131).

---

## Capability 1 — filed-document content (`CompanyDocument` analog)

### US · SEC EDGAR — ✅ feasible, recommended first (live-verified)

EDGAR archives every filed document at stable, keyless, direct URLs — no redirect dance,
no signed URLs, no entitlement checks. Verified live:

- **Filing manifest:** `GET /Archives/edgar/data/{cik}/{accession-nodash}/index.json`
  returns a JSON directory listing of every document in the filing (a Tesla 10-K listed
  122 items with names and sizes, including the primary `.htm`, `FilingSummary.xml`,
  the full-filing `.txt`, `Financial_Report.xlsx`, and the `-xbrl.zip` bundle).
- **Document content:** any listed item is directly fetchable
  (`tsla-20231231.htm` → `200 text/html`, 2.7 MB).

Mapping onto the existing `CompanyDocument` design: `metadata` mode = the `index.json`
manifest (rendition list); `text`/`html` mode = fetch the primary document and strip
markup (the adapter already extracts iXBRL text for GB, and EDGAR primary documents are
iXBRL-flavoured HTML); a `save-to-disk` mode reuses the 25 MB cap and local-path pattern.
The existing 302-redirect/auth-strip machinery is *not even needed* — EDGAR is simpler
than Companies House. Filings resolve from the accession number the `CompanyFilings` tool
already returns, exactly as `transaction_id` chains from GB `CompanyFilings`.

Two design cautions: EDGAR full-filing `.txt` submissions can be enormous (choose the
primary document from `index.json`, never the `.txt`); and pre-2001 filings are scanned
or raw text with no structured rendition — report that honestly, like GB image-only
accounts.

### KR · OpenDART — ✅ feasible (live-verified)

`GET /api/document.xml?crtfc_key=…&rcept_no=…` returns the **original filing as a ZIP of
XML documents** (verified: Samsung's FY2023 annual report → 596 KB ZIP containing three
XML files, 7.4 MB decompressed). The library already ships a zero-dep ZIP reader (used
for EDINET) and already returns `rcept_no` from KR `CompanyFilings`. Caveats: the XML is
DART's proprietary document markup (needs tag-stripping to text, same class of problem as
iXBRL extraction); very recent filings can 404 with status `014` ("file does not exist")
before the archive catches up — surface that as an honest not-yet-available message.

### JP · EDINET — ✅ feasible (live-verified)

`GET /api/v2/documents/{docID}?type=2` returns the **filed PDF** (verified: `S100YRS6` →
`application/pdf`, 2 pages) and `type=1` returns the **XBRL ZIP** (verified:
`application/octet-stream` ZIP). Both use the existing `EDINET_API_KEY`. JP
`CompanyFilings` already returns docIDs, and the adapter already parses EDINET ZIPs and
CSVs. The PDF path can reuse the GB save-to-disk + page-count machinery unchanged.

### CN · cninfo — ⚠️ partial, low effort

The shipped CN adapter already builds `static.cninfo.com.cn` PDF URLs from each
announcement's `adjunctUrl`. A CN document mode would only add PDF save-to-disk (no text
rendition exists). Feasible but thin.

### IN · BSE — ⚠️ partial, fragile

Attachment PDFs are already linked (`AttachLive/{name}`), but the BSE host is anti-bot;
the adapter documents that a custom `fetchFn` may be needed. Not worth a dedicated
document mode until that constraint changes.

### TW / BR / DE — ❌ defer

TWSE OpenAPI is market-data JSON with no per-filing document endpoint (MOPS documents sit
behind POST/session flows); BR CVM open data is bulk CSV, with individual ENET document
links varying in stability; DE BaFin databases *are* the disclosure (no underlying
documents). All three return honest unsupported explanations.

## Capability 2 — person-level lookup (`PersonAppointments` analog)

### US · SEC EDGAR — ✅ feasible, recommended (live-verified)

EDGAR models Section 16 reporting owners as **entities with their own CIKs**, searchable
and enumerable with the endpoints the adapter already uses for companies:

- **Person search:** `browse-edgar?action=getcompany&company={name}&type=4&owner=include&output=atom`
  matches individuals (verified: "musk elon" → CIK 0001494730 with a Form 4 filing feed;
  "cook timothy" → three distinct person CIKs — like Companies House, one human can have
  several records, and homonyms are common, so match by name + issuer context, never
  assume one CIK per person). The adapter already parses this exact Atom shape.
- **Cross-company roles:** `cgi-bin/own-disp?action=getowner&CIK={personCik}` returns an
  HTML table of every issuer the person has reported to, with **role and latest
  transaction date** (verified for Musk: SpaceX "director, 10 percent owner, officer:
  CEO, CTO & Chairman"; Tesla "director, 10 percent owner, officer: CEO"; Endeavor
  "director"; SolarCity). This is the direct analog of GB `appointments` mode. It is an
  HTML table — the same class of zero-dep parsing as BaFin displaytag tables.
- **Person filing history:** `data.sec.gov/submissions/CIK{personCik}.json` works for
  person CIKs (verified: `entityType: "other"`, 172 filings, forms 3/4/5/13D — including
  filings against *private* issuers like SpaceX, a genuinely unique signal).
- **Disqualification analog:** the SEC's **SALI** (SEC Action Lookup for Individuals)
  covers individuals barred or sanctioned in SEC actions. It has **no JSON API**, but its
  public search page accepts GET query parameters
  (`/litigations/sec-action-look-up?last_name=…&first_name=…`, verified live). Mirror the
  GB pattern exactly: perform no scraping, and link the **safe public search page** for
  the record's own name. FINRA BrokerCheck does have a free JSON API
  (`api.brokercheck.finra.org`, verified live) but covers broker registration, a
  different regulatory domain — mention as a possible later extension, not v1.

Recommended shape: extend the existing `PersonAppointments` tool with a `jurisdiction`-like
dispatch **or** (cleaner, matching how the tool is documented today) add US modes:
`search` → browse-EDGAR person Atom; `appointments` → own-disp role table + submissions
JSON; `disqualifications` → SALI safe-search link only.

### DE · BaFin DealingsInfo — ✅ feasible (live-verified)

The DealingsInfo search form accepts `meldepflichtigerName={surname}` — a true
person-name search over directors' dealings (verified: "Klein" → a
`Name | Vorname | Titel | Position/Status | Datum des Geschäfts` table including SAP CEO
Christian Klein, Vorstand, 24.07.2026). The shipped DE adapter already parses these
displaytag tables. This yields a DE `search`/`appointments`-style capability keyed on
dealings history (roles come from Position/Status: Vorstand / Aufsichtsrat / "in enger
Beziehung"). No disqualification register exists at BaFin; Germany's
Gewerbezentralregister is access-restricted — that part stays unsupported.

### KR / JP / TW / BR / CN / IN — ❌ not feasible

- **KR:** DART insider-ownership reports are company-keyed; no person search API.
- **JP:** EDINET's v2 API lists documents by date only; holder-submitted 5% reports name
  the filer but there is no person-query endpoint.
- **TW:** GCIS open data (verified live, keyless JSON: TSMC company profile with
  responsible person) is company-keyed only; no cross-company person search.
- **BR:** CVM FRE bulk CSVs name administrators per company; no person index.
- **CN:** no public person-level register.
- **IN:** MCA21 holds DIN director data but it is login-walled (no free API) — out of
  scope under project invariants.

## Capability 3 — charges / security interests (`CompanyCharges` analog)

**No other supported jurisdiction qualifies.** Findings:

- **US:** there is no national register. UCC security interests are filed per state with
  the Secretaries of State; access is a patchwork (free web search in some states, paid
  bulk in most; only Connecticut has a confirmed free open-data API). Covering "US
  charges" honestly would require 50+ state adapters or a paid aggregator — both conflict
  with project invariants. The SEC holds no lien register. **Recommend: permanently
  unsupported, documented.**
- **IN:** MCA21 maintains an index of charges (CHG filings) but behind login — excluded.
- **KR/JP/TW/BR/CN/DE:** collateral registries are court/notary systems without free
  machine-readable access.

`CompanyCharges` should therefore keep its Companies-House-specific framing; the honest
answer elsewhere is that the register doesn't exist in open data, not that the tool is
unfinished.

## Recommendation and sequencing

| Priority | Work | Why | Status |
|---|---|---|---|
| 1 | **US `CompanyDocument` support** (EDGAR `index.json` manifest + primary-document fetch/save) | Biggest register, simplest mechanics (no auth, no redirects), chains off accessions `CompanyFilings` already returns | ✅ Delivered |
| 2 | **US `PersonAppointments` support** (person Atom search, own-disp role table, submissions JSON, SALI safe link) | Live-verified end-to-end; reuses existing Atom parsing; SpaceX-style private-issuer visibility is unique value | ✅ Delivered |
| 3 | **JP + KR `CompanyDocument` support** (EDINET type=1/2, DART document.xml) | Both live-verified, both key-gated paths already wired, both reuse the ZIP/PDF machinery | ✅ Delivered |
| 4 | **DE `PersonAppointments` (dealings-by-person)** | Verified, small, rides existing displaytag parser | ✅ Delivered |
| — | CN/IN document modes | Thin (CN) or fragile (IN); fold in opportunistically | Pending |
| ✋ | `CompanyCharges` beyond GB | Not feasible on free open data anywhere; document as permanently GB-only | By design |

If the extensions ship, the three tools stop being purely Companies-House-specific: the
natural design is a `jurisdiction` parameter defaulting to `GB` on `CompanyDocument` and
`PersonAppointments` (additive, existing calls unchanged), while `CompanyCharges` stays
GB-only with its rationale documented. This finding records the analysis only — no
adapter or tool change ships with it.
