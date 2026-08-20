# EU — filings.xbrl.org (ESEF)

**Data source:** [filings.xbrl.org](https://filings.xbrl.org/) JSON:API and xBRL-JSON
reports (pan-European ESEF annual filings), with [GLEIF](https://www.gleif.org/) for
legal-name → LEI resolution.
**Credentials:** none.

`EU` is an **ESEF-filer pseudo-jurisdiction**. It exposes the pan-European financial-report
index that filings.xbrl.org maintains — resolution, filing list, and normalized IFRS
figures for issuers that filed in the European Single Electronic Format. It is **not** a
company registry: only listed issuers that filed an ESEF/UKSEF/FRS report appear.

## Accepted `company` inputs

A legal name or a 20-character **LEI**. `CompanyResolve` and `CompanyFilings` match a name
directly against the filings.xbrl.org register (case-insensitive `ilike` on the entity
name); `CompanyFinancials` resolves a name to an LEI via GLEIF before fetching the ESEF
report. An LEI is used exactly in every path.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Searches the filings.xbrl.org `/api/entities` register (exact `identifier` for an LEI, `ilike` on `name` for a legal name), ranks matches best-first, and enriches the top match with its country and newest-filing viewer link. Every result is a confirmed ESEF filer. |
| `CompanyFilings` | Lists the issuer's ESEF/UKSEF annual reports newest reporting period first, each with period end, country, index date, and links to the iXBRL viewer plus the report package, xBRL-JSON, and xHTML documents. Supports `start_date`/`end_date` (bounding the register's index date), `limit`, and `mode: "latest_annual"`. `mode: "latest_quarterly"` is rejected — ESEF is annual-only. Never returns document text. |
| `CompanyFinancials` | Resolves the issuer by LEI, pulls its ESEF annual reports, and reads machine-tagged xBRL-JSON facts (revenue, profit, assets, equity, related concepts) by fiscal period end. Handles the OIM next-day-midnight period-end convention, prefers undimensioned group totals, drops interim periods, and lets a later restatement supersede the original. |
| `CompanyInsiders`, `CompanyOwners`, `PrivateRaises` | Return an explicit unsupported-jurisdiction explanation. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

The `fxo_id` returned in `CompanyFilings` structured output (as `transactionId`) is the
stable per-filing identifier a future `CompanyDocument` EU path could accept;
`CompanyDocument` does not serve EU in this release.

## Caveats

- Coverage is limited to issuers that have filed ESEF reports discoverable on
  filings.xbrl.org. Alternative-market issuers (e.g. First North) are ESEF-exempt, and some
  national OAMs hamper collection — a miss never proves a company did not report.
- Figures are as-tagged by the filer; tagging quality varies across issuers.
