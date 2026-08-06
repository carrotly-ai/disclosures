# IN — BSE India

**Data source:** [BSE India](https://www.bseindia.com/) corporate-announcement feed
("BSE-lite").
**Credentials:** none. BSE's `api.bseindia.com` host is anti-bot protected; if the default
fetch is throttled, inject a browser-backed `fetchFn` via `AdapterOptions`.

## Accepted `company` inputs

A company name or a **6-digit BSE scrip code**.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution against BSE listings. |
| `CompanyFilings` | Corporate-announcement feed with attachment PDF links. |
| `CompanyInsiders` | Unsupported — promoter/insider data is not surfaced. |
| `CompanyOwners` | Unsupported — 1%+ shareholding data is not surfaced. |
| `CompanyFinancials` | Unsupported — BSE financial data is not normalized here. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- The anti-bot host means unauthenticated calls can be throttled; a browser-backed
  `fetchFn` makes them reliable.
