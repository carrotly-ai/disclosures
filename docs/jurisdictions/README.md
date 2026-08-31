# Jurisdiction coverage

`disclosures` exposes six core tools that dispatch on a `jurisdiction` parameter
(default `US`), plus the jurisdiction-independent `OwnershipChain`. The tool names remain
stable between routes; where a jurisdiction has no normalized equivalent, the tool returns
an explicit **unsupported-jurisdiction explanation** rather than empty or fabricated data.

Three specialized tools cover filed documents and register primitives. `CompanyDocument`
serves **US**, **GB**, **JP**, **KR**, **FR**, **HK**, **CN**, **TR**, **AE**, **PH**, and
**AU**. `PersonAppointments` serves **US**, **GB**, **DE**, **FR**, and **AU**; AU supports
`disqualifications` only. `CompanyCharges` remains GB-only. ASX- and PSE-backed routes are
disabled before network access unless their separate terms-acknowledgement variables are
set; ASIC open-data AU routes remain available without ASX acknowledgement. Each page below
documents its identifiers, configuration, coverage, and caveats.

This directory documents each jurisdiction in depth. For the quickstart, client
configuration, and library API, see the top-level [README](../../README.md).

## Coverage matrix

| Intent | US | GB | EU | KR | JP | CN | IN | TW | BR | DE | FR | HK | SG | TH | NL | ID | MY | TR | AE | PH | AU |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `CompanyResolve` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `CompanyFilings` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | — | — | ✅ | ✅ | — | ✅ | ✅ | ⚠️ |
| `CompanyInsiders` | ✅ | ✅ | — | ✅ | — | ⚠️ | — | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| `CompanyOwners` | ✅ | ✅ | — | ✅ | ✅ | ⚠️ | — | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| `CompanyFinancials` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | — | ✅ | ✅ | — | — | ⚠️ | — | — | — | ✅ | — | — | — | ⚠️ | — |
| `PrivateRaises` | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `CompanyDocument` | ✅ | ✅ | — | ✅ | ✅ | ✅ | — | — | — | — | ✅ | ✅ | — | — | — | — | — | ✅ | ✅ | ✅ | ✅ |
| `CompanyCharges` | — | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `PersonAppointments` | ✅ | ✅ | — | — | — | — | — | — | — | ✅ | ✅ | — | — | — | — | — | — | — | — | — | ⚠️ |
| `OwnershipChain` | 🌐 Global via GLEIF — jurisdiction-independent (resolved from LEI or legal name) |

✅ supported · ⚠️ partial (see note) · — returns an honest unsupported-jurisdiction explanation · 🌐 global

FR `CompanyOwners` is **partial**: the five newest *franchissement de seuil*
notifications get a best-effort PDF text-layer extraction for holder, direction/date,
thresholds, and resulting capital/voting percentages. Scanned, non-standard, and older
notifications remain official link-only rows. See [FR.md](FR.md).

