# Jurisdiction coverage

`disclosures` exposes **seven intent-based tools** that dispatch on a `jurisdiction`
parameter (default `US`). The tool names never change between jurisdictions — only the
underlying data source does. Where a jurisdiction has no normalized equivalent to an
intent, the tool returns an explicit **unsupported-jurisdiction explanation** rather than
an empty or fabricated result.

Three further **filed-document / register tools** — `CompanyDocument`, `CompanyCharges`, and
`PersonAppointments` — originated as Companies House features. `CompanyDocument` now also
serves **US** (SEC EDGAR), **JP** (EDINET), **KR** (OpenDART), **FR** (info-financiere
OAM), and **HK** (HKEXnews); `PersonAppointments` also serves **US** (SEC EDGAR reporting
owners), **DE** (BaFin DealingsInfo notifying persons), and **FR** (recherche-entreprises
*dirigeants*), all via a `jurisdiction` parameter (default `GB`). `CompanyCharges` remains
UK-only for now. See [GB.md](GB.md), [US.md](US.md), [JP.md](JP.md), [KR.md](KR.md),
[FR.md](FR.md), and [HK.md](HK.md) for the per-jurisdiction document / person paths.

This directory documents each jurisdiction in depth. For the quickstart, client
configuration, and library API, see the top-level [README](../../README.md).

## Coverage matrix

| Intent | US | GB | EU | KR | JP | CN | IN | TW | BR | DE | FR | HK | SG | TH |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `CompanyResolve` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `CompanyFilings` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | — |
| `CompanyInsiders` | ✅ | ✅ | — | ✅ | — | — | — | ✅ | — | ✅ | — | — | — | — |
| `CompanyOwners` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ | — | ✅ | ⚠️ | ⚠️ | — | — |
| `CompanyFinancials` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | — | ✅ | ✅ | — | — | ⚠️ | — | — |
| `PrivateRaises` | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `CompanyDocument` | ✅ | ✅ | — | ✅ | ✅ | — | — | — | — | — | ✅ | ✅ | — | — |
| `CompanyCharges` | — | ✅ | — | — | — | — | — | — | — | — | — | — | — | — |
| `PersonAppointments` | ✅ | ✅ | — | — | — | — | — | — | — | ✅ | ✅ | — | — | — |
| `OwnershipChain` | 🌐 Global via GLEIF — jurisdiction-independent (resolved from LEI or legal name) |

✅ supported · ⚠️ partial (see note) · — returns an honest unsupported-jurisdiction explanation · 🌐 global

FR `CompanyOwners` is **partial**: it returns the *franchissement de seuil*
threshold-crossing notifications as a linked-PDF list, but the crossing holder and the exact
percentage live inside each PDF, not in a machine-readable field. See [FR.md](FR.md).

HK `CompanyOwners` is **partial**: it returns the keyless CCASS shareholding search —
participant/**custodian**-level holdings (custodian banks, brokers, HKSCC Nominees, and China's
CSDC for Stock-Connect shares), the HK analogue of DTC / "Cede & Co." concentration. These are
**not** beneficial owners: the SFO Part XV Disclosure of Interests register (the substantial-
shareholder feed) is captcha-walled, so it is linked for manual lookup rather than parsed. See
[HK.md](HK.md).

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

`CompanyDocument` accepts `GB` (default), `US`, `JP`, `KR`, `FR`, and `HK`; `PersonAppointments`
accepts `US`, `GB` (default), `DE`, and `FR`; `CompanyCharges` is UK-only and takes no
`jurisdiction` parameter.

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
| CN | cninfo (SSE/SZSE/HKEX mirror) | None | [CN.md](CN.md) |
| IN | BSE India | None (host is anti-bot; inject a `fetchFn` if throttled) | [IN.md](IN.md) |
| TW | TWSE OpenAPI | None | [TW.md](TW.md) |
| BR | CVM open data | None | [BR.md](BR.md) |
| DE | BaFin AnteileInfo + DealingsInfo | None | [DE.md](DE.md) |
| FR | info-financiere.gouv.fr (OAM) + recherche-entreprises | None | [FR.md](FR.md) |
| HK | HKEXnews | None | [HK.md](HK.md) |
| SG | ACRA (data.gov.sg) | None | [SG.md](SG.md) |
| TH | DBD juristic-person register (openapi.dbd.go.th) | None for the by-id lookup; `DBD_API_KEY` for name search | [TH.md](TH.md) |

## Honesty invariants (all jurisdictions)

- **Resolution misses** return "Could not find…" / "No … found" **without** `isError`.
- **Configuration, upstream, parse, and rate-limit failures** return readable text with
  `isError: true`, naming the variable or condition to fix — never a silent empty result.
- Every link is a real, resolvable source URL; the library never fabricates identifiers or
  documents.
- **Absence is not proof.** No Form D does not prove a company never raised privately; a
  missing PSC does not prove no controller exists; a missing ECCTA identity-verification
  field does not prove an officer is unverified.
