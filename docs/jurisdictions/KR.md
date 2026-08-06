# KR — DART / OpenDART

**Data source:** [OpenDART](https://opendart.fss.or.kr/) (Financial Supervisory Service).
**Credentials:** `OPENDART_API_KEY` is required for all KR operations.

## Accepted `company` inputs

A company name, an OpenDART **8-digit corp code**, or a **6-digit stock code**. The
corp-code archive is a large reference download and is cached (24h default TTL) via the
injectable `AdapterOptions.cache`.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Matches against the OpenDART corp-code list; returns the corp code and stock code. |
| `CompanyFilings` | Periodic and major reports (사업보고서, 분기·반기보고서, etc.) with links; latest-annual/quarterly modes supported. |
| `CompanyInsiders` | Executive and major-shareholder ownership reports (임원·주요주주 소유보고). |
| `CompanyOwners` | 5%+ mass-holding reports (대량보유상황보고), with the DART 5% threshold regime on every row. |
| `CompanyFinancials` | Annual major-account financials (주요계정) by fiscal period end. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- Ownership and financial coverage follows what DART discloses in its structured feeds;
  narrative report bodies are not parsed.
