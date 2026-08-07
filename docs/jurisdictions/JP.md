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
| `CompanyOwners` | Large-volume holding reports (大量保有報告書, the 5% rule) and their change reports (変更報告書), reverse-mapped to the subject issuer — each row is a ≥5% holder (requires `EDINET_API_KEY`). |
| `CompanyFinancials` | Unsupported in this release. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- EDINET search is date-indexed rather than company-indexed; resolution narrows to the
  issuer's EDINET code, then filings are queried within the date window.
- `CompanyOwners` reverse-maps EDINET's **filer-indexed** large-holding reports onto the
  subject issuer by matching each report's `issuerEdinetCode` to the resolved company, so
  the filer of each returned row is a ≥5% holder of it. Because there is no server-side
  subject filter, the scan walks a bounded window one calendar day per request (default
  ~1 year; narrow with `start_date`/`end_date`, which apply **only** to JP here). EDINET's
  day index carries **no holding ratio**, so exact percentages require opening the linked
  report (docID) in the EDINET viewer — parity with the SEC 13D/G path, which likewise
  returns the filing, not the exact stake. Filing-based disclosure only: not a share
  register and not UBO tracing, and absence is not proof no ≥5% holder exists.
