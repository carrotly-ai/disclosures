# TW — TWSE OpenAPI

**Data source:** [TWSE OpenAPI](https://openapi.twse.com.tw/) whole-market open-data
snapshots (Taiwan Stock Exchange).
**Credentials:** none.

## Accepted `company` inputs

A company name or a **4-digit TWSE listing code**. The fetched whole-market datasets are
cached (6h default TTL) via the injectable `AdapterOptions.cache`. Republic-of-China
(`民國`) filing dates are converted to ISO.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution against the TWSE listing set. |
| `CompanyFilings` | Material-information announcements with clause/subject and a per-company profile link. |
| `CompanyInsiders` | Directors-and-supervisors register with current, at-election, and pledged share counts per holder. |
| `CompanyOwners` | >10% major shareholders, with an honest "no >10% holders reported" when the snapshot lists none. |
| `CompanyFinancials` | Unsupported — TWSE's open-data financials are not yet normalized here. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- The insider and owner feeds are whole-market snapshots filtered to the resolved company;
  they reflect the exchange's most recent published snapshot, not a real-time register.
