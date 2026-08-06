# JP — EDINET

**Data source:** [EDINET](https://api.edinet-fsa.go.jp/) (Financial Services Agency).
**Credentials:** `EDINET_API_KEY` is required only for document search. `CompanyResolve`
works **without** a key because the EDINET code list is public.

## Accepted `company` inputs

A company name, an **EDINET code** (`E` + 5 digits), a 4/5-digit securities code, or a
13-digit corporate number. The EDINET code list is cached (24h default TTL) via the
injectable `AdapterOptions.cache`.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless — matches against the public EDINET code list. |
| `CompanyFilings` | Date-indexed disclosure-document search (requires `EDINET_API_KEY`). |
| `CompanyInsiders` | Unsupported — EDINET has no Section 16-style insider feed. |
| `CompanyOwners` | Unsupported — Japan's large-holding reports (大量保有報告書) are not in a normalized feed here. |
| `CompanyFinancials` | Unsupported in this release. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- EDINET search is date-indexed rather than company-indexed; resolution narrows to the
  issuer's EDINET code, then filings are queried within the date window.
