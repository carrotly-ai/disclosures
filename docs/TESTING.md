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

## Live smoke tests

`scripts/live-smoke.ts` (run via `bun run smoke:live`) exercises the real upstreams and is
**not** part of `bun test`. It requires real credentials (e.g. `DISCLOSURES_USER_AGENT`) and
is for manual pre-release verification only. CI never runs it.

## Roadmap

The inline-fixture majority is deliberate and readable. The largest verbatim payloads have
been consolidated into per-adapter recorded-fixtures directories under
`tests/fixtures/<source>/`, loaded through `loadFixture(source, name)`. New large verbatim
artefacts should follow the same pattern; small or interpolated payloads stay inline. None
of this changes the offline guarantee, which holds for the entire suite.
