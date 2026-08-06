# US — SEC EDGAR + GLEIF

**Data source:** [SEC EDGAR](https://www.sec.gov/edgar) full-text search, submissions,
company-concept XBRL, and Form D/D-A XML, plus [GLEIF](https://www.gleif.org/) for
LEI/ISIN resolution and consolidation relationships.
**Credentials:** none. SEC requires a descriptive User-Agent with contact info — set
`DISCLOSURES_USER_AGENT` (or `SEC_EDGAR_USER_AGENT`). GLEIF is keyless.

## Accepted `company` inputs

A company name, a ticker, a bare CIK (with or without leading zeros), a 20-character LEI,
or an **ISIN** (resolved to the issuer's GLEIF record, then to its SEC identifiers).

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Combines SEC ticker/title matches and GLEIF candidates; returns all known CIK, ticker, LEI, and jurisdiction identifiers without merging weak matches. |
| `CompanyFilings` | EDGAR full-text search over a six-year window with direct archive-document URLs; a latest-report mode returns 10-K/20-F/40-F or 10-Q metadata and section links (not section text). |
| `CompanyInsiders` | Forms 3/4/5 (Section 16): named directors, officers with titles, and 10% owners, merged by owner CIK. Recency/completeness caveat applies. |
| `CompanyOwners` | Schedule 13D/13G filers (amendments included), newest first, with `thresholdRegime = "US Schedule 13D/13G: 5%"` on every row. |
| `CompanyFinancials` | Annual as-filed XBRL facts (revenue, income, balance sheet, EPS, cash-flow, R&D) by fiscal period end, with restatement dedupe and unit preference. |
| `PrivateRaises` | Form D / D-A exempt offerings: amounts (including `Indefinite`), investor counts, first-sale dates, and named executives/directors/promoters. **US-only in v1.** |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- Section 16 and Schedule 13D/13G are **recency-scoped** and not guaranteed complete.
- Consolidation relationships from GLEIF are not market-disclosure ownership or UBO tracing.
- Absence of a Form D does not prove a company never raised privately.
