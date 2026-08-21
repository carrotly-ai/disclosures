# disclosures

**Corporate-disclosure research for AI agents and TypeScript — filings, insiders, owners, financials, and ownership chains from 16 official sources across 13 jurisdictions.**

[![npm version](https://img.shields.io/npm/v/disclosures?logo=npm&color=cb3837)](https://www.npmjs.com/package/disclosures)
[![CI](https://github.com/carrotly-ai/disclosures/actions/workflows/ci.yml/badge.svg)](https://github.com/carrotly-ai/disclosures/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/node/v/disclosures?logo=node.js&logoColor=white)](https://www.npmjs.com/package/disclosures)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](https://www.npmjs.com/package/disclosures?activeTab=dependencies)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.carrotly--ai%2Fdisclosures-6b46c1)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.carrotly-ai/disclosures)

`disclosures` is a free, open-source [Model Context Protocol](https://modelcontextprotocol.io/) server **and** a TypeScript library. It answers questions like *"who are NVIDIA's directors?"*, *"who owns 5% of Samsung Electronics?"*, or *"show me Vale's last three annual results"* — with every answer linked back to the official source document.

- **10 stable tools, 13 jurisdictions** — seven intent tools each route across national sources via one `jurisdiction` parameter; three register tools add filed-document, secured-charge, and person-appointment lookups. Tool names and schemas never change as coverage grows.
- **Official sources only** — SEC EDGAR, GLEIF, UK Companies House, FCA NSM, filings.xbrl.org, Korea DART, Japan EDINET, China cninfo, India BSE, Taiwan TWSE, Brazil CVM, Germany BaFin, France info-financiere OAM + recherche-entreprises, Hong Kong HKEXnews, Singapore ACRA.
- **Honest by design** — real source links only, explicit "unsupported here" answers instead of empty or fabricated results, and clear caveats ("absence of a filing is not proof").
- **Zero runtime dependencies** — one bundled file, runs anywhere Node 18+ runs.

## Quick start

Requires Node 18+. The only required configuration is a descriptive User-Agent for SEC EDGAR (their [fair-access policy](https://www.sec.gov/os/accessing-edgar-data)) — set it to your name/org and contact email.

```bash
npx -y disclosures
```

### Claude Code

```bash
claude mcp add --transport stdio disclosures \
  --env DISCLOSURES_USER_AGENT="Your Organization your-email@example.com" \
  -- npx -y disclosures
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

### Cursor

Add the same `mcpServers` block as Claude Desktop to `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`).

### VS Code (Copilot / MCP)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "disclosures": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "disclosures"],
      "env": {
        "DISCLOSURES_USER_AGENT": "Your Organization your-email@example.com"
      }
    }
  }
}
```

<details>
<summary><b>Other clients</b> — Windsurf, Codex CLI, Gemini CLI, and any stdio MCP client</summary>

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`) uses the same `mcpServers` JSON as Claude Desktop.

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.disclosures]
command = "npx"
args = ["-y", "disclosures"]
env = { DISCLOSURES_USER_AGENT = "Your Organization your-email@example.com" }
```

**Gemini CLI** (`~/.gemini/settings.json`) uses the same `mcpServers` JSON as Claude Desktop.

**Any other client:** run `npx -y disclosures` as a stdio command with the `DISCLOSURES_USER_AGENT` environment variable set. The server speaks newline-delimited JSON-RPC on stdout. It is also listed on the [official MCP registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.carrotly-ai/disclosures) as `io.github.carrotly-ai/disclosures`.

</details>

### HTTP mode

The same server also speaks the MCP **streamable-HTTP** transport, for hosted or networked deployments. Pass `--http` (stdio remains the default with no flag):

```bash
disclosures --http --port 8080          # or: node dist/server.mjs --http
```

- Binds `127.0.0.1` by default; pass `--host 0.0.0.0` to expose it. Port comes from `--port`, else the `PORT` env var, else `8080`.
- MCP endpoint: `POST /mcp` (the transport also answers the streamable-HTTP `GET`/`DELETE` handshake). Runs **stateless** — no session id, a fresh server instance per request.
- Health check: `GET /healthz` → `200 {"name","version","tools"}`.
- Diagnostics go to stderr only, as in stdio mode.

Connect any streamable-HTTP MCP client at `http://127.0.0.1:8080/mcp`.

Restart the client after changing its configuration, then try:

> *"Use disclosures to list Apple's board of directors and their latest Form 4 activity."*
> *"Who holds 5% or more of NVIDIA? Link the filings."*
> *"Resolve Samsung Electronics in Korea and show its latest annual financials."*
> *"What's the GLEIF ownership chain above Apple Operations India?"*

## The ten tools

| Tool | What it answers | Coverage |
|---|---|---|
| `CompanyResolve` | "Which company is this?" — canonical name plus CIK, ticker, LEI, ISIN, SIREN, and local registry identifiers; GB adds previous names with date ranges and status/accounts detail. | US, GB, EU (ESEF filers), KR, JP, CN, IN, TW, BR, DE, FR + global LEI/ISIN |
| `CompanyFilings` | "What has it filed?" — dates, types, descriptions, direct source links; a latest annual/quarterly report mode, plus a GB insolvency-history mode. | US, GB, EU (ESEF/UKSEF annual reports), KR, JP, CN, IN, TW, BR, FR (info-financiere OAM) |
| `CompanyInsiders` | "Who runs it?" — directors, officers, titles, and 10%+ owners from insider registers. | US, GB (incl. ECCTA identity status), KR, TW, DE (MAR Art. 19) |
| `CompanyOwners` | "Who owns it?" — major-shareholder filers with thresholds, dates, and filing links. | US (13D/13G), GB (PSC + TR-1), KR (5% rule), JP (5% rule / 大量保有報告書), TW (>10%), DE (§§33 ff. WpHG), FR (franchissement de seuil — best-effort extraction from the newest notification PDFs, else link-only), HK (CCASS participant/custodian snapshot — partial; not beneficial owners) |
| `CompanyFinancials` | "What are its numbers?" — annual as-filed revenue, income, balance sheet, EPS, cash flow by fiscal period. | US (XBRL), GB/EU (ESEF/UKSEF IFRS), KR, JP (EDINET XBRL), TW (latest-period general-industry statements, NT$), BR, HK (headline figures extracted from the latest results-announcement PDF — bounded) |
| `OwnershipChain` | "Who consolidates it?" — GLEIF direct/ultimate accounting-consolidation parents and children. | 🌐 Global (any LEI or legal name) |
| `PrivateRaises` | "Has it raised privately?" — Form D exempt offerings, amounts, investor counts, named related persons. | US only in v1 |
| `CompanyDocument` | "What does the filing actually say?" — fetches a filed document's content: extracted iXBRL/HTML/DART-XML text or the source PDF saved to disk (image-only / pre-inline / XBRL-archive / PDF-only filings are reported honestly, never faked). | GB (Companies House), US (SEC EDGAR), JP (EDINET), KR (OpenDART), FR (info-financiere OAM) |
| `CompanyCharges` | "What's secured against it?" — registered charges/mortgages with status, dates, persons entitled, and fixed/floating/negative-pledge particulars. | GB (Companies House) |
| `PersonAppointments` | "Where else does this person sit?" — person search, cross-company role history, and disqualification / enforcement lookups (linked to the safe public register). | GB (Companies House), US (SEC EDGAR), DE (BaFin DealingsInfo), FR (recherche-entreprises dirigeants) |

The first seven tools dispatch across jurisdictions via `jurisdiction`. Of the last three, `CompanyDocument` accepts a `jurisdiction` of `GB` (default), `US`, `JP`, `KR`, `FR`, or `HK`; `PersonAppointments` accepts `US`, `GB` (default), `DE`, or `FR`; `CompanyCharges` is Companies House-specific and takes no `jurisdiction` — it always queries the UK register.

Every `company` input accepts a **name or a local identifier** — ticker, CIK, LEI, or ISIN (US/global), Companies House number (GB), OpenDART corp/stock code (KR), EDINET/securities/corporate code (JP), A-share or HK code (CN), BSE scrip (IN), TWSE listing code (TW), CVM registration code (BR), BaFin-Id or ISIN (DE), SIREN/ISIN/LEI (FR), 4/5-digit HKEX stock code (HK), Singapore UEN (SG). Pass `jurisdiction: "US" | "GB" | "EU" | "KR" | "JP" | "CN" | "IN" | "TW" | "BR" | "DE" | "FR" | "HK" | "SG"` (default `US`).

### Coverage matrix

| Intent | US | GB | EU | KR | JP | CN | IN | TW | BR | DE | FR | HK | SG |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `CompanyResolve` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `CompanyFilings` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| `CompanyInsiders` | ✅ | ✅ | — | ✅ | — | — | — | ✅ | — | ✅ | — | — | — |
| `CompanyOwners` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ | — | ✅ | ⚠️ | ⚠️ | — |
| `CompanyFinancials` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | — | — | ⚠️ | — |
| `PrivateRaises` | ✅ | — | — | — | — | — | — | — | — | — | — | — | — |
| `OwnershipChain` | 🌐 global via GLEIF — jurisdiction-independent |

✅ supported · ⚠️ partial (FR `CompanyOwners`: threshold-crossing notifications with a best-effort structured extraction — holder, direction, threshold(s) and resulting % parsed from the notification PDF's text layer for the newest few; scanned/non-standard PDFs and older notifications stay a link-only list · HK `CompanyOwners`: the keyless CCASS shareholding search returns participant/**custodian**-level holdings (custodian banks, brokers, HKSCC Nominees, CSDC) — **not** beneficial owners; the SFO Part XV Disclosure of Interests register is captcha-walled and linked for manual lookup · HK `CompanyFinancials`: headline figures extracted from the issuer's latest results-announcement PDF, latest announcement only — standard issuers extract cleanly, complex segment-split/multi-column statements parse partially, and a page shortfall or missing statement degrades to the PDF link) · — returns an honest unsupported-jurisdiction explanation, never an empty or fabricated result

Each jurisdiction has a full reference page — data source, credentials, accepted identifiers, per-intent behavior, and caveats — under [`docs/jurisdictions/`](docs/jurisdictions/README.md).

## Data sources and credentials

US and global lookups work with just the User-Agent. Non-US sources are keyless where the upstream allows it; the two that need keys are **free**. Provide only the keys for jurisdictions you query — everything else keeps working without them, and a missing credential produces a readable error naming the exact variable to set.

| Source | Jurisdiction | Key required | Notes |
|---|---|---|---|
| [SEC EDGAR](https://www.sec.gov/os/accessing-edgar-data) | `US` (default) | None — set `DISCLOSURES_USER_AGENT` | Filings, insiders, 13D/13G owners, XBRL financials, Form D. |
| [GLEIF](https://www.gleif.org/) | 🌐 global | None | LEI/ISIN resolution, ownership chain. |
| [Companies House](https://developer.company-information.service.gov.uk/) | `GB` | `COMPANIES_HOUSE_API_KEY` (free) | Resolution, filings, officers, PSC — incl. ECCTA identity-verification status. |
| [FCA NSM](https://data.fca.org.uk/) | `GB` | None — **inject-only** | DTR5/TR-1 ~3%+ major holdings inside `CompanyOwners`; activates only when you inject a `fetchFn` (no public read API). |
| [filings.xbrl.org](https://filings.xbrl.org/) | `GB`, `EU` | None | ESEF/UKSEF normalized annual IFRS financials (FY2020+). |
| [DART / OpenDART](https://opendart.fss.or.kr/) | `KR` | `OPENDART_API_KEY` (free) | Resolution, reports, executive ownership, 5% mass holdings, financials. |
| [EDINET](https://api.edinet-fsa.go.jp/) | `JP` | `EDINET_API_KEY` (free, search only) | Resolution is keyless; document search needs the key. |
| [cninfo](http://www.cninfo.com.cn/) | `CN` | None | SSE/SZSE (+ HKEX mirror) resolution and announcement PDFs. |
| [BSE India](https://www.bseindia.com/) | `IN` | None | Resolution and announcement PDFs; anti-bot host — inject a `fetchFn` if throttled. |
| [TWSE OpenAPI](https://openapi.twse.com.tw/) | `TW` | None | Resolution, material information, directors/supervisors, >10% shareholders. |
| [CVM open data](https://dados.cvm.gov.br/) | `BR` | None | Resolution, IPE disclosure index, DFP annual financials in BRL. |
| [BaFin](https://www.bafin.de/) AnteileInfo + DealingsInfo | `DE` | None | Resolution, §§33 ff. WpHG major holdings, Art. 19 MAR directors' dealings. |
| [info-financiere.gouv.fr](https://info-financiere.gouv.fr/) (OAM) | `FR` | None | Regulated-filing index with direct PDFs, threshold-crossing notifications, filed documents. |
| [recherche-entreprises](https://recherche-entreprises.api.gouv.fr/) | `FR` | None | Resolution (SIREN), officers (dirigeants), person→companies. |
| [HKEXnews](https://www.hkexnews.hk/) | `HK` | None | Resolution, title-search filings with keyless PDFs, `CompanyDocument` by `FILE_LINK` path, `CompanyFinancials` (headline figures from the latest results-announcement PDF — bounded). |
| [ACRA](https://data.gov.sg/) (data.gov.sg) | `SG` | None | Resolution only — UEN, status, incorporation date, former names, auditors (Singapore Open Data Licence). |

```bash
# Required (SEC fair-access policy — your name/org and contact email)
export DISCLOSURES_USER_AGENT="Your Organization your-email@example.com"

# Optional, per jurisdiction
export COMPANIES_HOUSE_API_KEY="..."   # GB
export OPENDART_API_KEY="..."          # KR
export EDINET_API_KEY="..."            # JP document search
```

`SEC_EDGAR_USER_AGENT` is accepted as a fallback for compatibility; `DISCLOSURES_USER_AGENT` wins.

## Use as a TypeScript library

The same package imports cleanly without starting stdio — every adapter takes injectable `{ fetchFn?, env?, cache? }`, so it embeds and tests deterministically.

```ts
import { createTools } from "disclosures";

const tools = createTools({
  env: { DISCLOSURES_USER_AGENT: "Your Organization your-email@example.com" },
});

const resolve = tools.find((tool) => tool.name === "CompanyResolve")!;
const result = await resolve.handler({ company: "NVDA" });
```

Handlers never throw — every failure comes back as a readable MCP-shaped result. Individual adapters are also exported as namespaces (`secEdgar`, `gleif`, `companiesHouse`, `openDart`, `edinet`, `cninfo`, `bseIndia`, `fcaNsm`, `xbrlFilings`, `twseOpenApi`, `cvmOpenData`) if you want the raw normalized records instead of Markdown.

<details>
<summary><b>Persistent caching</b> — skip re-downloading the KR/JP reference archives on restart</summary>

The OpenDART corp-code list (KR) and EDINET code list (JP) are multi-megabyte archives that regenerate about daily. Without a cache they are memoized per process; supply one to persist across restarts:

```ts
import { FileCache, createTools } from "disclosures";

const tools = createTools({
  env: { OPENDART_API_KEY: process.env.OPENDART_API_KEY },
  cache: new FileCache("/var/cache/disclosures"), // TTL-aware, survives restarts
});
```

`cache` is any `DisclosuresCache` (`get`/`set`). `InMemoryCache` and `FileCache` ship in the box; a corrupt, expired, or missing entry degrades to a normal refetch — a broken cache never breaks a lookup.

</details>

<details>
<summary><b>ISIN ↔ LEI cross-walk</b> — map securities to issuers and back via GLEIF</summary>

```ts
import { gleif } from "disclosures";

gleif.isIsin("US0378331005");                               // true — validates the check digit
const issuer = await gleif.resolveLeiByIsin("US0378331005"); // → issuer's GLEIF Entity (with .lei)
const isins = await gleif.getIsinsForLei("HWUPKR0MPOU8FGXBT394"); // → every ISIN for that LEI
```

`CompanyResolve` already accepts a bare ISIN and routes it through this cross-walk; the helpers are for building your own identifier maps.

</details>

<details>
<summary><b>MCP server factory</b> — embed the server in your own process</summary>

```ts
import { createDisclosuresServer } from "disclosures";

const server = createDisclosuresServer(); // McpServer with all ten tools registered
```

Importing the package never opens stdio; only the CLI entry point connects the transport.

</details>

## Built for AI clients

Responses are designed for the way an MCP client actually consumes them:

- **Markdown-first rendering.** Every result is one GitHub-flavored Markdown text block — headings, compact pipe tables (headers stated once, not repeated per row like JSON), real source links, and inline caveats. This is the token-efficient path for an LLM reader.
- **Structured output for chaining.** Data-bearing tools additionally return MCP `structuredContent` mirroring the Markdown facts, so a client chains calls without parsing prose: `CompanyResolve` ranked candidates with full identifier sets, `CompanyFilings` and register records with a ready-to-use `transactionId`, `PersonAppointments` people with their `officerId`, plus `CompanyInsiders`, `CompanyOwners`, `CompanyFinancials` (per-concept facts labelled by fiscal period end), `OwnershipChain`, `PrivateRaises`, and `CompanyCharges` — each tagged with its `sourceJurisdiction`. `OwnershipChain` also declares an MCP `outputSchema`; the multi-jurisdiction tools keep their honest-miss text-only paths and so emit structure additively without a declared schema.
- **Next-step trailers.** Chainable outputs end with a one-line `_Next: …_` hint naming the tool and parameter to call next.
- **Tool annotations.** All tools declare `openWorldHint` and `idempotentHint`; all but `CompanyDocument` (whose `pdf` mode writes a local file) declare `readOnlyHint`, so clients can parallelize and skip confirmation prompts.
- **Paged document text.** `CompanyDocument` mode `xhtml` reads in 50,000-character windows via `text_offset` — long filings are fully readable, not head-truncated.
- **Fenced untrusted content.** Extracted filer-authored text is wrapped between fixed `<<<BEGIN/END UNTRUSTED DOCUMENT TEXT>>>` sentinels (with lookalikes inside the document defanged), so clients can quarantine it programmatically.
- **Jurisdiction resources.** The server exposes `disclosures://jurisdictions` and `disclosures://jurisdictions/{code}` MCP resources describing each jurisdiction's source, credential, accepted identifiers, and caveats — check requirements without a failed tool call.

## Honesty and scope

These tools report **public disclosures**, faithfully — they are not KYC, UBO, or cap-table products:

- **Absence is not proof.** No Form D doesn't mean a company never raised privately; a missing PSC doesn't prove no controller exists; a blank ECCTA identity field doesn't prove an officer is unverified.
- GLEIF parents are **accounting-consolidation** relationships — not voting control, market-disclosure ownership, or ultimate beneficial ownership.
- Schedule 13D/13G identifies filers at the 5% threshold; it is not a complete or continuously current capitalization table.
- Section 16 insiders reflect recent Forms 3/4/5 and may not be a complete current roster.
- Filings can be amended, restated, late, or tagged under alternate XBRL concepts — verify against the linked source documents.
- Nothing here is legal, investment, accounting, or financial advice.

Resolution misses come back as plain "Could not find…" text; configuration, upstream, and rate-limit failures come back as flagged errors naming the fix. Every link is a real, resolvable source URL.

## Documentation

| Page | Contents |
|---|---|
| [`docs/jurisdictions/`](docs/jurisdictions/README.md) | Per-jurisdiction reference: sources, credentials, accepted identifiers, per-intent behavior, caveats, and the coverage matrix. |
| [`docs/TESTING.md`](docs/TESTING.md) | Offline test isolation plus the separate credential-aware live end-to-end suite. |
| [`PUBLISHING.md`](https://github.com/carrotly-ai/disclosures/blob/main/PUBLISHING.md) | npm trusted publishing and MCP-registry release automation. |
| [`CHANGELOG.md`](https://github.com/carrotly-ai/disclosures/blob/main/CHANGELOG.md) | Release history. |

## Development

Requires [Bun](https://bun.sh/) for development; the published artifact runs on Node 18+.

```bash
bun install
bunx tsc --noEmit     # strict typecheck
bun test              # 371 tests, fully offline — no live HTTP
bun run build         # bundles dist/server.mjs (zero runtime deps)
bun run test:stdio    # stdio integration against the built artifact
```

The default suite never touches the network: routed fetch stubs throw on any unmatched request. A separate live end-to-end suite builds the real Node artifact, drives it over MCP stdio, and uses whichever credentials are present in `.env.local`:

```bash
bun run test:live       # missing jurisdiction keys are reported as skips
bun run test:live:all   # strict: require User-Agent + GB/KR/JP keys
```

Live assertions are drift-tolerant (identity, identifier shape, source host, and response structure rather than volatile counts or dates), transient failures retry once, calls are time-bounded, and diagnostics redact configured keys. The live files use a `.live.ts` suffix so bare `bun test` cannot discover them. See the full [testing discipline](docs/TESTING.md). The smaller `bun run smoke:live` SEC/GLEIF diagnostic remains available for quick checks.

**stdio rule:** the server reserves stdout for JSON-RPC — contributor diagnostics must go to stderr, since `console.log` corrupts the MCP transport.

### Roadmap

Existing tool names and schemas stay stable — the collection only ever grows additively. The seven cross-jurisdiction intents absorb new sources and deeper data behind the same shapes; where a register offers primitives with no cross-jurisdiction equivalent (filed-document retrieval, secured-charge registers, person-level appointment history), a focused tool is added rather than contorting an intent. **GB (Companies House)** now goes deep: `CompanyDocument`, `CompanyCharges`, and `PersonAppointments` join `CompanyResolve` previous-name history and a `CompanyFilings` insolvency mode ([GB.md](docs/jurisdictions/GB.md)). **US (SEC EDGAR)** now answers `CompanyDocument` (filing document manifests + inline HTML/XBRL text) and `PersonAppointments` (reporting-owner CIK search, cross-issuer Section 16 role history, and a safe SALI enforcement-lookup link) alongside the seven core intents ([US.md](docs/jurisdictions/US.md)). **JP (EDINET)** and **KR (OpenDART)** now answer `CompanyDocument` too — JP downloads a filing's PDF (with page count) and lists its XBRL archive members by docID; KR lists a filing's DART documents and extracts the main document's text by receipt number ([JP.md](docs/jurisdictions/JP.md), [KR.md](docs/jurisdictions/KR.md)). **DE (Germany)** resolves issuers and returns §§33 ff. WpHG major holdings and Art. 19 MAR directors' dealings over BaFin's free databases, and now answers `PersonAppointments` too — a person-name search over the BaFin DealingsInfo notifying-persons index, then that person's issuers by BaFin `meldepflichtigerId` ([DE.md](docs/jurisdictions/DE.md)). **FR (France)** resolves listed issuers and lists their regulated filings with direct PDFs over the official OAM's keyless OpenDataSoft JSON API, fetches those documents (`CompanyDocument`), returns *franchissement de seuil* threshold-crossing notifications with a best-effort structured extraction from the newest notification PDFs' text layer — holder, crossing direction/date, threshold(s) crossed, and resulting capital/voting-rights % (`CompanyOwners`, partial — scanned/non-standard PDFs and older notifications stay link-only), and resolves non-listed companies and their officers over DINUM's keyless recherche-entreprises registry (`CompanyResolve`, `PersonAppointments`) — implemented from the live-verified [FR-FEASIBILITY.md](FR-FEASIBILITY.md) finding ([FR.md](docs/jurisdictions/FR.md)). Secured-charge registers remain a GB-only open-data primitive. Also ahead: CN/IN ownership and financials currently locked inside report PDFs. Suggestions and issues welcome on [GitHub](https://github.com/carrotly-ai/disclosures/issues).

## License

Apache-2.0. Copyright Carrotly AI.
