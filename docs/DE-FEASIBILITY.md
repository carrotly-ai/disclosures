# DE (Germany) adapter — open-data feasibility finding

> **Superseded (2026-08-07):** the DE adapter has since shipped. This page is retained as
> the original feasibility record; for current behaviour, accepted identifiers, and caveats
> see [`docs/jurisdictions/DE.md`](jurisdictions/DE.md).


**Question (roadmap task #37):** can a `DE` jurisdiction adapter surface German
major-holdings and directors'-dealings disclosures under the existing intent tools, using
only free, open data and **zero runtime dependencies**?

**Verdict: feasible and recommended** for `CompanyResolve`, `CompanyOwners`, and
`CompanyInsiders`. BaFin operates two public, keyless, GET-addressable databases whose
result pages are clean, well-structured HTML tables. The voting-rights data is in fact
*richer* than the JP EDINET equivalent shipped in #36, because it carries the actual
holding percentage. `CompanyFinancials` is **not** cleanly feasible on free open data and
should stay out of scope (see [Out of scope](#out-of-scope) below).

Assessed against live BaFin data on 2026-08-07; SAP SE (`BaFin-Id 40001244`,
`ISIN DE0007164600`) used as the verification issuer throughout.

## The two usable data sources

Both live under `https://portal.mvp.bafin.de/database/` — no API key, no login, no
per-request token. Each is a Java `displaytag` web app: search returns an HTML `<table>`,
and issuer/holder detail pages return further HTML tables.

### 1. AnteileInfo — significant voting rights (§§ 33/34/38/39 WpHG) → `CompanyOwners`

Directory: `.../database/AnteileInfo/`

- **Resolve issuer:** `GET suche.do?nameAktiengesellschaft=<name>&aktiengesellschaftSuche=true`
  returns a table of `BaFin-Id | Emittent | Sitz | Land`. For SAP this resolves to a single
  row, `40001244 · SAP SE · Walldorf · Deutschland`.
- **Current major holders:** `GET aktiengesellschaft.do?cmd=zeigeAktiengesellschaft&id=<BaFin-Id>`
  returns the full current-holdings table. Verified live columns:
  `BaFin-Id | Meldepflichtiger (holder) | Sitz/Ort | Land | §§33,34 WpHG % | §38 WpHG % | §39 WpHG % | Veröffentlichung §40 WpHG (date)`.

  Verified SAP holders (2026-08-07): BlackRock Inc. 6.74 %, Hasso Plattner Foundation
  6.6 %, Oliver Hopp 5.52 %, Daniel Hopp 5.06 %, Dietmar Hopp 5.04 %, Hasso Plattner
  6.6 %, SAP SE (treasury) 5.0254 %, Harald Tschira 4.22 %, Udo Tschira 4.19 %.
- **Per-holder history:** `geschaeft.do?cmd=zeigeGeschaeft&id=<n>` (crossing events over time).
- **Group / subsidiary attribution:** `konzern.do?cmd=zeigeKonzern&id=<n>`.

This maps directly onto `OwnerRecord`: `holderName` = Meldepflichtiger, `pct` = the § 39
(total) column, `percentageBand`/`change` from the per-holder history if needed,
`thresholdRegime = "DE WpHG §§ 33/38/39: 3/5/10/15/20/25/30/50/75%"`, `notifiedDate` from
the § 40 publication date. Unlike EDINET, **the percentage is present**, so DE
`CompanyOwners` rows can populate `pct` rather than only naming the holder.

### 2. DealingsInfo — directors' dealings (Art. 19 MAR) → `CompanyInsiders`

Directory: `.../database/DealingsInfo/`

- **Query by issuer name or ISIN:** `GET sucheForm.do?emittentName=<name>` (or
  `?emittentIsin=<ISIN>`), with an optional `zeitraum` date window
  (`zeitraumVon`/`zeitraumBis`, `dd.mm.yyyy`).
- **Result table** (verified live columns):
  `Emittent | Bafin-ID | ISIN | Meldepflichtiger (person) | Position/Status (Vorstand=management board / Aufsichtsrat=supervisory board) | Art des Instruments (Aktie/Derivat) | Art des Geschäfts (Kauf/Verkauf/Sonstiges) | Datum des Geschäfts | Ort des Geschäfts (venue) | Datum der Aktivierung`.
- **Per-transaction detail:** `ergebnisListe.do?cmd=loadMeldepflichtigeAction&emittentBafinId=<id>&meldungId=<id>`
  (volume and price live on the detail record).

This is a genuine Section 16-style feed — named directors/officers, their role, and the
buy/sell direction — so it fits `CompanyInsiders` (transaction-based) far better than it
fits any US insider-*roster* mental model. It also means **DE would be the first non-US
jurisdiction with real directors'-dealings coverage** for `CompanyInsiders`.

### 3. Issuer resolution → `CompanyResolve`

Either database resolves an issuer name (and, for DealingsInfo, an ISIN) to a BaFin-Id.
Cross-referencing the ISIN also lets DE records carry `isin` in `sourceIdentifiers`, and
GLEIF/`OwnershipChain` already works globally, so a DE entity resolves end-to-end.

## Intent coverage if built

| Intent | DE feasibility | Source |
|---|---|---|
| `CompanyResolve` | ✅ name/ISIN → BaFin-Id | AnteileInfo + DealingsInfo search |
| `CompanyFilings` | ⚠️ partial — no unified filing index; the two DBs are the disclosures | (see note) |
| `CompanyInsiders` | ✅ directors' dealings (Art. 19 MAR) | DealingsInfo |
| `CompanyOwners` | ✅ voting rights **with %** (§§ 33/38/39 WpHG) | AnteileInfo |
| `CompanyFinancials` | ❌ no free machine-readable source | — |
| `PrivateRaises` | ❌ no Form D analogue | — |
| `OwnershipChain` | ✅ already global via GLEIF | GLEIF |

## Constraints and risks (all surmountable, none blocking)

- **HTML scraping, not an API.** There is **no** official JSON/CSV/export endpoint on either
  BaFin portal — output is `<table class="displaytag">` HTML. This is consistent with what
  the library already does (SEC Atom, Companies House HTML fallbacks, EDINET Shift_JIS CSV
  in a ZIP), and needs only a small zero-dependency HTML-table extractor. **No new runtime
  dependency.**
- **Encoding.** Live responses show UTF-8 bytes mis-decoded as Latin-1 (`Geschäfts` →
  `GeschÃ¤fts`), i.e. the charset handling is fiddly. The adapter must pin the decode
  explicitly (check the `Content-Type` charset; treat body as UTF-8 with a Latin-1 fallback)
  and normalise umlauts before matching. Resolvable at implementation; flagged so it is not
  a surprise.
- **German column labels & `dd.mm.yyyy` dates.** Parsing keys off fixed German headers and
  German date/decimal formats (comma decimal separator: `5,0254` = 5.0254 %). Column order
  is stable in the `displaytag` markup but should be matched by header text, not position.
- **Pagination.** `displaytag` paginates via `d-NNNNNNN-p=<page>` query params; the scan
  must follow them. Result sets for a single issuer are small (SAP: 9 holders, ~20 recent
  dealings), so this is light.
- **Politeness.** The portal is rate-sensitive (community reports ~60 requests/hour). One
  issuer needs 1–2 requests for owners and 1 for dealings, so normal use is well within
  that; the adapter should still reuse the shared rate-limiter pattern and cache resolution.
- **Terms of use.** BaFin publishes these databases for public query; no API terms forbid
  automated reading, but the adapter should send a descriptive `User-Agent` (reuse
  `DISCLOSURES_USER_AGENT`) and stay polite, exactly as the SEC path does.

## Out of scope

- **`CompanyFinancials` (Bundesanzeiger / Unternehmensregister).** German annual financial
  statements are surfaced through the Unternehmensregister portal after DiRUG (2022), but
  there is **no free official machine-readable API** — data is portal HTML/PDF, "not machine
  readable by default," with a ~60 req/hr portal limit. The only JSON options are commercial
  keyed third parties (OpenRegister, handelsregister.ai), which conflict with the project's
  free-open-data and zero-runtime-dependency invariants. Leave DE `CompanyFinancials`
  unsupported (honest "unsupported-jurisdiction" explanation), same as JP.
- **`CompanyFilings`.** Germany has no single consolidated filing index comparable to SEC
  EDGAR; the two BaFin databases *are* the disclosure surface. A DE `CompanyFilings` could at
  most re-expose the same owners/dealings rows, which is redundant with the two intents
  above. Defer.

## Recommendation

Proceed with a `DE` adapter in a follow-up task, scoped to **`CompanyResolve` +
`CompanyOwners` + `CompanyInsiders`** behind the existing intent tools, reusing the shared
entity-resolution, rate-limiter, caching, and Markdown layers. Add a small zero-dependency
HTML-table parser (or extend the existing HTML helpers). Ship `CompanyFinancials`,
`CompanyFilings`, and `PrivateRaises` as honest unsupported-jurisdiction explanations. Fold
DE into the coverage matrix only when the adapter and its offline fixtures land — this
document records the finding, not shipped coverage.
