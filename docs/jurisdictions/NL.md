# NL — AFM disclosure registers

**Data source:** the Dutch [AFM](https://www.afm.nl/) (Autoriteit Financiële Markten)
statutory disclosure registers, read through their keyless whole-file exports at
`https://www.afm.nl/export.aspx?type=<GUID>&format=csv|xml`.
**Credentials:** none — no key, no login, no token.

Three registers back this jurisdiction:

| Register | Export GUID | Backs |
|---|---|---|
| [Substantial holdings](https://www.afm.nl/en/sector/registers/meldingenregisters/substantiele-deelnemingen) (*meldingen zeggenschap*, Wft ch. 5.3) | `1331d46f-3fb6-4a36-b903-9584972675af` | `CompanyOwners` |
| [Managers' transactions](https://www.afm.nl/nl-nl/sector/registers/meldingenregisters/transacties-leidinggevenden-mar19-) (Art. 19 MAR) | `0ee836dc-5520-459d-bcf4-a4a689de6614` | `CompanyInsiders` |
| [Directors'/commissioners' holdings](https://www.afm.nl/en/sector/registers/meldingenregisters/bestuurders-commissarissen) | `1b934036-12ad-4950-9773-31361d5adbd9` | `CompanyInsiders` |

All three also feed `CompanyResolve`, which derives the NL issuer universe from the names
the registers themselves carry.

## Accepted `company` inputs

- An **issuer name** as the AFM register spells it — `ASML Holding N.V.`,
  `Koninklijke Philips N.V.`, `Heineken N.V.`. Loose queries work (`ASML`, `Philips`);
  Dutch legal-form noise (`N.V.`, `B.V.`, `Koninklijke`, `Holding`) is folded during
  matching, and the response states which register issuer the query matched.
- A **20-character LEI** — matched against the LEI the Art. 19 MAR export carries.
- An **ISIN does not resolve.** None of these three registers carries an ISIN column (only
  the net-short register does), so an ISIN query honestly returns nothing rather than a
  guessed match.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Issuer candidates derived from the three registers' own issuer names, ranked exact → prefix → substring, annotated with which registers name the issuer. The LEI comes from the MAR export where present, otherwise from GLEIF (keyless, CC0) restricted to Dutch entities. |
| `CompanyOwners` | Wft ch. 5.3 substantial holdings: holder, capital-interest %, voting-rights %, notification date, share class, and a link to the notification's PDF annex where one exists. One row per holder (their latest notification), newest first. |
| `CompanyInsiders` | Art. 19 MAR managers' transactions (person, stated function, issuer LEI, transaction date) merged with directors'/commissioners' holdings notifications (before / change / after share counts and price), newest first. |
| `CompanyFilings` | Unsupported — see below. |
| `CompanyFinancials` | Unsupported — use `jurisdiction: "EU"` (filings.xbrl.org ESEF) for a Dutch issuer's annual accounts. |
| `CompanyDocument` | Unsupported — the exports carry no per-filing document id. Where a holdings notification has a PDF annex, `CompanyOwners` already returns its direct AFM link. |
| `PrivateRaises` / `CompanyCharges` / `PersonAppointments` | Unsupported — no Form D analogue; no free Dutch pledge/charge register; KVK (officers) is paid. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## The whole-file export problem (and how this adapter handles it)

**Verified live from this box on 2026-08-29:**

- The exports have **no server-side filtering**. Adding an `?issuer=` style parameter
  returns a **byte-identical** file — the parameter is silently ignored. There is no
  per-company query API and no smaller "recent" register variant; the AFM register page
  links only the same two whole-file exports (CSV and XML).
- **`Range` is not honoured.** A ranged request returns `HTTP 200` with the entire body.
- Measured sizes: substantial holdings **CSV 108,516,396 bytes / 293,488 rows**
  (~17 s transfer); the **XML variant of the same register is 377,404,561 bytes (~360 MiB)**, so CSV is
  deliberately preferred here even though XML is otherwise the safer parse. Managers'
  transactions XML ~4.8 MB / 9,364 records; directors' holdings XML ~8.9 MB / 6,334
  records.

So a per-issuer view can only come from fetching a register once and filtering
client-side. To keep that affordable the adapter **reduces each register to a compact
per-issuer digest at parse time and caches only the digest** — never the raw export:

- The holdings register is collapsed to **the latest notification per (issuer, holder)**,
  folding the two rows AFM writes per notification (one under `Kapitaalbelang`, one under
  `Stemrecht`) into a single record carrying both percentages. Measured: **293,484 data
  rows / 108 MB → 2,415 records / ~0.39 MB**, a ~275× reduction, across 133 distinct
  issuers.
- The digest is stored via `AdapterOptions.cache` with a **24 h TTL**, one key per
  register (`afm:register:<name>:v1`).

### First-call cost (honest)

| Call | Cold (no cache) | Warm |
|---|---|---|
| `CompanyOwners` (108 MB register) | **~20–30 s** | ~5–25 ms |
| `CompanyInsiders` (two XML registers, ~14 MB) | ~6 s | ~20–40 ms |
| `CompanyResolve` (all three) | ~25–30 s | <1 s |

Measured end-to-end through the built server: ASML `CompanyOwners` cold **28.8 s**, warm
**7 ms**. Like the BR/CVM adapter, **the first NL call in a session can be slow**; every
call after it is served from the digest.

**Supply a cache.** Without `AdapterOptions.cache` the adapter still memoizes per process,
but a deployment that spawns a process per request would re-download 108 MB every time.
Pass a `FileCache` (or any `DisclosuresCache`) so the digest survives restarts.
`CompanyInsiders` never touches the 108 MB holdings register — only `CompanyOwners` and
`CompanyResolve` do.

## Implementation notes

- **Encodings differ per format.** The substantial-holdings CSV is **Windows-1252** (its
  `Reëel` column mojibakes if read as UTF-8); the XML exports are UTF-8. Bytes are fetched
  raw and decoded per format.
- The CSV is `;`-delimited with `"`-quoted fields, parsed by an index scan rather than a
  regex — at 108 MB a backtracking pattern would dominate the parse.
- Each XML record **nests a second `<vermelding>` element** as a display label, so records
  are split with a depth-aware scan; a lazy regex would stop at the inner close tag and
  truncate every row.
- Dutch value formats are normalized: `2,55 %` → `2.55`, `2227413.00000` → `2227413`, and
  both date styles (`2026-08-27 00:00:00` in CSV, `8/27/2026 12:00:00 AM` in XML) → ISO
  `2026-08-27`.
- An **exact legal-name query wins outright** over normalized matching. Name folding drops
  `Holding`, so without that rule `Heineken Holding N.V.` would tie with `Heineken N.V.`
  and lose a tiebreak to the wrong issuer. `CompanyInsiders` also resolves the issuer
  **once against the union of both registers** rather than matching each separately, which
  would otherwise merge two different legal entities under one heading.

## Caveats

- **Wft ch. 5.3 is a threshold-notification regime, not a shareholder register.** A holder
  appears only when it crosses a 3/5/10/15/20/25/30/40/50/60/75/95 % threshold, and the
  figure is as-of that notification. A holder who has since crossed back below a threshold,
  or whose stake moved without crossing one, may not reflect the current position. It is
  neither a live cap-table nor UBO tracing.
- **The MAR export records that a notification was made** — person, function, issuer LEI,
  transaction date. **Direction and size are in the notification itself, not the export.**
  The directors'/commissioners' register is the one that carries before/change/after share
  and vote counts.
- Coverage is **AFM-supervised listed issuers**. A Dutch private company that has never
  been the subject of one of these notifications will not resolve — the **KVK
  Handelsregister API is paid** (`HTTP 401` without a purchased key) and is not used. Use
  `OwnershipChain` (GLEIF) for a keyless global fallback.
- Absence of a notification is not proof of absence of a holding or a dealing.

## Licence / copyright posture

The AFM asserts copyright over its site and registers (*"© Copyright AFM — alle rechten
voorbehouden"*). These are **statutory public registers** published under the AFM's public
task, and the exports are keyless, but **no open-data licence is attached**.

This adapter therefore takes the **same accepted posture as the shipped `cninfo`,
`bseIndia` and `twseOpenApi` adapters**: the register is used as an **internal lookup**,
fetched **on demand**, results are **link-first** (every row cites an official AFM URL) and
the **AFM is named as the source** in every rendered response. The bulk export is **not
redistributed** and no claim is made over it — only the reduced digest is held, in the
caller's own cache, for 24 h.

## ESAP (2027+)

The EU **European Single Access Point** phases in from 2027 — first data categories in
mid-2027, with the shareholder / short-selling / MAR categories in the later 2028–2030
waves — and will eventually aggregate exactly these AFM registers into one EU-level API.
Building on AFM now still buys a multi-year useful window and AFM remains the authoritative
national source, but expect ESAP to **overlap and eventually supersede** this NL-native
path, in the same way ESEF financials already live under `jurisdiction: "EU"`.
