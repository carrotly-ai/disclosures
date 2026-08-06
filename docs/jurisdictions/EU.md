# EU — filings.xbrl.org (ESEF)

**Data source:** [filings.xbrl.org](https://filings.xbrl.org/) JSON:API and xBRL-JSON
reports (pan-European ESEF annual filings), with [GLEIF](https://www.gleif.org/) for
legal-name → LEI resolution.
**Credentials:** none.

`EU` is a **financials-only pseudo-jurisdiction**. It exists to serve normalized IFRS
figures from the European Single Electronic Format; it is not a company registry.

## Accepted `company` inputs

A legal name or a 20-character **LEI**. A name is resolved to an LEI via GLEIF before the
ESEF report is fetched.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyFinancials` | Resolves the issuer by LEI, pulls its ESEF annual reports, and reads machine-tagged xBRL-JSON facts (revenue, profit, assets, equity, related concepts) by fiscal period end. Handles the OIM next-day-midnight period-end convention, prefers undimensioned group totals, drops interim periods, and lets a later restatement supersede the original. |
| `CompanyResolve`, `CompanyFilings`, `CompanyInsiders`, `CompanyOwners`, `PrivateRaises` | Return an explicit unsupported-jurisdiction explanation. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- Coverage is limited to issuers that have filed ESEF reports discoverable on
  filings.xbrl.org.
- Figures are as-tagged by the filer; tagging quality varies across issuers.
