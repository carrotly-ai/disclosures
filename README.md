# disclosures

**Corporate-disclosure research for AI agents and TypeScript — filings, insiders, owners, financials, and ownership chains from 26 official sources across 21 jurisdiction routes (20 national routes plus the EU aggregate).**

[![npm version](https://img.shields.io/npm/v/disclosures?logo=npm&color=cb3837)](https://www.npmjs.com/package/disclosures)
[![CI](https://github.com/carrotly-ai/disclosures/actions/workflows/ci.yml/badge.svg)](https://github.com/carrotly-ai/disclosures/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/node/v/disclosures?logo=node.js&logoColor=white)](https://www.npmjs.com/package/disclosures)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](https://www.npmjs.com/package/disclosures?activeTab=dependencies)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.carrotly--ai%2Fdisclosures-6b46c1)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.carrotly-ai/disclosures)

`disclosures` is a free, open-source [Model Context Protocol](https://modelcontextprotocol.io/) server **and** a TypeScript library. It answers questions like *"who are NVIDIA's directors?"*, *"who owns 5% of Samsung Electronics?"*, or *"show me Vale's last three annual results"* — with every answer linked back to the official source document.

- **10 stable tools, 21 jurisdiction routes** — six core tools dispatch via `jurisdiction`; `OwnershipChain` is global; three specialized tools cover filed documents, secured charges, and person-level lookups. Tool names stay stable as coverage grows.
- **Official sources only** — SEC EDGAR, GLEIF, Companies House, FCA NSM, filings.xbrl.org, OpenDART, EDINET, cninfo, SZSE, BSE, TWSE, CVM, BaFin, info-financiere, recherche-entreprises, HKEXnews, ACRA, DBD, AFM, IDX, Bursa Malaysia, KAP, DFM, PSE EDGE, ASX, and ASIC.
- **Honest by design** — real source links only, explicit "unsupported here" answers instead of empty or fabricated results, and clear caveats ("absence of a filing is not proof").
- **Zero runtime dependencies** — one bundled file, runs anywhere Node 18+ runs.

## Quick start

Requires Node 18+. SEC-backed US calls require a descriptive User-Agent under EDGAR's [fair-access policy](https://www.sec.gov/os/accessing-edgar-data); keyless non-US routes can run without it.

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
| `CompanyResolve` | "Which company is this?" — canonical name plus global and local register identifiers. | All 21 routes |
| `CompanyFilings` | "What has it filed?" — dates, types, descriptions, identifiers, and official links. | US, GB, EU, KR, JP, CN, IN, TW, BR, FR, HK, ID, MY, AE, PH; AU latest-five partial |
| `CompanyInsiders` | "Who runs it or has reported dealings?" — route-specific officer, director, manager, or insider disclosures. | US, GB, KR, CN partial, TW, BR, DE, NL, MY, PH |
| `CompanyOwners` | "Who owns or controls it?" — major-holder, control-register, threshold-crossing, or custodian disclosures. | US, GB, KR, JP, CN partial, TW, BR, DE, FR partial, HK partial, NL, MY, PH |
| `CompanyFinancials` | "What are its numbers?" — as-filed headline facts from structured XBRL or bounded filing parsers. | US, GB, EU, KR, JP, CN partial, TW, BR, HK partial, ID, PH partial |
| `OwnershipChain` | "Who consolidates it?" — GLEIF direct/ultimate accounting-consolidation parents and children. | 🌐 Global (any LEI or legal name) |
| `PrivateRaises` | "Has it raised privately?" — Form D exempt offerings, amounts, investor counts, and named related persons. | US only |
| `CompanyDocument` | "What does the filing actually say?" — metadata, paged extracted text, or a bounded PDF saved to disk. | US, GB, JP, KR, FR, HK, CN, TR, AE, PH, AU |
| `CompanyCharges` | "What's secured against it?" — registered charges/mortgages and their particulars. | GB |
| `PersonAppointments` | "Where else does this person sit?" — person search, cross-company roles, and disqualification/enforcement lookups. | US, GB, DE, FR, AU partial (`disqualifications` only) |

Six core tools dispatch across all jurisdiction routes via `jurisdiction`; `OwnershipChain` is global and jurisdiction-independent. `CompanyDocument` accepts `US`, `GB` (default), `JP`, `KR`, `FR`, `HK`, `CN`, `TR`, `AE`, `PH`, and `AU`; `PersonAppointments` accepts `US`, `GB` (default), `DE`, `FR`, and `AU`; `CompanyCharges` is Companies House-specific and takes no `jurisdiction`.

Every `company` input accepts a **name or a local identifier** — ticker, CIK, LEI, or ISIN (US/global), Companies House number (GB — incl. `SC`/`NI` prefixes for Scotland and Northern Ireland), OpenDART corp/stock code (KR), EDINET/securities/corporate code (JP), A-share or HK code (CN), BSE scrip (IN), TWSE listing code (TW), CVM registration code (BR), BaFin-Id or ISIN (DE), SIREN/ISIN/LEI (FR), 4/5-digit HKEX stock code (HK), Singapore UEN (SG), 13-digit juristic-person registration number (TH), AFM-register issuer name or LEI (NL), 4-letter IDX ticker / kode emiten (ID), 4-digit Bursa stock code or issuer name (MY), BIST stock code (TR), DFM issuer symbol (AE), PSE ticker symbol or numeric PSE company id (PH). Pass `jurisdiction: "US" | "GB" | "EU" | "KR" | "JP" | "CN" | "IN" | "TW" | "BR" | "DE" | "FR" | "HK" | "SG" | "TH" | "NL" | "ID" | "MY" | "TR" | "AE" | "PH" | "AU"` (default `US`).

### Coverage matrix

| Intent | US | GB | EU | KR | JP | CN | IN | TW | BR | DE | FR | HK | SG | TH | NL | ID | MY | TR | AE | PH | AU |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `CompanyResolve` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `CompanyFilings` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | — | — | ✅ | ✅ | — | ✅ | ✅ | ⚠️ |
| `CompanyInsiders` | ✅ | ✅ | — | ✅ | — | ⚠️ | — | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| `CompanyOwners` | ✅ | ✅ | — | ✅ | ✅ | ⚠️ | — | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| `CompanyFinancials` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | — | ✅ | ✅ | — | — | ⚠️ | — | — | — | ✅ | — | — | — | ⚠️ | — |
| `PrivateRaises` | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `OwnershipChain` | 🌐 global via GLEIF — jurisdiction-independent |

✅ supported · ⚠️ partial (FR `CompanyOwners`: threshold-crossing notifications with a best-effort structured extraction — holder, direction, threshold(s) and resulting % parsed from the notification PDF's text layer for the newest few; scanned/non-standard PDFs and older notifications stay a link-only list · HK `CompanyOwners`: the keyless CCASS shareholding search returns participant/**custodian**-level holdings (custodian banks, brokers, HKSCC Nominees, CSDC) — **not** beneficial owners; the SFO Part XV Disclosure of Interests register is captcha-walled and linked for manual lookup · HK `CompanyFinancials`: headline figures extracted from the issuer's latest results-announcement PDF, latest announcement only — standard issuers extract cleanly, complex segment-split/multi-column statements parse partially, and a page shortfall or missing statement degrades to the PDF link · CN `CompanyFinancials`: headline figures extracted from the 主要会计数据 key-data table of the issuer's latest periodic-report PDF, normalized to whole RMB from the report's stated unit (元/千元/万元/百万元), latest report only — a mojibake (object-stream) report, an over-cap PDF, or a missing key-data table degrades to the PDF link · CN `CompanyOwners`: the 前十名股东 top-10 shareholders table parsed from the issuer's freshest periodic report — real major-shareholder data, but ragged and issuer-variable in column order, so a value-heuristic parser emits only confidently-matched rows; an as-published point-in-time snapshot, not a live register and not UBO tracing · CN `CompanyInsiders`: asymmetric by exchange — SZSE codes (0/3xxxxx) use SZSE's keyless structured 董监高 share-change feed, while SSE codes (6xxxxx) fall back to the as-published 董监高 board roster in the latest annual report, names and positions only) · **ID** is served over an **anti-bot-protected host** (`www.idx.co.id`): the adapter sends browser-class headers and works wherever those pass, and where the edge refuses it returns an explicit "the host blocked this request — inject a browser-backed `fetchFn`" note stating it is _not_ an empty result for the issuer, never a silent miss · **TR** `CompanyFilings` is a **deliberate dash**: KAP serves the BIST directory and every disclosure page/PDF keylessly, but its Next.js rebuild moved the data layer to `kapsitebackend.mkk.com.tr`, which does not resolve publicly — anything addressable **by disclosure id** works, while **enumeration** does not (the per-company notifications page returns `200` but server-renders an empty shell and fetches its rows from that unreachable host), so the tool explains why and points at the issuer's KAP page rather than faking a list · **PH** `CompanyFinancials` is **partial**: PSE EDGE serves the headline statement its own 17-A form carries (balance sheet + income statement, in PHP), not the full audited statements, which stay in the report's PDF attachments · — returns an honest unsupported-jurisdiction explanation, never an empty or fabricated result

**NL** `CompanyOwners`/`CompanyInsiders` are fully supported but read **whole-file AFM register exports** (no server-side filtering exists; the substantial-holdings export is ~108 MB): the first call in a session takes ~20–30 s, after which a cached 24 h per-issuer digest serves the rest in milliseconds. Supply an `AdapterOptions.cache` (e.g. `FileCache`) in per-request deployments.

> **⚠️ ASX and PSE EDGE are restricted sources and are disabled before network access by default.**
> Their terms limit use and redistribution in ways that may conflict with an automated disclosure service. Review [AU.md](docs/jurisdictions/AU.md) and [PH.md](docs/jurisdictions/PH.md), then set `DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1` and/or `DISCLOSURES_ACKNOWLEDGE_PSE_TERMS=1` only if you have the rights to use that source in your context. ASIC's CC-BY Australian company and disqualification registers remain available without ASX acknowledgement. Enabled responses retain the source-specific terms notice. Not legal advice.

Each jurisdiction has a full reference page — data source, credentials, accepted identifiers, per-intent behavior, and caveats — under [`docs/jurisdictions/`](docs/jurisdictions/README.md).

## Data sources and credentials

US and global lookups work with just the User-Agent. Non-US sources are keyless where the upstream allows it; the few that need keys are **free**. Provide only the keys for jurisdictions you query — everything else keeps working without them, and a missing credential produces a readable error naming the exact variable to set.

| Source | Jurisdiction | Key required | Notes |
|---|---|---|---|
| [SEC EDGAR](https://www.sec.gov/os/accessing-edgar-data) | `US` (default) | None — set `DISCLOSURES_USER_AGENT` | Filings, insiders, 13D/13G owners, XBRL financials, Form D. |
| [GLEIF](https://www.gleif.org/) | 🌐 global | None | LEI/ISIN resolution, ownership chain. |
| [Companies House](https://developer.company-information.service.gov.uk/) | `GB` | `COMPANIES_HOUSE_API_KEY` (free) | Resolution, filings, officers, PSC — incl. ECCTA identity-verification status. |
| [FCA NSM](https://data.fca.org.uk/) | `GB` | None — **inject-only** | DTR5/TR-1 ~3%+ major holdings inside `CompanyOwners`; activates only when you inject a `fetchFn` (no public read API). |
| [filings.xbrl.org](https://filings.xbrl.org/) | `GB`, `EU` | None | ESEF/UKSEF normalized annual IFRS financials (FY2020+). |
| [DART / OpenDART](https://opendart.fss.or.kr/) | `KR` | `OPENDART_API_KEY` (free) | Resolution, reports, executive ownership, 5% mass holdings, financials. |
| [EDINET](https://api.edinet-fsa.go.jp/) | `JP` | `EDINET_API_KEY` (free, search only) | Resolution is keyless; document search needs the key. |
| [cninfo](http://www.cninfo.com.cn/) | `CN` | None | SSE/SZSE (+ HKEX mirror) resolution, announcement PDFs, `CompanyDocument`, `CompanyFinancials` (主要会计数据 key-data table), `CompanyOwners` (前十名股东 top-10), and the SSE `CompanyInsiders` 董监高 roster — all PDF-derived modes bounded/best-effort. |
| [SZSE disclosure API](https://www.szse.cn/disclosure/supervision/change/index.html) | `CN` | None | Keyless structured 董监高及相关人员股份变动 feed backing `CompanyInsiders` for Shenzhen-listed issuers (0/3xxxxx). |
| [BSE India](https://www.bseindia.com/) | `IN` | None | Resolution and announcement PDFs; anti-bot host — inject a `fetchFn` if throttled. |
| [TWSE OpenAPI](https://openapi.twse.com.tw/) | `TW` | None | Resolution, material information, directors/supervisors, >10% shareholders. |
| [CVM open data](https://dados.cvm.gov.br/) | `BR` | None | Resolution, IPE disclosure index, DFP annual financials in BRL, FRE shareholder positions (item 15) and administrator register (item 12). |
| [BaFin](https://www.bafin.de/) AnteileInfo + DealingsInfo | `DE` | None | Resolution, §§33 ff. WpHG major holdings, Art. 19 MAR directors' dealings. |
| [info-financiere.gouv.fr](https://info-financiere.gouv.fr/) (OAM) | `FR` | None | Regulated-filing index with direct PDFs, threshold-crossing notifications, filed documents. |
| [recherche-entreprises](https://recherche-entreprises.api.gouv.fr/) | `FR` | None | Resolution (SIREN), officers (dirigeants), person→companies. |
| [HKEXnews](https://www.hkexnews.hk/) | `HK` | None | Resolution, title-search filings with keyless PDFs, `CompanyDocument` by `FILE_LINK` path, `CompanyFinancials` (headline figures from the latest results-announcement PDF — bounded). |
| [ACRA](https://data.gov.sg/) (data.gov.sg) | `SG` | None | Resolution only — UEN, status, incorporation date, former names, auditors (Singapore Open Data Licence). |
| [DBD](https://openapi.dbd.go.th/) (Thailand) | `TH` | None by juristic number; `DBD_API_KEY` (free) for name search | Resolution only — national register of listed **and** private companies: Thai + English legal name, juristic type, status, registered/paid-up capital, TSIC code, register date. |
| [ASX](https://www.asx.com.au/) company announcements | `AU` | `DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1` | Restricted source, disabled before network access by default. When acknowledged: listed-company resolution, the **5 most recent announcements only** (not a filing history), and announcement PDFs by `documentKey`. ASX's terms restrict use, redistribution, and automated access; the operator is responsible for having the necessary rights. Exact ACN/ABN resolution remains ASIC-only. See [AU.md](docs/jurisdictions/AU.md). |
| [ASIC on data.gov.au](https://data.gov.au/data/dataset/7b8656f9-606d-4337-af29-66b89b2eeefb) | `AU` | None | **CC BY 3.0 AU — freely redistributable with attribution.** The Company Dataset (4.4M listed *and* unlisted Australian companies by ACN/ABN/name) backs `CompanyResolve`; the Banned and Disqualified Persons register backs `PersonAppointments` `disqualifications`. Served over CKAN `datastore_search` as a real per-company query API, so the 399 MB bulk CSV is never downloaded. |
| [IDX](https://www.idx.co.id/) (Indonesia) | `ID` | None (host is anti-bot; inject a browser-backed `fetchFn` if blocked) | Resolution (all ~965 listed emiten — ticker, sector/subsector, board, listing date), disclosure announcements with attachment PDFs, and **financials parsed from real XBRL instances** (`instance.zip`, IDX 2020 `idx-cor` taxonomy) in IDR. Insiders/owners live in report PDFs and the KSEI depository channel — honest unsupported. Exchange ©: link-first, on-demand, no bulk redistribution. |
| [AFM](https://www.afm.nl/) disclosure registers | `NL` | None | Resolution, Wft ch. 5.3 substantial holdings, Art. 19 MAR managers' transactions + directors' holdings. Keyless whole-file exports with **no server-side filtering** — the holdings register is ~108 MB, so the first `CompanyOwners` call in a session takes ~20–30 s; supply `AdapterOptions.cache` (24 h digest). AFM asserts ©: link-first, on-demand, no bulk redistribution. |
| [Bursa Malaysia](https://www.bursamalaysia.com/) company announcements | `MY` | None (keyless) — but the host is Cloudflare-challenged, so inject a browser-backed `fetchFn` | Resolution, the announcements feed with the exchange's own category taxonomy, s.219 director-interest insiders and s.138 substantial-shareholder owners — both parsing the linked announcement document's dated transactions, share counts and resulting direct/indirect holding. A challenge returns an honest `AdapterOptions.fetchFn` message, never an empty result. SSM (the national registry) is paid. Exchange ©: link-first, on-demand. |
| [KAP](https://www.kap.org.tr/) (Kamuyu Aydınlatma Platformu) | `TR` | None | Resolution from the server-rendered BIST directory, and any disclosure by KAP id (metadata, PDF, extracted text). Per-company enumeration rides a non-public backend, so `CompanyFilings` is an honest dash. KAP/MKK ©: link-first, on-demand, no bulk redistribution. |
| [DFM](https://www.dfm.ae/) (Dubai Financial Market) | `AE` | None | **Dubai only, not the whole UAE** — ADX, DIFC and ADGM are bot-walled from a server. Resolution, the per-issuer efsah disclosure feed, and each disclosure PDF by its `r_path`. Exchange ©: link-first, on-demand. |
| [PSE EDGE](https://edge.pse.com.ph/) (Philippine Stock Exchange) | `PH` | `DISCLOSURES_ACKNOWLEDGE_PSE_TERMS=1` | Restricted source, disabled before network access by default. When acknowledged: resolution, filings, documents, form 13-1 insiders, POR-1 / 17-7 owners, and partial 17-A financials. PSE's terms restrict personal/commercial use and redistribution; the operator is responsible for having the necessary rights. See [PH.md](docs/jurisdictions/PH.md). |

```bash
# Required (SEC fair-access policy — your name/org and contact email)
export DISCLOSURES_USER_AGENT="Your Organization your-email@example.com"

# Optional, per jurisdiction
export COMPANIES_HOUSE_API_KEY="..."   # GB
export OPENDART_API_KEY="..."          # KR
export EDINET_API_KEY="..."            # JP document search
export DBD_API_KEY="..."               # TH company-name search (by-number is keyless)

# Restricted sources: set only after reviewing the source terms.
export DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1
export DISCLOSURES_ACKNOWLEDGE_PSE_TERMS=1
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

Handlers never throw — every failure comes back as a readable MCP-shaped result. Individual adapters are also exported as namespaces (`secEdgar`, `gleif`, `companiesHouse`, `openDart`, `edinet`, `cninfo`, `szse`, `bseIndia`, `fcaNsm`, `xbrlFilings`, `twseOpenApi`, `cvmOpenData`) if you want the raw normalized records instead of Markdown.

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
bun test              # full offline suite — no live HTTP
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

### Current gaps

Coverage grows additively behind the existing tool set. The clearest next deepening target is India: BSE filings already expose report PDFs, but `CompanyDocument` and confidently parsed ownership remain pending. Other intentional gaps are documented per jurisdiction rather than represented as empty data. Suggestions and issues are welcome on [GitHub](https://github.com/carrotly-ai/disclosures/issues).

## License

Apache-2.0. Copyright Carrotly AI.