HK `CompanyOwners` is **partial**: it returns the keyless CCASS shareholding search —
participant/**custodian**-level holdings (custodian banks, brokers, HKSCC Nominees, and China's
CSDC for Stock-Connect shares), the HK analogue of DTC / "Cede & Co." concentration. These are
**not** beneficial owners: the SFO Part XV Disclosure of Interests register (the substantial-
shareholder feed) is captcha-walled, so it is linked for manual lookup rather than parsed. See
[HK.md](HK.md).

BR `CompanyOwners` and `CompanyInsiders` read the **Formulário de Referência (FRE)**
structured open data — no PDF extraction. Owners come from item 15 (posição acionária:
holder, CPF/CNPJ, % ON / % PN / % total, and the issuer's controlador / acordo de acionistas
marking); insiders from the item-12 administrator register (órgão, elective post, election
date, mandate term). Both are the **annual as-filed snapshot**, not a live cap table and not
a dealings feed, and only direct holdings are surfaced — rows describing a holder's own
ownership chain report percentages relative to the intermediary. Verified live: Vale (PREVI
7.016%, BlackRock 6.708%, Mitsui 6.45%) and Petrobras (União Federal 50.26% ON, flagged
controlador). See [BR.md](BR.md).

HK `CompanyFinancials` is **bounded/best-effort**: there is no structured-XBRL feed, so
headline figures are extracted from the issuer's **latest results-announcement PDF** (Final,
else Interim). Standard issuers extract cleanly (verified live: China Mobile in RMB, HSBC in
USD, Tencent in RMB); complex segment-split or multi-column statements parse partially, and a
page shortfall or missing statement **degrades to the PDF link** rather than serve uncertain
numbers. Latest announcement only — no historical series. See [HK.md](HK.md).

CN `CompanyFinancials` is **bounded/best-effort**: there is no keyless structured-XBRL feed, so
headline figures (revenue, profit, total assets, net assets) are extracted from the **主要会计数据
key-data table** of the issuer's **latest periodic-report PDF** (年度报告, else the newest
interim/quarterly) and normalized to whole RMB from the unit the report declares (元/千元/万元/百万元).
Verified live on a 10-issuer corpus spanning main board, ChiNext, STAR, a bank (千元) and an
insurer (百万元 — recovered by the object-stream extractor upgrade). A mojibake report (page/font
objects in an unreadable object stream), an over-cap PDF, or a missing key-data table **degrades
to the PDF link**. Latest report only — no history. See [CN.md](CN.md).

TH is **resolve-only**: DBD is a national company register covering listed *and* private
companies (Thai + English legal name, juristic type, status, registered/paid-up capital, TSIC
code, register date), but it carries no filing, officer, shareholder or financial-statement
feed. The by-id lookup is keyless; **name search needs `DBD_API_KEY`** (a free DGA GDX key)
because the keyless host has no name-search endpoint. Thailand's listed-disclosure side is
walled or brittle — SET is Incapsula-walled and the SEC `idisc` filings API throws internally
on every parameter shape probed — so every other TH intent is honest unsupported. See
[TH.md](TH.md).

CN `CompanyOwners` is **partial**: it parses the **前十名股东 top-10 shareholders** table from
the issuer's *freshest* periodic report (quarterlies carry it too). The data is real — the
actual major-shareholder register, not a custodian proxy — but the table is ragged and its
**column order varies by issuer**, so a value-heuristic parser emits only rows where both a
percentage and a holding count matched; unreadable rows are dropped, not guessed. It is an
**as-published point-in-time snapshot, not a live register and not UBO tracing**; state-owned
and nominee holders (香港中央结算) appear as printed. See [CN.md](CN.md).

CN `CompanyInsiders` is **partial and asymmetric by exchange**. **SZSE** codes (0/3xxxxx) route
to SZSE's keyless structured 董监高及相关人员股份变动 JSON feed — one row per reported
transaction with insider, position, date, shares (万股→whole), average price, reason, balance
and the holder's relationship. **SSE** codes (6xxxxx) have no equivalent public endpoint (the
Shanghai data sits inside a JS-gated credit file), so they fall back to the as-published
**董监高 board roster** in the latest annual-report PDF — names and positions only, since date
and shareholding cells fragment in extraction. A transaction feed and a roster snapshot answer
different questions; the response states which one it served. See [CN.md](CN.md).

ID is the **only jurisdiction here whose financials come from a national-exchange XBRL
instance**: IDX ships an `instance.zip` (plain XBRL, IDX 2020 `idx-cor` taxonomy) with every
financial-report submission, so ID `CompanyFinancials` is structured rather than PDF-scraped.
Its host, `www.idx.co.id`, is **anti-bot protected** — the BSE India tier, not the fatal
SGX/ASX block. The adapter sends browser-class headers and works wherever those pass; where
the edge refuses, **every ID intent returns an explicit "the host blocked this request —
inject a browser-backed `fetchFn`" note that states it is _not_ an empty result for the
issuer**, so a refusal is never mistaken for an absence of disclosure. `CompanyInsiders` and
`CompanyOwners` are honest unsupported (that detail lives in report PDFs and the KSEI
depository channel, not a clean IDX feed). Verified live through the built artifact: TLKM and
BBCA FY2025, consolidated, in IDR — including BBCA's banking revenue variant. See
[ID.md](ID.md).

`CompanyDocument` accepts `GB` (default), `US`, `JP`, `KR`, `FR`, `HK`, `CN`, `TR`, `AE`, `PH`, and
`AU`; `PersonAppointments` accepts `US`, `GB` (default), `DE`, `FR`, and `AU`
(`disqualifications` mode only); `CompanyCharges` is UK-only and takes no `jurisdiction`
parameter.

NL `CompanyOwners` / `CompanyInsiders` come from the AFM's **keyless whole-file register
exports**, which support **no server-side filtering** (an `?issuer=` parameter is ignored and
`Range` is not honoured), so a per-issuer view means downloading a register and filtering
client-side. The substantial-holdings CSV is **108,516,396 bytes / 293,488 rows**, so the
adapter reduces each register to a compact per-issuer digest at parse time (293k rows →
~2.4k records, ~0.39 MB) and caches only that digest for 24 h via `AdapterOptions.cache`.
**The first NL `CompanyOwners` call in a session takes ~20–30 s** (measured: ASML cold 28.8 s,
warm 7 ms); pass a cache so the digest survives process restarts. NL covers AFM-supervised
listed issuers only — KVK is paid — and **ESAP (2027+) will eventually overlap this
coverage**. See [NL.md](NL.md).

MY is served by **one** source: Bursa Malaysia's ~2.09-million-row company-announcements
search. It is unusual in carrying **first-class structured categories for both insiders and
owners** — the s.219 director-interest and s.138 substantial-shareholder announcements —
which share the exchange's `SH,CHSH` category, so both intents filter that one category and
separate by announcement-title prefix. The linked announcement documents turned out to be
**structured HTML, not PDFs**, so `CompanyInsiders` and `CompanyOwners` parse real
per-transaction detail (holder, trade date, transaction type, share count, resulting direct
and indirect holding), capped at 10 documents per call with the remainder honestly
link-only. **Both Bursa hosts are behind a Cloudflare managed challenge** whose clearance is
cookie-bound: verified live, not even a challenge-solved headless browser's own `fetch` or
jQuery call clears it — only the page's own auto-issued XHR does. Following the **BSE India
precedent**, every MY intent detects the interstitial and returns an honest message naming
`AdapterOptions.fetchFn`, never a fabricated or silently-empty result; with a browser-backed
`fetchFn` injected the route returns real data (verified live: Maybank 1155, Public Bank
1295, Glomac 5020). `CompanyFinancials` is unsupported — Bursa's results are announcement
documents, not a normalized feed — and SSM, the national registry, is paid, so
private-company lookups are honest unsupported. See [MY.md](MY.md).

**PH/PSE is a restricted opt-in source — read [PH.md](PH.md) before enabling it.**
PSE EDGE technically serves six keyless intents, including per-transaction insiders and a
named POR-1 ownership roster, but its terms restrict content to personal, non-commercial use
and prohibit redistribution to third parties. The package therefore refuses every PSE
network path unless `DISCLOSURES_ACKNOWLEDGE_PSE_TERMS=1` is set; enabled responses retain
the source/terms notice, and the operator remains responsible for having the necessary
rights. `CompanyFinancials` is partial—the PSE form's headline statement, not the full
audited statements. Unlisted Philippine companies remain out of scope because SEC eFAST is
login-walled and paid.

`OwnershipChain` takes no `jurisdiction` parameter: it is GLEIF Level-2 relationship data
for any entity worldwide. It reports accounting-consolidation parents and children, which
are **not** market-disclosure ownership and **not** UBO tracing.

## Data sources and credentials

| Jurisdiction | Source | API key | Page |
|---|---|---|---|
| US | SEC EDGAR + GLEIF | None (SEC needs a descriptive User-Agent) | [US.md](US.md) |
| GB | Companies House + FCA NSM + filings.xbrl.org | `COMPANIES_HOUSE_API_KEY` (NSM is inject-only) | [GB.md](GB.md) |
| EU | filings.xbrl.org (ESEF) + GLEIF | None | [EU.md](EU.md) |
| KR | DART / OpenDART | `OPENDART_API_KEY` | [KR.md](KR.md) |
| JP | EDINET | `EDINET_API_KEY` (search only; resolution is keyless) | [JP.md](JP.md) |
| CN | cninfo (SSE/SZSE/HKEX mirror) + SZSE disclosure API | None | [CN.md](CN.md) |
| IN | BSE India | None (host is anti-bot; inject a `fetchFn` if throttled) | [IN.md](IN.md) |
| TW | TWSE OpenAPI | None | [TW.md](TW.md) |
| BR | CVM open data | None | [BR.md](BR.md) |
| DE | BaFin AnteileInfo + DealingsInfo | None | [DE.md](DE.md) |
| FR | info-financiere.gouv.fr (OAM) + recherche-entreprises | None | [FR.md](FR.md) |
| HK | HKEXnews | None | [HK.md](HK.md) |
| SG | ACRA (data.gov.sg) | None | [SG.md](SG.md) |
| TH | DBD juristic-person register (openapi.dbd.go.th) | None for the by-id lookup; `DBD_API_KEY` for name search | [TH.md](TH.md) |
| NL | AFM disclosure registers (keyless CSV/XML exports) | None | [NL.md](NL.md) |
| ID | IDX / Bursa Efek Indonesia (`/primary` JSON + XBRL instances) | None (host is anti-bot; inject a `fetchFn` if blocked) | [ID.md](ID.md) |
| MY | Bursa Malaysia company announcements | None (keyless), but Cloudflare-challenged — inject a browser-backed `fetchFn` | [MY.md](MY.md) |
| TR | KAP (Kamuyu Aydınlatma Platformu) | None | [TR.md](TR.md) |
| AE | Dubai Financial Market (`api2.dfm.ae` efsah + `feeds.dfm.ae`) | None | [AE.md](AE.md) |
| PH | PSE EDGE (`edge.pse.com.ph`) | `DISCLOSURES_ACKNOWLEDGE_PSE_TERMS=1` after rights review | [PH.md](PH.md) |
| AU | ASIC registers on data.gov.au (CC BY 3.0 AU) + restricted ASX announcements | ASIC: none; ASX: `DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1` after rights review | [AU.md](AU.md) |

## Honesty invariants (all jurisdictions)

- **Resolution misses** return "Could not find…" / "No … found" **without** `isError`.
- **Configuration, upstream, parse, and rate-limit failures** return readable text with
  `isError: true`, naming the variable or condition to fix — never a silent empty result.
- Every link is a real, resolvable source URL; the library never fabricates identifiers or
  documents.
- **Absence is not proof.** No Form D does not prove a company never raised privately; a
  missing PSC does not prove no controller exists; a missing ECCTA identity-verification
  field does not prove an officer is unverified.
