# Testing discipline

Every test in this project runs **fully offline**. No test may reach a live service — the
suite is deterministic and safe to run in CI, on a plane, or against a rate-limited API.

## The fetch-stub contract

All adapters take an injectable `fetchFn` via `AdapterOptions`. Tests supply
[`routedFetch`](../tests/helpers/routedFetch.ts), a stub that:

1. **Records every request** (`fetchFn.requests`) so a test can assert exactly which URLs
   were called and with which headers.
2. **Matches by URL substring or `RegExp`** against a declared list of `Route`s, returning
   the route's canned `body` (JSON object, string, or `Uint8Array` for binary payloads).
3. **Throws on any unmatched request** — `Unexpected network request: <url>`. This is the
   core guarantee: a test that would otherwise hit the network fails loudly instead of
   silently reaching a live service.

```ts
const fetchFn = routedFetch([
  { pattern: "/officers", body: { items: [/* ... */] } },
]);
const officers = await getCompaniesHouseOfficers("01234567", { fetchFn, env });
expect(fetchFn.requests).toHaveLength(1);
```

Because an unmatched request throws, adding a new upstream call to an adapter forces the
test author to declare the route — coverage cannot silently regress into a live call.

## Fixtures: inline vs. recorded

- **Inline fixtures** (the default) live in the test file as literal `Route.body` values.
  Prefer these for small, readable payloads — they keep the input and the assertion side by
  side.
- **Recorded fixtures** live under [`tests/fixtures/<source>/`](../tests/fixtures/) and are
  loaded from disk via the [`loadFixture(source, name)`](../tests/helpers/loadFixture.ts)
  helper. Use these for large or verbatim upstream artefacts where fidelity to the real
  response matters more than inline readability — for example the FCA NSM TR-1 HTML
  artefact (`tests/fixtures/fca/tr1-rws.html`) the parser is exercised against, or the
  SEC Form D XML (`tests/fixtures/sec/form-d-stripe.xml`). Payloads that interpolate
  test constants (e.g. `${CORP_CODE}`) must stay inline — a recorded fixture is verbatim
  by definition.

When recording a new fixture, capture the **minimal** upstream response that reproduces the
behaviour under test, redact anything sensitive, and name it by source and scenario. Keep
computed, run-date-dependent values (e.g. "current fiscal year") derived in the test rather
than frozen into the fixture, so the suite stays robust across run dates.

## Live end-to-end tests

The live suite is deliberately separate from the offline suite:

```bash
bun run test:live       # build, then run every live case whose credential is present
bun run test:live:all   # require all four configured credentials; missing any is a failure
```

[`tests/live/e2e.live.ts`](../tests/live/e2e.live.ts) spawns the built Node bundle over
stdio, lists the registered MCP tools, then makes real calls through the same JSON-RPC
boundary a client uses. The package script explicitly loads `.env.local` when it exists
(`bun test` intentionally does not auto-load `.env.local` under `NODE_ENV=test`); CI can
supply the same variables directly. The suite currently covers:

- keyless GLEIF ownership-chain resolution;
- SEC latest-annual metadata chained into `CompanyDocument`;
- Companies House resolution and latest accounts chained into `CompanyDocument`, plus
  the live charges register;
- OpenDART resolution and a recent filing chained into `CompanyDocument`;
- a single bounded EDINET document-index day, avoiding a slow 90-day scan;
- keyless **EU** ESEF resolution (Nokia Oyj by LEI) and its latest annual report on
  filings.xbrl.org (structure, host, `structuredContent` transaction id);
- keyless **FR** issuer resolution (TotalEnergies → LEI), OAM filings by ISIN
  (info-financiere/opendatasoft host, `\d+_\d{8}` transaction id), and a `dirigeant`
  name search;
- keyless **HK** issuer resolution (Tencent by stock code), HKEXnews filings
  (`/listedco/…` transaction ids on hkexnews.hk), and `CompanyDocument` metadata
  (content-type/size) on the first returned filing;
- keyless **SG** UEN resolution through ACRA open data;
- keyless **TH** juristic-number resolution through the DBD register (PTT PCL — Thai
  text round-trip and the registered-capital line);
- keyless **TW** whole-market financials (TSMC) from TWSE open data — all five
  concepts, NT$ formatting, `structuredContent.concepts`;
- credentialed **JP** annual financials (Toyota) parsed from EDINET XBRL — JPY
  formatting and consolidated basis; and
- keyless **BR** (CVM), **DE** (BaFin), **CN** (cninfo) and **IN** (BSE India)
  resolution, each guarded by a tolerant skip (see below).

Assertions intentionally target stable invariants (issuer identity, identifier formats,
source hosts, headings, and response shape), never exact live counts, dates, or amounts.
Where a filings window can legitimately be empty on a quiet day the tool's drift-tolerant
"no results" notice is accepted in place of a populated table. Transient network, 429,
timeout, and 5xx failures are retried once. Per-call and per-test timeouts bound hangs, and
error diagnostics redact configured API keys. Missing credentials skip only their
jurisdiction in `test:live`; `test:live:all` is the strict pre-release mode.

**Tolerant jurisdictions (BR, DE, CN, IN).** These four keyless sources cannot be relied on
from an arbitrary datacenter host, so an upstream/runtime *transport* block is logged and
treated as a SKIP (never a failure) while a genuine assertion mismatch still fails:
cninfo (CN) and BSE India (IN, Akamai) are anti-bot walled and may answer 403/redirect/
timeout; and BaFin's portal (DE) emits an obsolete line-folded `Permissions-Policy` response
header that Node's undici HTTP/1.1 parser rejects (`Invalid header value char`), so the
built server's global `fetch` can never read it even though `curl` can — DE therefore skips
on this runtime today. The spawned server also runs with `--dns-result-order=ipv4first
--no-network-family-autoselection`, because some upstreams (notably Brazil's
dados.cvm.gov.br) publish AAAA records that are unroutable from hosts with broken IPv6 and
undici does not reliably fall back to IPv4.

The file uses the non-discoverable `.live.ts` suffix. Do not rename it to `.test.ts` or
`.spec.ts`: bare `bun test` discovers those names recursively and would violate the offline
contract. Neither normal CI nor the npm release workflow runs live tests. The separate
`Live E2E` GitHub Actions workflow is manual-only and requires the four repository secrets.

The older `bun run smoke:live` command remains as a small SEC/GLEIF diagnostic and now
builds first; use `test:live:all` for the full credentialed gate.

## Roadmap

The inline-fixture majority is deliberate and readable. The largest verbatim payloads have
been consolidated into per-adapter recorded-fixtures directories under
`tests/fixtures/<source>/`, loaded through `loadFixture(source, name)`. New large verbatim
artefacts should follow the same pattern; small or interpolated payloads stay inline. None
of this changes the offline guarantee, which holds for the entire suite.
