# GB — Companies House + FCA NSM + filings.xbrl.org

**Data sources:**
- [Companies House](https://developer.company-information.service.gov.uk/) — resolution,
  filing history, officer register, and persons-with-significant-control (PSC).
- [FCA National Storage Mechanism](https://data.fca.org.uk/) — DTR5/TR-1 major-holdings
  notifications, surfaced inside `CompanyOwners`.
- [filings.xbrl.org](https://filings.xbrl.org/) — UKSEF/ESEF annual financials, backing
  `CompanyFinancials`.

**Credentials:** `COMPANIES_HOUSE_API_KEY` is required for all Companies House operations.
The FCA NSM is **inject-only**: it has no public read API, so the TR-1 section appears only
when you inject your own `fetchFn` via `AdapterOptions`; the default path never contacts
`data.fca.org.uk`. filings.xbrl.org and GLEIF are keyless.

## Accepted `company` inputs

A company name or a Companies House **company number** (e.g. `01234567`). For
`CompanyFinancials`, a legal name or 20-character LEI (resolved via GLEIF).

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Companies House company search, ranked; returns the company number and any GLEIF LEI. |
| `CompanyFilings` | Companies House filing history; a latest-annual mode links the newest accounts filing. Latest-quarterly is unsupported (Companies House has no quarterly-report equivalent). |
| `CompanyInsiders` | Officer register (directors, secretaries) with role, occupation, appointment/resignation dates, and status. Correspondence address, nationality, and partial DOB are intentionally omitted. Includes an **Identity (ECCTA)** column — see below. |
| `CompanyOwners` | PSC register (statutory >25% control) with kind, natures of control, percentage band, and threshold regime — plus an **Identity (ECCTA)** column. When a `fetchFn` is injected, a supplementary DTR5/TR-1 major-holdings section (the ~3%+ voting-rights signal the PSC register omits) is appended; failure there degrades to a note and never displaces the PSC result. |
| `CompanyFinancials` | UKSEF/ESEF normalized IFRS figures (revenue, profit, assets, equity) by fiscal period end, from machine-tagged xBRL-JSON. |
| `PrivateRaises` | Unsupported — no Form D-equivalent private-raise dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## ECCTA identity verification

Under the Economic Crime and Corporate Transparency Act, identity verification became
mandatory for new appointments on **18 Nov 2025**. Companies House now populates an optional
`identity_verification_details` block on officer and PSC items, surfaced as an
**Identity (ECCTA)** column:

- `Verified 2025-11-20 (ACSP: NAME)` — verified via an Authorised Corporate Service Provider.
- `Verification statement supplied 2026-04-16` — statement supplied without an ACSP name.
- `Statement due by 2026-11-17` — verification pending.
- **Blank** — the field is absent. This is **not** proof the officer/PSC is unverified:
  Companies House fills the field progressively, and the public web record can show a
  verified status before this REST field is populated.

## Caveats

- The PSC register covers corporate entities and legal persons with statutory control; it
  is not a private-chain/UBO registry and is not guaranteed complete.
- The TR-1 section is supplementary and inject-only; it is never present on the default
  (no-`fetchFn`) path.
