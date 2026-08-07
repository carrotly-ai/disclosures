# DE — BaFin databases

**Data source:** the two public [BaFin](https://www.bafin.de/) disclosure databases —
[**AnteileInfo**](https://portal.mvp.bafin.de/database/AnteileInfo/) (voting-rights /
major-holdings notifications under §§ 33 ff. WpHG) and
[**DealingsInfo**](https://portal.mvp.bafin.de/database/DealingsInfo/) (managers'
transactions / directors' dealings under Art. 19 MAR).
**Credentials:** none.

## Accepted `company` inputs

- A company name (e.g. `SAP SE`) — searched against AnteileInfo, ranked client-side, and
  resolved to the issuer's **BaFin-Id**.
- A bare **BaFin-Id** (an 8-digit issuer key such as `40001244`) — used directly, no
  search request.
- An **ISIN** (e.g. `DE0007164600`) — passed to DealingsInfo for directors' dealings.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Searches AnteileInfo and returns the issuer's BaFin-Id, seat, and country. |
| `CompanyFilings` | Unsupported — BaFin publishes no consolidated filings index; German ESEF annual reports are reachable via `CompanyFinancials` with `jurisdiction: "EU"`. |
| `CompanyInsiders` | Managers' transactions (Art. 19 MAR) from DealingsInfo: notifying person, board role (Vorstand/Aufsichtsrat), instrument, transaction type, trade date, and publication date — newest first. |
| `CompanyOwners` | Major-holdings notifications (§§ 33 ff. WpHG) from AnteileInfo: holder, domicile, the §§ 33/34 voting-rights percentage, and the § 38 (instruments) / § 39 (aggregate) breakdown, with the § 40 publication date. |
| `CompanyFinancials` | Unsupported — use `jurisdiction: "EU"` (filings.xbrl.org ESEF) for German issuers' annual accounts. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `PersonAppointments` | Person-name search over the DealingsInfo notifying-persons index (managers'-transactions filers, Art. 19 MAR). `search` returns candidate persons with a BaFin `meldepflichtigerId`; `appointments` (pass the id as `officer_id`) lists every issuer that person has reported managers' transactions to, one row per issuer with a transaction count and latest trade date; `disqualifications` is honestly unsupported. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## `PersonAppointments` on DealingsInfo

BaFin exposes no public appointments register keyed by individual. The closest queryable
per-person dataset is the **DealingsInfo notifying-persons index** — the people who have
filed an Art. 19 MAR managers'-transaction notification. The adapter treats that index as a
person directory:

- **`mode: "search"`** (`query` = a surname, e.g. `Klein`) runs the DealingsInfo person
  search (`meldepflichtigerName`) and returns each match's surname, first name, title, board
  position, latest trade date, and BaFin **`meldepflichtigerId`** — the id to feed back in.
- **`mode: "appointments"`** (`officer_id` = a `meldepflichtigerId`) loads that person's
  DealingsInfo detail page and **collapses the transaction list to one row per issuer**:
  issuer name, BaFin-Id, ISIN, board position, number of reported transactions, and the
  latest trade date, newest issuer first.
- **`mode: "disqualifications"`** returns an honest not-available message — Germany publishes
  no free per-individual disqualified-directors register (a management-board ban under
  § 76 AktG / § 6 GmbHG follows automatically from a conviction and is not exposed as a
  searchable dataset), unlike the UK Companies House disqualified-directors register.

### `PersonAppointments` caveats

- This is a **managers'-transactions filer index, not an appointments register**. A board
  member who has never personally transacted will not appear, and the position shown is the
  role stated on the notification — not a live directorship record.
- German homonyms are common. Disambiguate a `search` result by **first name, title, and
  issuer**, not by the id alone, before using it with `mode: "appointments"`.
- "Issuers a person has reported transactions to" is an artefact of Art. 19 MAR filings; it
  is neither an exhaustive career history nor proof of a current directorship.

## Implementation notes

- Both databases are **UI-only HTML** (`displaytag` result tables); there is no JSON API.
  The adapter parses the tables with a nesting-aware, header-name-keyed parser, so columns
  are matched by label rather than position.
- BaFin serves **literal UTF-8**. When a page is mis-served as double-encoded Latin-1
  (`Jürgen` → `JÃ¼rgen`), a guarded repair pass restores it; the repair only fires when the
  tell-tale `Ã`/`Â` bytes are present, so correctly-encoded pages are never touched.
- German number and date formats are normalized: `5,0254` → `5.0254`, `12.06.2024` →
  `2024-06-12`.
- Percentages come straight from the AnteileInfo issuer table; the § 38 / § 39 columns are
  surfaced verbatim as a breakdown rather than being summed.

## Caveats

- **§§ 33 ff. WpHG is a threshold-notification regime, not a shareholder register.** A
  holder appears only when it crosses a 3/5/10/15/20/25/30/50/75 % threshold, and the
  figure is as-of the last notification — it is neither a live cap-table nor UBO tracing.
- **Art. 19 MAR covers persons discharging managerial responsibilities and their closely
  associated persons**, above the annual de-minimis threshold — it is not a complete
  register of all insider trades.
- Absence of a notification is not proof of absence of holding or dealing.
