# disclosures

Free, open-source corporate-disclosure research through official sources. `disclosures` is both a TypeScript library and a stdio [Model Context Protocol](https://modelcontextprotocol.io/) server.

Version 0.1 ships two adapters behind jurisdiction-agnostic tools:

- **US SEC EDGAR** — filings, annual/quarterly report metadata, Section 16 insiders, Schedule 13D/13G filers, annual XBRL financials, and Form D private raises.
- **GLEIF LEI** — entity resolution and reported direct/ultimate accounting-consolidation relationships.

The tool names and schemas are designed to stay stable as more jurisdiction adapters are added.

## Tools

| Tool | Returns |
|---|---|
| `CompanyResolve` | Canonical candidates and known CIK, ticker, LEI, and jurisdiction identifiers. |
| `CompanyFilings` | Filing dates, types, descriptions, and direct SEC links; a latest-report mode returns metadata and links to key sections, not the section text. |
| `CompanyInsiders` | Recent named directors, officers and titles, and 10% owners reported in Forms 3/4/5. |
| `CompanyOwners` | Schedule 13D/13G filers with form, date, links, and the US 5% threshold regime. |
| `CompanyFinancials` | Annual as-filed revenue, income, balance-sheet, EPS, cash-flow, and R&D facts by fiscal period end. |
| `OwnershipChain` | GLEIF direct and ultimate accounting-consolidating parents, reporting exceptions, and known direct children. |
| `PrivateRaises` | US Form D exempt offerings, amounts, investor counts, and named executives/directors/promoters. US-only in v1. |

All `company` inputs accept a name, ticker, CIK, or LEI. SEC-backed calls optionally accept `jurisdiction: "US"`; `OwnershipChain` is global.

## SEC User-Agent configuration

SEC EDGAR requires a descriptive User-Agent containing contact information. Set:

```bash
export DISCLOSURES_USER_AGENT="Your Organization your-email@example.com"
```

`SEC_EDGAR_USER_AGENT` is also accepted for compatibility. `DISCLOSURES_USER_AGENT` takes precedence. No API key is required.

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

Adapter functions accept `{ fetchFn?, env? }`, making them suitable for deterministic tests and embedding.

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

| Jurisdiction | Planned adapter |
|---|---|
| United Kingdom | Companies House |
| South Korea | OpenDART |
| Japan | EDINET |

New adapters will dispatch behind the existing intent tools rather than adding jurisdiction-specific tool names.

## License

Apache-2.0. Copyright Carrotly AI.
