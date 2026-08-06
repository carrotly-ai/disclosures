# CN — cninfo

**Data source:** [cninfo](http://www.cninfo.com.cn/) (the CSRC-designated disclosure
portal), covering the Shanghai and Shenzhen exchanges plus an HKEX mirror.
**Credentials:** none. Resolution and the announcement feed use public POST endpoints.

## Accepted `company` inputs

A company name, a **6-digit A-share code**, or a **5-digit HK stock code**.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution across SSE, SZSE, and the HKEX mirror. |
| `CompanyFilings` | Date-filterable announcement feed with direct PDF links, including latest annual/quarterly periodic-report lookup. |
| `CompanyInsiders` | Unsupported — insider data lives inside Chinese-language report PDFs this release does not parse. |
| `CompanyOwners` | Unsupported — shareholding data lives inside report PDFs. |
| `CompanyFinancials` | Unsupported — cninfo publishes financials inside report PDFs. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Caveats

- `CompanyFilings` returns real announcement PDF links; the deeper insider/owner/financial
  intents degrade honestly rather than parsing report PDFs.
