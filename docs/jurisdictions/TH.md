# TH — DBD juristic-person register (openapi.dbd.go.th)

**Data source:** Thailand's [Department of Business Development
(DBD)](https://www.dbd.go.th/) juristic-person register, over the keyless
`openapi.dbd.go.th/api/v1/juristic_person/{id}` endpoint; company-name search over the
[DGA Government Data Exchange (GDX)](https://kb.dga.or.th/gdx/7api-dbd/) gateway
(`api.egov.go.th`). **Credentials:** none for the by-id lookup; `DBD_API_KEY` (a free DGA
GDX registration key) for name search. **Licence:** Thai government open data.

DBD is a **national company register covering listed *and* private companies** — the TH
analogue of SG ACRA and GB Companies House, and richer than either because it carries
**registered and paid-up capital**. It resolves a company to both its Thai and English legal
names, juristic type, status, TSIC objective code, register date and head office.

Thailand splits cleanly: the **register is an open win**, the **listed-disclosure side is
walled or brittle**. So TH is a **resolve-only** jurisdiction — see [Why nothing
else](#why-nothing-else-is-supported).

## Accepted `company` inputs

A **13-digit juristic-person registration number** (e.g. `0107544000108` for PTT PCL) —
this is the **keyless** path and the only one the open endpoint accepts. Spaces and hyphens
are tolerated.

Or a **company name in Thai or English**, which requires `DBD_API_KEY`. The keyless host has
**no name-search sibling**: every name-search path shape probed on `openapi.dbd.go.th`
returns `404` or the Incapsula shell, and the `opendata.dbd.go.th` CKAN mirror is
Incapsula-walled. Name search exists only on the key-gated GDX gateway
(`/ws/dbd/juristic/v4/profile/infobyname`), which answers `403 ForbiddenException: consumer
not found` without a key and `401 UnauthorizedException: token not found` with a bad one.

Name-search hits are **re-resolved through the keyless by-id endpoint** before being served,
so every fact returned comes from the endpoint this package verified live, not from the
key-gated gateway's (unverified) envelope shape.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Resolution by juristic number (keyless) or name (needs `DBD_API_KEY`) → juristic number, **Thai + English legal name**, juristic type, status, register date, **registered and paid-up capital**, TSIC objective code, branch, head office. Listed and private companies both resolve. |
| `CompanyFilings` | Unsupported — see below. |
| `CompanyInsiders` | Unsupported — see below. |
| `CompanyOwners` | Unsupported — see below. |
| `CompanyFinancials` | Unsupported — see below. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Why nothing else is supported

- **SET (the Thai exchange) is Incapsula-walled.** `www.set.or.th/api/set/…` (company
  profile, highlight, news) returns `403` with the Imperva/Incapsula shell on plain requests.
- **The SEC `idisc` filings API is keyless but brittle.** Listed-company regulated filings
  (56-1 One Report, financial statements) live on `market.sec.or.th/public/idisc`, whose
  front-end drives a keyless ASP.NET Web API. Requests reach the target method
  (`GetCompanyReturnUniqueIdReference(String str, String lang)`, confirmed from a leaked
  stack trace) but throw an internal `NullReferenceException` on every parameter shape
  probed. Feasible in principle; a meaningful reverse-engineering project, not a turnkey
  source. Tracked as a follow-on R&D item.
- **The keyed SEC APIM gateway is mostly funds.** `api.sec.or.th` issues a free subscription
  key via `api-portal.sec.or.th`, but its products are predominantly mutual-fund / AMC data
  (`/FundFactsheet/…`), not listed-company disclosure — low value for these intents.
- **DBD's own officer / shareholder / financial-statement endpoints are key-gated GDX
  surfaces**, and the statement endpoints return **images and PDFs**, not normalized figures.
  The keyless juristic-person register carries capital but no financial statements.

## Caveats

- DBD is a **register snapshot**, not a filing or disclosure feed: no filings, officers,
  shareholders, charges or financial statements.
- **Status and juristic type are Thai-only strings** on this endpoint (e.g.
  `ยังดำเนินกิจการอยู่` — "still operating", `บริษัทมหาชนจำกัด` — "public limited
  company"). The TSIC objective carries both Thai and English text; the English form is
  preferred when present.
- The **English legal name leads** where the register carries one, with the Thai name kept as
  an alias so a Thai-script query still ranks. Thai-only entities lead with the Thai name.
- Register dates arrive as `YYYYMMDD`. The keyless endpoint uses **Common Era** (PTT reads
  `20011001`), but sibling DBD surfaces publish **Buddhist-era** years, so a year at or above
  2400 is folded back by the 543-year BE offset rather than emitted as a nonsense date.
- The by-id endpoint distinguishes **`1004` "No data available"** (a well-formed but
  unregistered number) from **`1051`** (a malformed number). Both are served as an honest
  empty result, not an error.
- The portal **root** (`openapi.dbd.go.th/`) is Incapsula-fronted and returns `403`; only the
  `/api/v1/…` path is open. Search-shaped paths under `/api/v1/` are challenged too, which is
  why the by-id path is the only keyless route.
- Absence is not proof a company is unregistered — try the exact 13-digit juristic number.

## Live verification

Verified through the built artifact on 2026-08-29 (keyless, no key configured):

| Juristic number | Legal name (EN) | Status | Registered capital | Registered |
|---|---|---|---|---|
| `0107544000108` | PTT PUBLIC COMPANY LIMITED | ยังดำเนินกิจการอยู่ | THB 28,562,996,250 | 2001-10-01 |
| `0107542000011` | CP ALL PUBLIC COMPANY LIMITED | ยังดำเนินกิจการอยู่ | THB 8,986,296,048 | 1999-03-12 |
| `0107537000025` | BANGKOK DUSIT MEDICAL SERVICES PUBLIC COMPANY LIMITED | ยังดำเนินกิจการอยู่ | THB 1,758,223,567.2 | 1994-01-03 |
