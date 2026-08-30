# AU — Australia: ASX announcements + ASIC open data

**Data sources — two, with opposite licences:**

| Half | Source | Licence | Backs |
|---|---|---|---|
| **ASX** | [`asx.api.markitdigital.com`](https://www.asx.com.au/) — the exchange's own front-end JSON API (listed-company directory, per-company announcements, key statistics, announcement PDFs) | **ASX proprietary, © reserved — NOT open data.** See the section below. | `CompanyResolve` (listed), `CompanyFilings`, `CompanyDocument` |
| **ASIC** | [`data.gov.au`](https://data.gov.au/data/dataset/7b8656f9-606d-4337-af29-66b89b2eeefb) CKAN — the ASIC **Company Dataset** and **Banned and Disqualified Persons** register | **CC BY 3.0 AU** — freely redistributable with attribution | `CompanyResolve` (any Australian company), `PersonAppointments` (`disqualifications`) |

**Configuration:** ASIC requires no credential. ASX is keyless but disabled before network
access unless `DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1` is set after a rights review. Exact ACN
and ABN resolution remains ASIC-only even when ASX is acknowledged.

Implemented from the live-verified [`AU-FEASIBILITY.md`](../../AU-FEASIBILITY.md)
finding, with two material corrections to it recorded below. Endpoints re-verified
from this box on **2026-08-29**.

---

## ⚠️ ASX Terms of Use conflict — read this first

**The ASX half of this adapter is not open data, and its terms restrict what this
package may do.** ASX-backed routes are therefore disabled before the first request unless
the operator explicitly sets `DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1`. The restriction remains
visible in every enabled ASX-derived response.

The ASX Terms of Use ([`asx.com.au/legals/terms-of-use`](https://www.asx.com.au/legals/terms-of-use),
fetched live 2026-08-29) say, **verbatim**:

> **Ownership of content on the Site**
> "ASX and its licensors are the owners or licensees of all intellectual property
> rights in the Site and in the content published on it, unless indicated
> otherwise. The Site and the content published on the Site are protected by
> copyright, trade mark and other intellectual property laws and treaties around
> the world. **All such rights are reserved.**"

> **Permitted uses of the Site and content on the Site**
> "You may access the Site using your web browser and save an electronic copy, or
> print out a paper copy, of parts of the Site **for your own information purposes
> only**, including research, study or other **personal, non-commercial use**, but
> only if you keep all content intact and in the same form as presented on the
> Site…"

> **Prohibited uses**
> "You agree not to: **modify, copy, reproduce, republish, frame, download onto a
> computer, upload to a third party, post, transmit or distribute any content on
> the Site** in any way except as expressly provided for in these terms, on the
> Site or with ASX's prior written consent."

> "…**use any content on the Site for a commercial purpose** without the express
> written consent of ASX (where use of any content for a commercial purpose is any
> use other than accessing and using the content for your own personal and private
> decision making)…"

> "…**use any spider, screen scraper, robot, other similar software or device, or
> other similar process, to use or access the Site in any way whatsoever**,
> including monitoring, downloading or copying any content on the Site (except as
> otherwise permitted under these terms or with ASX's prior written consent)."

**The conflict, stated plainly.** An MCP server that fetches, reshapes, caches and
re-serves ASX announcement metadata and PDFs is doing exactly what the
"Prohibited uses" clause names — reproduce, download onto a computer, transmit,
distribute — and it does so programmatically, which the anti-automation clause
separately prohibits. Its purpose is not "personal and private decision making".
**This fails the "legally redistributable" bar that makes SEC EDGAR (public
domain) and the ASIC CC-BY datasets fine.** Nothing in the implementation
resolves that; the code is careful and honest, but careful and honest does not
make a licence permissive.

> The anti-scraping clause above is **not** in the merged feasibility finding —
> it was found when the terms were re-read for this build. It is the clause most
> directly on point for a tool like this one, so it is recorded here rather than
> left out.

**Consequences, and what this repository does about them:**

- **No acknowledgement, no ASX request.** Without
  `DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1`, `CompanyFilings` and `CompanyDocument` return an
  actionable error, while `CompanyResolve` queries only ASIC. Exact ACN/ABN inputs are
  ASIC-only regardless, because an ASX lookup is unnecessary.
- **The operator is responsible for having the rights to use ASX data for their
  purpose.** ASX grants written consent case by case; if you are running this
  commercially, or at all beyond personal use, that consent is yours to obtain.
  This package cannot grant it and does not imply it exists.
- **Every enabled ASX-derived response says so.** `CompanyResolve` (listed half),
  `CompanyFilings` and `CompanyDocument` each carry a source-and-terms note
  quoting the restriction and naming the operator's responsibility. The note is
  not a footnote in this file only — it ships in the tool output.
- **The ASIC half is explicitly distinguished.** ASIC's datasets on data.gov.au
  are **CC BY 3.0 AU**, freely redistributable with attribution to the Australian
  Securities and Investments Commission. Responses derived from them carry a
  CC-BY attribution note *instead of* the ASX terms note, and the two halves are
  rendered as **separate, separately-labelled tables** in `CompanyResolve` so a
  reader is never left guessing which licence a row falls under.
- **Nothing is mixed silently.** No AU response blends ASX and ASIC data into one
  table.

Without ASX acknowledgement, the AU route remains a fully usable open-data path:
`CompanyResolve` queries the ASIC Company Dataset (4.4 million Australian companies, listed
and unlisted), and `PersonAppointments` `disqualifications` queries ASIC's ban register. Both
are CC-BY and make no ASX request.

---

## ⚠️ The ASX announcements feed returns exactly 5 items — always

This is the second thing to know, and it shapes what `CompanyFilings` can honestly
be. **The per-company announcements feed is hard-capped at the five most recent
announcements, and no parameter changes that.** Verified live on BHP and CBA:

| Request | Items returned |
|---|---|
| `?count=5` | 5 |
| `?count=20` | 5 |
| `?count=50` | 5 |
| `?count=200` | 5 |
| `?pageSize=50&page=1` | 5 |
| `?timescale=100` | 5 |

Every variant returns the *same five rows*. The market-wide firehose
(`/markets/announcements?count=100`) does return 100+, but **cannot be filtered by
company** — a `securities=` parameter is ignored. Full per-company history sits
behind ASX login (`asx-research-auth`) and, for older material, ASX's **paid
Historical Announcements** product.

**So AU `CompanyFilings` is a "latest five" view, not a filing history, and it
says so every single time:**

- The response headline states it is showing the *N most recent* announcements and
  that this is **not** a complete filing history.
- The full cap note (`THESE ARE THE 5 MOST RECENT ANNOUNCEMENTS ONLY — NOT A
  COMPLETE FILING HISTORY…`) is attached to every filings response, **including
  empty ones** — an empty result must not read as "this company filed nothing".
- **A `limit` above 5 is explicitly refused, not silently truncated.** The
  response says `limit=<n> CANNOT BE HONOURED UPSTREAM` and explains that this is
  a hard upstream limit, not a truncation the tool chose.
- The note states that **absence from the list is not evidence** the company made
  no such announcement.
- `mode: "latest_annual"` / `"latest_quarterly"` are refused *with the cap as the
  reason* — an annual report is only reachable here if it happens to be one of the
  latest five.

## Correction to the finding: the ASIC bulk file is never downloaded

The merged finding recorded the ASIC Company Dataset as a **399 MB tab-delimited
CSV (78 MB ZIP)** and concluded that resolving one company meant downloading and
indexing the weekly bulk file — "the **largest** such download in the project".

**That turned out not to be necessary.** Both ASIC resources report
`datastore_active: true`, so CKAN's `datastore_search` action serves them as a
**real per-company query API**. Verified live:

```
GET /api/3/action/datastore_search?resource_id=<company>&q=ATLASSIAN&limit=3
  → 200, 3 records out of total 4,436,398

GET /api/3/action/datastore_search?resource_id=<company>&filters={"ACN":"004028077"}
  → 200, the BHP rows (current + superseded name), exact match

GET /api/3/action/datastore_search?resource_id=<banned>&q=SMITH&limit=2
  → 200, 2 records out of total 7,213
```

Three query shapes work: full-text `q`, exact `filters` on `ACN`/`ABN`, and
field-scoped `q` (`{"Company Name": "BHP GROUP LIMITED"}`).

**So the 399 MB file is never fetched.** One AU resolve is one or two small JSON
queries — no bulk download, no first-call latency cliff, no opt-in gate needed.
This is materially better than the AFM (NL) situation the task pointed at as the
model: there, the register genuinely has no server-side filter and a 108 MB CSV
must be pulled and reduced; here, the server does the filtering.

`AdapterOptions.cache` is still supported and still used, but for a different and
smaller job: the reduced query results (mapped entity rows, capped) and the ASX
listed directory are cached for **24 h** so repeat lookups in a session are free.
Only digests are cached — raw CKAN envelopes are never persisted.

**If data.gov.au ever retires the datastore for these resources,** the honest move
is to say the query API is gone — *not* to silently start pulling hundreds of
megabytes on a routine resolve. `parseAsicCompanyCsv` in the adapter maps the bulk
export's TAB-delimited rows (it is tab-separated despite the `.csv` name) to
exactly the same entity shape, and is unit-tested against a recorded sample, so
the equivalence is documented and a future contributor has a starting point — but
it is **not wired to the live path**.

## Accepted `company` inputs

- **An ASX listing code** — `BHP`, `CBA`, `CSL`, `RIO`. Case-insensitive. This is
  the id `CompanyFilings` takes.
- **A 9-digit ACN** — `004028077` or `004 028 077` (spaces and hyphens are
  stripped). Routed to an exact `filters` lookup.
- **An 11-digit ABN** — `49004028077`. Same exact-filter path.
- **A company name** — matched against the ASX directory *and* the ASIC register
  in parallel. The register uses full legal names (`BHP GROUP LIMITED`,
  `ATLASSIAN PTY LTD`).

Name ranking strips the trailing **legal form** before comparing
(`LIMITED`/`LTD`/`PTY LTD`/`NL`). This matters for honesty, not just recall:
without it, a query for an unrelated "… Pty Ltd" shares the token `LTD` with most
of the market, the zero-overlap guard never fires, and a random listed company
gets presented as a match. (Caught by a test, fixed.)

## Supported intents

| Intent | Behaviour | Licence of the data |
|---|---|---|
| `CompanyResolve` | **Two tables.** ASX-listed: code, name, industry, listing date, market cap, plus **ISIN** for the top match (from `key-statistics`) and a **GLEIF LEI** where a confident match exists. ASIC register: ACN, name, status, type/class, registration date, ABN, and the register's current-name cross-reference. | ASX restricted / ASIC CC-BY, labelled per table |
| `CompanyFilings` | The **5 most recent** ASX announcements only — released date, headline, announcement type, price-sensitive flag, size, and the `documentKey`. `forms`, `start_date`, `end_date` filter *within* those five. | ASX restricted |
| `CompanyDocument` | An announcement PDF by its `documentKey`: `metadata`, `xhtml` (text-layer extraction, paged, fenced as untrusted — the PDFs are encrypted with an empty user password and are decrypted to read, see below), `pdf` (download to disk, 25 MB cap). | ASX restricted |
| `PersonAppointments` (`disqualifications`) | ASIC's Banned and Disqualified Persons register: name, ban type, start/end date, locality, ASIC document number, comments. | **ASIC CC-BY** |
| `CompanyInsiders` | Unsupported — see below. | — |
| `CompanyOwners` | Unsupported — see below. | — |
| `CompanyFinancials` | Unsupported — see below. | — |
| `CompanyCharges` | Unsupported (GB-only tool) — see below. | — |
| `PrivateRaises` | Unsupported — no Form D analogue. | — |
| `PersonAppointments` (`search`, `appointments`) | Unsupported — see below. | — |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). | GLEIF CC0 |

## The endpoints

```
GET  https://asx.api.markitdigital.com/asx-research/1.0/companies/directory?itemsPerPage=2000
       → 200, the whole listed roster (1,840 companies, ~430 KB) — cached 24h
GET  https://asx.api.markitdigital.com/asx-research/1.0/companies/<code>/announcements?count=5
       → 200, EXACTLY 5 items (see the cap section)
GET  https://asx.api.markitdigital.com/asx-research/1.0/companies/<code>/key-statistics
       → 200, carries `isin`, shares on issue, an incomeStatement[] array
GET  https://asx.api.markitdigital.com/asx-research/1.0/file/<documentKey>?access_token=<token>
       → 200 application/pdf

GET  https://data.gov.au/data/api/3/action/datastore_search
       ?resource_id=5c3914e6-…&q=<name>|filters={"ACN":"…"}&limit=<n>   → 200 JSON (CC-BY)
GET  https://data.gov.au/data/api/3/action/datastore_search
       ?resource_id=741da9e3-…&q=<person name>&limit=<n>                → 200 JSON (CC-BY)
```

There is **no company-search endpoint** on the markitdigital API — every
`/companies/search`, `/companies/directory/search?query=…`, `?search=`, `?query=`
and `?searchTerm=` variant either 404s or returns the unfiltered first page. The
whole 1,840-row directory is therefore loaded once and matched client-side, which
is why it is cached for 24 h.

### The `access_token` is decoration, not authentication

The finding described the announcement PDF as reachable "via the front end's
embedded public `access_token`". Re-verified, the token turns out not to gate
anything: `/file/<documentKey>` serves the same PDF **with** the front-end token,
with an **arbitrary** token (`?access_token=deadbeef`), and with **no token at
all**. The adapter sends the front end's token anyway so requests look exactly
like the site's own — but no part of the route depends on it, and it is not a
credential this package is circumventing.

### Every ASX announcement PDF is encrypted (empty user password)

Verified on the live BHP dividend notice, a BHP Appendix 3Y, a CBA Form 603 and a
CBA press release: **all ASX announcement PDFs carry AES-256 standard security**
(`/R 5 /V 5 /P -540`) with an **empty user password**. That is owner-password
protection — any reader opens the file without prompting, and the "protection"
only restricts editing and printing.

This mattered, and it was caught by live verification rather than by the offline
tests. The shipped extractor was inflating ciphertext, recovering nothing, and
reporting *"no extractable text layer (likely scanned/image PDF)"* — a
**confidently wrong claim** about documents that are full of text (`pdftotext`
reads them fine). Reporting a locked document as a scan is exactly the failure
mode this library exists not to have.

`src/core/pdfText.ts` now derives the file key when a document declares standard
security and the empty user password validates, decrypts the object streams, and
records in its notes that it did so. A document whose empty password does **not**
validate is reported as **password-protected** — a distinct, honest outcome, no
longer conflated with "scanned". This is a general extractor improvement, not an
AU special case; unencrypted PDFs are unaffected.

### `HEAD` is not supported on the document route

`HEAD /file/<documentKey>` answers **404** while `GET` on the identical URL
answers 200 with the PDF. So `CompanyDocument` `mode: "metadata"` cannot use a
HEAD probe the way the AE/DFM path does — it performs a bounded `GET`, measures
the bytes, and says so in the response ("ASX's document route answers 404 to HEAD
while serving the PDF to GET, so size and type here are measured from a real
fetch rather than advertised headers"). The bytes are not retained.

## `transaction_id` scheme

**The announcement's own `documentKey`, exactly as `CompanyFilings` returned it:**

```
2924-03122554-3A699070
```

Chosen because it is the only id the ASX document route accepts, it fully
determines the PDF URL (so `CompanyDocument` needs no second lookup), and there is
no reverse lookup from anything else back to it. A full
`https://asx.api.markitdigital.com/asx-research/1.0/file/<key>` URL is also
accepted and normalised back to the canonical form.

**SSRF guard.** Because the id is only ever re-composed into a URL, the rebuilt
URL's host is validated to stay on `asx.api.markitdigital.com` or `asx.com.au`,
and the scheme must be `https`. Anything else is **refused before a socket is
opened** — verified by a test that asserts zero requests were made. A bare id that
is not shaped like a documentKey (`<digits>-<digits>-<alphanumeric>`) is likewise
rejected without a request.

## Not supported, and exactly why

- **`CompanyInsiders`** — Australian director-interest disclosure is the
  **Appendix 3Y "Change of Director's Interest Notice"**. It is real, it is in
  this feed (CSL's latest five were *all* Appendix 3Y notices when this was
  verified), but its content is a **PDF** — there is no structured
  insider-dealings register to normalize — and the feed is capped at five items,
  so even the PDFs are not enumerable beyond that. ASIC's directorship extracts
  are a **paid** registry product. `CompanyFilings` with
  `forms: ["Appendix 3Y"]` will surface one if it is among the latest five.
- **`CompanyOwners`** — substantial-holding disclosure is the Corporations Act
  **Form 603/604/605** notice (5% threshold), which reaches the market the same
  way: an ASX announcement whose content is a PDF, inside the five-item cap. CBA's
  latest five included a "Becoming a substantial holder" notice when verified.
  No keyless machine-readable holdings feed exists.
- **`CompanyFinancials`** — Australia has **no ESEF/inline-XBRL public filing
  regime**. The machine-readable channel (**SBR**, Standard Business Reporting) is
  business-to-government, not a public disclosure store, and annual reports are
  ASX-announced PDFs. The redistributable overlap is **SEC EDGAR**: dual-listed
  Australian issuers file **Form 20-F** (BHP and Rio Tinto both do), so the
  unsupported message points at `CompanyFinancials` with `jurisdiction: "US"`.
  Same pattern as DE and JP.
  *(The markitdigital `key-statistics` endpoint does carry an `incomeStatement[]`
  array with revenue and net income. It is deliberately **not** used for
  financials: it is vendor-derived ASX content under the restrictive terms above,
  it carries no basis/currency provenance beyond a bare `curCode`, and EDGAR
  20-F XBRL is a strictly better answer for the issuers most callers want. Only
  the `isin` field is read, as a resolution identifier.)*
- **`CompanyCharges`** — Australia's security-interest register is the **PPSR**
  (Personal Property Securities Register), which is **pay-per-search (~A$2)** with
  no free bulk download or open API. `CompanyCharges` remains a GB-only tool with
  no `jurisdiction` parameter.
- **`PrivateRaises`** — no Form D / Regulation D analogue published as open data.
- **`PersonAppointments` modes `search` and `appointments`** — Australia has **no
  free person→companies directorship index**. ASIC's current-and-historical
  directorship extract — the product that answers "which companies is this person
  a director of?" — is a **paid** registry product, and the CC-BY datasets on
  data.gov.au carry no officer records at all. Both modes return an honest
  unsupported explanation naming that reason and pointing at
  `mode: "disqualifications"`, which *is* answerable.

## Honesty notes specific to AU

- **The `disqualifications` result is a ban list, not a directorships index.** The
  response says so. ASIC records names as reported and states it cannot confirm
  whether similar entries are the same person, so the caveat tells the caller to
  match on name **and** context. An empty result explicitly says absence is not
  proof — legislation limits what ASIC may publish, and the register covers bans
  and disqualifications only, not every enforcement outcome.
- **An open-ended ban renders as "no end date recorded"**, not a blank cell.
- **ASIC's `"No comment made"` placeholder is dropped**, not shown as content.
- **Status codes are expanded, never guessed** — `REGD` → `Registered (REGD)`,
  `DRGD` → `Deregistered (DRGD)`; an unrecognised code passes through verbatim.
- **A superseded company name resolves.** The register keeps one row per name for
  an ACN with a `Current Name` cross-reference, so `BHP BILLITON LIMITED` resolves
  and shows `BHP GROUP LIMITED` as its current name.
- **GLEIF LEI enrichment is conservative** (the KAP/TR precedent): a hit is
  accepted only when GLEIF places the entity in **AU** *and* its legal-form-
  stripped name matches the exchange's. GLEIF's own results for "BHP GROUP
  LIMITED" include a **GB** "BHP Billiton Group Limited" and an **NZ** "BHP Trading
  Group Limited"; both are withheld. Withholding an identifier beats attaching a
  near-match.
- **One half failing never loses the other.** `CompanyResolve` queries ASX and
  ASIC in parallel and reports a per-source warning if one fails, keeping the
  other's results. Only when **both** fail does it return an error — never an
  empty result that would read as "this company does not exist".
- **An empty ASX directory is an upstream failure, not an empty market.**

## Change log

- **2026-08-29** — AU added. ASX (`CompanyResolve` listed half, `CompanyFilings`,
  `CompanyDocument`) and ASIC/data.gov.au (`CompanyResolve` register half,
  `PersonAppointments` `disqualifications`). Two corrections to the merged
  finding: the ASIC bulk 399 MB CSV is **not** needed (CKAN `datastore_search` is
  live on both resources, so per-company queries work), and the ASX `access_token`
  gates nothing. Live verification also found that every ASX announcement PDF is
  AES-256 encrypted with an empty user password, which the shipped extractor was
  misreporting as "no text layer" — fixed in `src/core/pdfText.ts` (a general
  improvement, not AU-specific). One addition to the recorded ToU analysis: the **anti-scraping
  clause**, which the finding did not quote. Built with the ASX terms conflict
  documented rather than resolved, per an explicit decision by the repository
  owner.
