# SG — ACRA (data.gov.sg)

**Data source:** [ACRA](https://www.acra.gov.sg/) "Information on Corporate Entities" on
[data.gov.sg](https://data.gov.sg/), over the keyless CKAN `datastore_search` API.
**Credentials:** none. **Licence:** Singapore Open Data Licence v1.0 (worldwide, perpetual,
royalty-free; attribution required; personal data excluded) — cleanly redistributable.

ACRA is the SG analogue of the GB Companies House resolver, including previous-name history.
Singapore is a **thin, resolve-only** jurisdiction: ACRA is the *only* feasible SG intent on
free keyless data. SGX/SGXNet (listed filings, substantial-shareholder and director-dealings
announcements, financials, document PDFs) is **Akamai-blocked to datacenter IPs and
auth-gated** — a harder wall than BSE India, blocked even through a real headless browser, so
there is no `fetchFn` escape hatch. BizFile officer/shareholder/financial extracts are
**paid**.

## Accepted `company` inputs

A **Singapore UEN** (Unique Entity Number, e.g. `197200078R`, `53312345A`, `T05LL1103B`) or a
**company name**. The datasets are split by the **first letter of the entity name** (26
letters + an "Others" split for non-letter starts); a name query is routed to the split for
its first letter, then ranked client-side. A **UEN carries no name letter**, so a UEN lookup
first hits the thinner consolidated dataset to recover the name, then re-queries the
letter-split dataset for the rich record (former names, auditors, SSIC).

The alphabet-split resources (richer than the consolidated one) were enumerated live from the
data.gov.sg collection "ACRA Information on Corporate Entities" (collection `2`) on
2026-08-21 and are shipped as constants in `src/adapters/acraSg.ts`.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution by UEN or name → UEN, status, entity/company type, incorporation date, **former names**, auditor firm(s), and SSIC classification. |
| `CompanyFilings` | Unsupported — SGX/SGXNet is Akamai + auth walled; BizFile extracts are paid. |
| `CompanyInsiders` | Unsupported — SGXNet dealings are walled; ACRA exposes only an officer **count**, no names. |
| `CompanyOwners` | Unsupported — SGXNet substantial-shareholder announcements are walled; ACRA publishes no shareholder data. |
| `CompanyFinancials` | Unsupported — SGX financials are walled; ACRA/BizFile financial extracts are paid. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- ACRA is a **registry snapshot**, not a filing/disclosure feed. It exposes **no officer
  names** (only `no_of_officers`, a count), **no shareholders**, **no financial figures**,
  and **no charges** — those live in ACRA **BizFile** paid extracts.
- A full-text `q=` name query matches any field token, so results are ranked client-side; the
  first-letter routing assumes the registered name begins with the queried letter.
- Absence is not proof a company is unregistered — try the UEN, or the exact registered name.
