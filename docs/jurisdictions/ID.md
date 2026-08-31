# ID — IDX / Bursa Efek Indonesia

**Data source:** the [Indonesia Stock Exchange (IDX / Bursa Efek
Indonesia)](https://www.idx.co.id/) listed-company endpoints under
`www.idx.co.id/primary/…`, plus the XBRL/report archive on the same origin.
**Credentials:** none — but see [The browser-fetch tier](#the-browser-fetch-tier), which is
the single most important thing to know about this jurisdiction.
**Licence:** exchange copyright, no open-data licence — see [Licence and ToS
posture](#licence-and-tos-posture).

Indonesia is the **standout Southeast Asian market for this package**, for one reason: IDX
is the only SE Asian exchange that publishes **real, machine-readable XBRL financial
instances**. Every audited and interim financial-report submission ships an
`instance.zip` (a plain-XBRL instance under the IDX 2020 `idx-cor` taxonomy) alongside the
inline-XBRL package, the spreadsheet and the English/Indonesian PDFs. So ID
`CompanyFinancials` is **structured, not PDF-scraped** — unlike HK and CN, which are
PDF-bounded.

## The browser-fetch tier

**`www.idx.co.id` is anti-bot protected.** A plain request answers `403` with a
Cloudflare/Imperva challenge shell (verified live 2026-08-29 from this project's network);
the *same* paths return full JSON through a real browser-class client. This is the **BSE
India tier**, not the fatal SGX/ASX edge block — it is solvable by the consumer, so the
adapter is built to be solved.

The posture, which every ID intent honours:

1. **Try the direct fetch with realistic browser headers.** The adapter sends a real
   `User-Agent`, `Accept`, `Accept-Language`, a same-site `Referer` and
   `X-Requested-With: XMLHttpRequest`. Where the edge lets that through — as it does from
   many networks — ID works with no configuration at all.
2. **Where the edge refuses, say so.** A `403`, `503`, or a `200` that carries a challenge
   page instead of JSON raises a typed `IdxBlockedError` whose message names the escape
   hatch explicitly:

   > IDX returned HTTP 403 for this request — the host's anti-bot edge blocked it, so no
   > data could be read (**this is NOT an empty result for the issuer**). […] For reliable
   > access, inject a browser-backed `fetchFn` via `AdapterOptions`.

**The distinction in bold is the whole point.** A blocked request is never reported as "no
announcements found" or "no financials found". Silence and refusal look identical to a
caller unless the library keeps them apart, and mistaking one for the other is how a
research tool ends up asserting an issuer disclosed nothing when in truth it was never
asked.

### Injecting a browser-backed `fetchFn`

`AdapterOptions.fetchFn` accepts any `(url, init) => Promise<Response>`. Point it at
whatever passes the challenge in your environment — a headless-browser fetch bridge, a
residential-egress proxy, a caching gateway:

```ts
import { createTools } from "disclosures";

const tools = createTools({
  fetchFn: async (url, init) => {
    // e.g. route through a headless Chromium bridge that solves the challenge
    return browserBackedFetch(url, init);
  },
});
```

Everything downstream — resolution, the announcement feed, and the `instance.zip`
download — flows through that one function, so a single injection unblocks all three
intents. This is a TypeScript-library/custom-server capability: the stock `npx disclosures`
stdio process cannot receive a JavaScript function and therefore returns the typed refusal
when its own host is blocked.

## Accepted `company` inputs

A **4-letter IDX ticker (`kode emiten`)** — `BBCA`, `TLKM`, `AALI` — which is the exact,
server-filtered path and the identifier every other ID intent takes. Case is normalized.

Or an **issuer name**, matched against the full ~965-emiten roster with the package's
standard ranking (exact/contains/token). Names are as IDX spells them, e.g. `PT Bank
Central Asia Tbk.`.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | All listed emiten on the Main (`Utama`), Development (`Pengembangan`) and Special Monitoring (`Pemantauan Khusus`) boards → ticker, legal name, sector/subsector, listing board and listing date. `kodeEmiten` is carried in `sourceIdentifiers`. |
| `CompanyFilings` | Per-issuer disclosure announcements (*pengumuman*), date-windowed and limited, each linking the announcement PDF as filed. |
| `CompanyFinancials` | **XBRL-first.** Downloads the submission's `instance.zip` and extracts revenue, profit from operations, profit attributable to owners of the parent, total assets and total equity in IDR — current period plus the comparative prior year. |
| `CompanyInsiders` | Unsupported — see [Why nothing else](#why-nothing-else-is-supported). |
| `CompanyOwners` | Unsupported — see [Why nothing else](#why-nothing-else-is-supported). |
| `CompanyDocument` | Not routed for ID. `CompanyFilings` already returns the direct announcement PDF link; this release does not extract ID document text. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## `CompanyFinancials` — the XBRL path

The chain is deliberately bounded: **one** roster load, **one** report lookup (walking back
at most three report years to find the most recent audited submission), **one**
`instance.zip` download.

The instance is parsed with the same machinery shape as the JP EDINET path:

- **Concepts are matched by XML *local name*,** never by prefix, so any IDX taxonomy
  year or prefix variant (`idx-cor`, a future `idx-cor-2024`) resolves identically.
- **Only undimensioned period contexts qualify.** IDX names them `CurrentYearDuration`,
  `CurrentYearInstant`, `PriorYearDuration` and `PriorEndYearInstant` — note that IDX
  splits the comparative across *two* prefixes, both of which map to the prior period.
  Dimensioned contexts append a statement role and member
  (`CurrentYearInstant_3410000_NonControllingInterestsMember`), so a per-component figure
  can never be surfaced as a company total.
- **Units are honoured.** Only facts on the plain `iso4217:IDR` monetary unit are accepted;
  the divide-based `IDRPerShares` unit used for EPS is excluded, so a per-share figure can
  never be mistaken for a statement total. Values are **as-filed absolute rupiah** — the
  `LevelOfRoundingUsedInFinancialStatements` dei field describes the PDF's presentation,
  not the instance, whose facts are already full-scale.
- **Basis comes from the filer's own declaration.** IDX, unlike EDINET, does not file both
  bases side by side, so the consolidation basis is read from the dei field
  `WhetherTheFinancialStatementsAreOfAnIndividualEntityOrAGroupOfEntities`
  ("Entitas grup / Group entity" → consolidated).
- **Sector matters for revenue.** A bank files no `SalesAndRevenue`; it reports
  `TotalInterestAndShariaIncome` instead. The revenue concept lists the general-industry
  element first and the banking/financing variants after it, so the line follows whichever
  concept the filer actually tagged.
- **Parent-attributable lines are preferred** over group totals where both exist
  (`ProfitLossAttributableToParentEntity` over `ProfitLoss`;
  `EquityAttributableToEquityOwnersOfParentEntity` over `Equity`).

### Honest fallback

The XBRL path never guesses. Three distinct outcomes, each stated plainly:

| Situation | Result |
|---|---|
| Submission carries no `instance.zip` (spreadsheet/PDF only) | Empty facts + **the official report link** and the reason. |
| Instance present but tags none of the headline totals | Empty facts + the official report link and the reason. |
| No financial-report submission in the years scanned | An explicit "legitimately returns nothing" message. |
| Host blocked the download | **Raises** `IdxBlockedError` — it does *not* degrade to a link, because a transport refusal is not evidence about the filing. |

### Verified live

Through the built artifact on 2026-08-29, with a `fetchFn` supplied (FY2025 audited
submissions, filed dates as IDX reports them):

| Issuer | Revenue | Total assets | Total equity |
|---|---|---|---|
| PT Telkom Indonesia (Persero) Tbk (`TLKM`) | Rp 146,742,000,000,000 | Rp 287,759,000,000,000 | Rp 130,685,000,000,000 |
| PT Bank Central Asia Tbk. (`BBCA`) | Rp 98,912,652,000,000 *(interest + sharia income)* | Rp 1,586,828,536,000,000 | Rp 281,466,478,000,000 |

Both resolved consolidated, in IDR, with the prior comparative year alongside — and BBCA
exercised the banking revenue variant.

## Why nothing else is supported

- **`CompanyInsiders`** — IDX publishes no structured director/commissioner register and no
  Section 16-equivalent insider-dealing feed. Director and commissioner detail sits inside
  annual-report PDFs, and holdings changes arrive as "Monthly Report of Securities Holders
  Registration" announcement PDFs or through **KSEI** (the depository), a separate channel.
  None is a clean IDX JSON feed, so this release does not normalize it. Use
  `CompanyFilings` with jurisdiction `ID` to locate the underlying announcement.
- **`CompanyOwners`** — the same reason. Substantial- and controlling-shareholder
  disclosure reaches IDX as announcement PDFs ("Changes of controlling shareholder", the
  monthly registration report) and via KSEI, not as a structured holdings feed. A
  `forms: ["shareholder"]` filter on `CompanyFilings` finds those announcements.
- **AHU** (`ahu.go.id`, Ditjen AHU — the national legal-entity registry, Indonesia's
  analogue of ACRA/DBD) is a **paid PNBP per-document product**. Private-company profiles
  sit behind paid e-services, so there is no free private-company resolve for ID the way
  there is for SG and TH.
- **OJK** (`ojk.go.id`) is a **regulator/licensing site, not a company-filing store**. Its
  open datasets are mutual-fund and macro-prudential series. Out of scope for the same
  reason MAS is for SG.

## Licence and ToS posture

IDX site content is **exchange copyright with no open-data licence**, which is the *same*
posture as the already-shipped `bseIndia`, `cninfo`, `twseOpenApi` and HKEXnews adapters.
It differs from the explicit personal-use/no-redistribution restrictions on ASX and PSE
EDGE, whose routes are disabled before network access unless the operator sets a separate
terms-acknowledgement flag. ID needs no such gate because IDX does not impose that same
personal, non-commercial restriction in the terms reviewed for this adapter.

Under this package's **link-first, fetch-on-demand** model — return the official source
link, fetch content on the end user's behalf at the moment they ask, and cite the source —
ID sits squarely on accepted precedent. This package redistributes no IDX bulk dataset and
caches no corpus. Note also that a consumer who injects a `fetchFn` is making the request
under their own network identity and their own reading of IDX's terms; that is a
deliberate property of the design, not an oversight.

## Rate limiting and politeness

`idxRateLimiter` is a deliberately modest 60 requests/minute. IDX documents no limit, but
the host is challenged, and one `CompanyFinancials` call already costs a roster load, a
report lookup and an archive download. Being conspicuously polite to a host that is
already suspicious of automated traffic is the point.

Downloads are capped at 24 MB per instance archive, with the package's standard zip-bomb
guards (entry count, per-entry and total inflate limits) applied by `src/core/zip.ts`.

## Endpoints

| Purpose | Endpoint |
|---|---|
| Listed-company roster | `GET /primary/ListedCompany/GetCompanyProfiles?start=0&length=…&code=…` |
| Announcements | `GET /primary/ListedCompany/GetAnnouncement?indexFrom=…&pageSize=…&dateFrom=YYYYMMDD&dateTo=YYYYMMDD&lang=en&emitenType=s&kodeEmiten=…&SortColumn=KodeEmiten&SortOrder=asc` |
| Financial reports | `GET /primary/ListedCompany/GetFinancialReport?indexFrom=…&pageSize=…&year=YYYY&reportType=rdf&EmitenType=s&periode=audit&kodeEmiten=…&SortColumn=KodeEmiten&SortOrder=asc` |
| Attachments / instances | `GET /Portals/0/StaticData/…` (same origin, same edge) |

Two field-shape notes worth knowing if you extend this adapter:

- `GetAnnouncement` and `GetFinancialReport` **require their full parameter set**. A
  partial query answers `503` from the edge's Varnish tier rather than a validation error,
  which is easy to misread as rate limiting. It is not.
- `Kode_Emiten` arrives **space-padded to a fixed column width** in the announcement feed
  (but not in the profile feed), and attachment `File_Path` values contain literal spaces
  and a stray double slash as filed. Both are normalized by the adapter.
