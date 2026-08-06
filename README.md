# disclosures

Free, open-source corporate-disclosure research through official sources. `disclosures` is both a TypeScript library and a stdio [Model Context Protocol](https://modelcontextprotocol.io/) server.

Version 0.1 ships nine data sources behind seven jurisdiction-agnostic tools:

- **US SEC EDGAR** (default) — filings, annual/quarterly report metadata, Section 16 insiders, Schedule 13D/13G filers, annual XBRL financials, and Form D private raises.
- **GLEIF LEI** (global) — entity resolution and reported direct/ultimate accounting-consolidation relationships.
- **filings.xbrl.org ESEF/UKSEF** (`jurisdiction: "EU"` and `"GB"`) — keyless, LEI-indexed annual IFRS financials parsed from the machine-readable xBRL-JSON reports European and UK issuers file under ESEF/UKSEF (FY2020+), surfaced inside `CompanyFinancials`.
- **UK Companies House** (`jurisdiction: "GB"`) — company resolution, filing history, the officer register, and persons-with-significant-control records.
- **UK FCA National Storage Mechanism** (`jurisdiction: "GB"`, inject-only) — DTR5/TR-1 "notification of major holdings" (the ~3%+ equity/voting-rights signal Companies House PSC does not carry), surfaced inside `CompanyOwners`. The NSM has no public read API, so this source stays dormant unless you supply your own access via an injected `fetchFn`; otherwise the GB owners view explains how to enable it.
- **South Korea DART / OpenDART** (`jurisdiction: "KR"`) — company resolution, periodic reports, executive/major-shareholder ownership, 5% mass-holding reports, and annual major-account financials.
- **Japan EDINET** (`jurisdiction: "JP"`) — company resolution and date-indexed disclosure documents (annual securities reports, quarterly/semi-annual reports, and more).
- **China cninfo** (`jurisdiction: "CN"`) — keyless company resolution across the Shanghai and Shenzhen exchanges (and HKEX mirror) plus a date-filterable announcement feed with direct PDF links and latest annual/quarterly periodic-report lookup.
- **India BSE** (`jurisdiction: "IN"`) — keyless company resolution and a corporate-announcement feed with attachment PDF links ("BSE-lite"; shareholding data is not surfaced).

The seven tool names and schemas stay stable as jurisdictions are added; each new source dispatches behind the same intents rather than adding jurisdiction-specific tool names. Every tool states its data source, its coverage limits, and that absence of a filing is not proof an event never happened.

## Tools

| Tool | Returns |
|---|---|
| `CompanyResolve` | Canonical candidates and known CIK, ticker, LEI, and jurisdiction identifiers. |
| `CompanyFilings` | Filing dates, types, descriptions, and direct SEC links; a latest-report mode returns metadata and links to key sections, not the section text. |
| `CompanyInsiders` | Recent named directors, officers and titles, and 10% owners reported in Forms 3/4/5. |
| `CompanyOwners` | Schedule 13D/13G filers with form, date, links, and the US 5% threshold regime. |
| `CompanyFinancials` | Annual as-filed revenue, income, balance-sheet, EPS, cash-flow, and R&D facts by fiscal period end (US XBRL, KR DART major accounts, or GB/EU normalized IFRS from ESEF/UKSEF). |
| `OwnershipChain` | GLEIF direct and ultimate accounting-consolidating parents, reporting exceptions, and known direct children. |
| `PrivateRaises` | US Form D exempt offerings, amounts, investor counts, and named executives/directors/promoters. US-only in v1. |

All `company` inputs accept a name or a jurisdiction-specific identifier: a ticker/CIK, LEI, or ISIN (US — an ISIN resolves to its issuer's GLEIF record), a Companies House company number (GB), an OpenDART 8-digit corp code or 6-digit stock code (KR), an EDINET code (`E` + 5 digits), 4/5-digit securities code, or 13-digit corporate number (JP), a 6-digit A-share or 5-digit HK stock code (CN), or a 6-digit BSE scrip code (IN). Tools accept `jurisdiction: "US" | "GB" | "EU" | "KR" | "JP" | "CN" | "IN"` (default `US`); `OwnershipChain` is global via GLEIF. The `EU` route serves only `CompanyFinancials` (pan-European ESEF financials, keyed by legal name or 20-character LEI); every other intent under `EU` returns an explicit unsupported-jurisdiction explanation.

Where a jurisdiction lacks a normalized equivalent to a US intent — for example EDINET has no Section 16-style insider feed, neither Companies House nor DART nor EDINET exposes a Form D-equivalent private-raise dataset, and Chinese/Indian ownership and financial detail lives inside report PDFs this release does not parse — the tool returns an explicit unsupported-jurisdiction explanation rather than an empty or fabricated result. For CN and IN, `CompanyFilings` returns real announcement PDF links; the deeper insider/owner/financial intents are the ones that degrade honestly.

## SEC User-Agent configuration

SEC EDGAR requires a descriptive User-Agent containing contact information. Set:

```bash
export DISCLOSURES_USER_AGENT="Your Organization your-email@example.com"
```

`SEC_EDGAR_USER_AGENT` is also accepted for compatibility. `DISCLOSURES_USER_AGENT` takes precedence. No API key is required for SEC EDGAR or GLEIF.

## Non-US jurisdiction credentials

Each non-US source uses its own free API key. Provide only the keys for the jurisdictions you query; US/GLEIF calls keep working without them.

| Jurisdiction | Environment variable | Where to get it | Notes |
|---|---|---|---|
| GB — Companies House | `COMPANIES_HOUSE_API_KEY` | [developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/) | Required for all GB operations. |
| GB — FCA NSM (TR-1) | _(none — inject-only)_ | — | The FCA National Storage Mechanism has no public read API. `CompanyOwners` GB adds the DTR5/TR-1 major-holdings section only when you inject your own `fetchFn` via `AdapterOptions`; the default path never contacts `data.fca.org.uk`. |
| KR — OpenDART | `OPENDART_API_KEY` | [opendart.fss.or.kr](https://opendart.fss.or.kr/) | Required for all KR operations. |
| JP — EDINET | `EDINET_API_KEY` | [EDINET API (v2) registration](https://api.edinet-fsa.go.jp/) | Required only for document search; JP `CompanyResolve` works without it because the EDINET code list is public. |
| CN — cninfo | _(none)_ | — | Keyless. Resolution and the announcement feed use public POST endpoints. |
| IN — BSE | _(none)_ | — | Keyless. BSE's `api.bseindia.com` host is anti-bot protected; if the default fetch is throttled, inject a browser-backed `fetchFn` via `AdapterOptions`. |
| GB / EU — filings.xbrl.org (ESEF/UKSEF) | _(none)_ | — | Keyless. `CompanyFinancials` with `jurisdiction: "GB"` or `"EU"` reads the public filings.xbrl.org JSON:API and xBRL-JSON reports; resolving a legal name to an LEI uses GLEIF (also keyless). |

Missing credentials produce a readable, flagged error naming the variable to set — never a silent empty result.

## Quickstart

Run the server with Node 18+ through npm:

```bash
npx -y disclosures
```

### Claude Code

```bash
claude mcp add --transport stdio disclosures \
  --env DISCLOSURES_USER_AGENT="Your Organization your-email@example.com" \
  -- npx -y disclosures
```

### Claude Desktop and Cursor

Add this server to the client's MCP configuration:

```json
{
  "mcpServers": {
    "disclosures": {
      "command": "npx",
      "args": ["-y", "disclosures"],
      "env": {
        "DISCLOSURES_USER_AGENT": "Your Organization your-email@example.com"
      }
    }
  }
}
```

Restart the client after changing its configuration.

## TypeScript library

The same package can be imported without starting stdio:

```ts
import {
  createDisclosuresServer,
  createDisclosuresTools,
  resolveCompanyCik,
  resolveLei,
} from "disclosures";

const tools = createDisclosuresTools({
  env: {
    DISCLOSURES_USER_AGENT: "Your Organization your-email@example.com",
  },
});

const result = await tools.CompanyResolve.handler({
  company: "NVDA",
});

const server = createDisclosuresServer();
```

Adapter functions accept `{ fetchFn?, env?, cache? }`, making them suitable for deterministic tests and embedding.

### Caching reference downloads

Two adapters resolve companies against large, slow-changing reference archives that
regenerate about once a day: the OpenDART corp-code list (`jurisdiction: "KR"`) and the
EDINET code list (`jurisdiction: "JP"`). Without a cache these are memoized per process,
so a fresh MCP process re-downloads the multi-megabyte archive on its first lookup. Supply
a `cache` to persist them across restarts:

```ts
import { FileCache, createDisclosuresTools } from "disclosures";

const tools = createDisclosuresTools({
  env: { OPENDART_API_KEY: process.env.OPENDART_API_KEY },
  cache: new FileCache("/var/cache/disclosures"), // survives restarts, 24h TTL
});
```

`cache` is any object implementing `DisclosuresCache` (`get`/`set`). The package ships
`InMemoryCache` (process-local, TTL-aware) and `FileCache` (one JSON file per key under a
directory); a corrupt, expired, or missing entry is always treated as a cache miss and
triggers a normal refetch, so a broken cache never breaks a lookup.

### ISIN ↔ LEI cross-walk

An ISIN identifies a security; a company can have many. GLEIF publishes the mapping in both
directions, and the package exposes it directly:

```ts
import { isIsin, resolveLeiByIsin, getIsinsForLei } from "disclosures";

isIsin("US0378331005"); // true — validates the ISIN check digit
const issuer = await resolveLeiByIsin("US0378331005"); // → issuer's GLEIF Entity (with .lei)
const isins = await getIsinsForLei("HWUPKR0MPOU8FGXBT394"); // → every ISIN mapped to that LEI
```

`CompanyResolve` accepts a bare ISIN and routes it through `resolveLeiByIsin`, so no code is
needed for the common case; the helpers are for building an identifier cross-walk yourself.

## Honesty and scope

- EDGAR and GLEIF are public disclosure/reference systems, **not KYC or UBO registries**.
- GLEIF Level 2 parents are accounting-consolidation relationships. They are not the same as market-disclosure ownership, voting control, or ultimate beneficial ownership.
- Schedule 13D/13G identifies filers under the relevant threshold regime (5% in the US). It is not a complete or continuously current capitalization table, and exact percentages may require reading the linked filing.
- Section 16 insiders reflect recent Forms 3/4/5 available for the issuer and may not be a complete current management roster.
- Absence of a Form D does not mean an issuer never raised private capital; it may have used another exemption or entity name.
- Filings can be amended, restated, late, incomplete, or reported under alternate XBRL tags. Results should be verified against the linked source documents.
- This package does not provide legal, investment, accounting, or financial advice.

## Development

Requires [Bun](https://bun.sh/) for development and Node 18+ for the published artifact.

```bash
bun install
bunx tsc --noEmit
bun test
bun run build
bun run test:stdio
npm pack --dry-run
```

Tests use routed fetch stubs and do not make live HTTP requests. The optional live smoke test requires a real SEC User-Agent:

```bash
DISCLOSURES_USER_AGENT="Your Organization your-email@example.com" \
  bun run smoke:live
```

For npm name reservation, trusted publishing, prerelease tests, and stable releases, see the [publishing guide](https://github.com/carrotly-ai/disclosures/blob/main/PUBLISHING.md).

### stdio rule

The server reserves stdout for newline-delimited JSON-RPC. Contributor diagnostics must go to stderr; `console.log` can corrupt the MCP transport.

## Roadmap

Non-US jurisdictions now ship behind the existing tools:

| Jurisdiction | Adapter | Status |
|---|---|---|
| United Kingdom | Companies House | Shipped |
| United Kingdom | FCA NSM (DTR5/TR-1 major holdings) | Shipped — inject-only, inside `CompanyOwners` |
| EU / UK | filings.xbrl.org (ESEF/UKSEF financials) | Shipped — normalized IFRS in `CompanyFinancials` |
| South Korea | DART / OpenDART | Shipped |
| Japan | EDINET | Shipped |
| China | cninfo (SSE/SZSE) | Shipped — resolution + filings |
| India | BSE (BSE-lite) | Shipped — resolution + filings |

ESEF/UKSEF coverage is FY2020+ and not exhaustive: alternative-market issuers (e.g. First North) are ESEF-exempt, and some national officially-appointed mechanisms (OAMs) hamper collection, so a miss never proves a company did not report. Only undimensioned reported totals are surfaced (no segment breakdowns), and a newer report's restated figure supersedes an earlier one.

Deeper normalized data for the remaining sources (GB/JP insider parsing, and CN/IN ownership and financials that currently live inside report PDFs) will dispatch behind the same seven intent tools rather than adding jurisdiction-specific tool names.

## License

Apache-2.0. Copyright Carrotly AI.
