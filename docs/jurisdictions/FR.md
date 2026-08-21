# FR — info-financiere OAM + recherche-entreprises

**Data sources:**
- [**info-financiere.gouv.fr**](https://info-financiere.gouv.fr/) — France's official OAM
  (*mécanisme officiel de stockage centralisé des informations réglementées*, ex-BDIF),
  operated by DILA and published as an [OpenDataSoft](https://www.opendatasoft.com/) portal.
  The keyless **Explore v2.1 JSON API** exposes the `flux-amf-new-prod` dataset (≈535k
  regulated-information filings, each with a direct PDF), licence
  [etalab-2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
- [**recherche-entreprises.api.gouv.fr**](https://recherche-entreprises.api.gouv.fr/) —
  DINUM's keyless national company + officer search over the merged RNE / Sirene / RCS data,
  licence Open Licence 2.0; documented ceiling **7 requests/second**.

**Credentials:** none (both keyless).

## Accepted `company` inputs

- A **company name** — listed issuers resolve via the OAM (`... like`), carrying ISIN + LEI;
  every other company resolves via recherche-entreprises to a **SIREN**.
- A **9-digit SIREN** (e.g. `542051180`) — resolved via recherche-entreprises.
- An **ISIN** (e.g. `FR0000120271`) or a **20-character LEI** (e.g. `529900S21EQ1BO4ESM68`)
  — matched on the OAM issuer-identity fields.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Merges the OAM (listed issuers, with ISIN + LEI) and recherche-entreprises (SIREN-keyed, non-listed). A name tries both (OAM first); an ISIN/LEI stays on the OAM; a bare SIREN uses recherche-entreprises. |
| `CompanyFilings` | The OAM `flux-amf-new-prod` regulated-information index: filed date, FR + EN subtype, title, and the direct PDF URL — newest first, with optional `forms`/date-window/`limit` filters. `mode: "latest_annual"`/`"latest_quarterly"` is unsupported (the flux is a flat index). |
| `CompanyInsiders` | Unsupported — managers' transactions (Art. 19 MAR) are **not** in the OAM flux; they live only on the AMF BDIF web UI, which exposes no free machine-readable feed. |
| `CompanyOwners` | **Partial.** Threshold-crossing notifications (*franchissement de seuil*, Art. L233-7 CoMoFi) from the OAM, newest first, each linked to its PDF — a **linked-notification list, not a structured cap table**: the crossing holder and the exact percentage live inside the PDF, not in any machine-readable field. |
| `CompanyFinancials` | Unsupported — use `jurisdiction: "EU"` (filings.xbrl.org ESEF) for a listed French issuer's annual accounts. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `CompanyDocument` | Given an OAM record id (the `transaction_id` from `CompanyFilings`, e.g. `169110_20260818`) — or a full OAM PDF URL — returns `metadata` (record fields + best-effort size via HEAD), `pdf` (saves the PDF to disk, 25 MB cap, path + bytes + page count), or `xhtml` (**best-effort text-layer extraction from the filed PDF**, fenced as untrusted and paged via `text_offset`; scanned/image PDFs and documents whose fonts lack a `/ToUnicode` map are reported honestly with no text). |
| `PersonAppointments` | recherche-entreprises *dirigeants*. `search` (a person name) returns distinct natural persons with a name-based id and a company count; `appointments` (pass the id as `officer_id`) lists every company where that person is a *dirigeant*; `disqualifications` is honestly unsupported. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## `CompanyDocument` transaction-id scheme

The FR `transaction_id` is the OAM record's **stable business id** `uin_idt_uin` (a
`<sequence>_<yyyymmdd>` string such as `169110_20260818`), which `CompanyFilings` returns as
each row's `transactionId`. `CompanyDocument` re-queries the dataset by that id
(`where=uin_idt_uin='…'`) to fetch the record's metadata and its `url_de_recuperation` PDF.
A full OAM PDF URL (restricted to the `*.opendatasoft.com` host) is also accepted, so a
caller who kept only a filing's `sourceUrl` can still fetch it. The full PDF URL is
deliberately **not** the canonical id — it is long, host-specific, and not a clean key.

## `PersonAppointments` on recherche-entreprises

The French registry keys people **by name, not by a stable person id**:

- **`mode: "search"`** (`query` = a person name) runs the `nom_personne` search and collapses
  the returned companies to one entry per distinct *(surname, first names)* natural person,
  with a company count, sample company, birth year, and a name-based **`officerId`**
  (a surname, or `"surname|first names"`). Corporate officers (*personnes morales*, e.g.
  auditors) are excluded.
- **`mode: "appointments"`** (`officer_id` = a name id) lists every company where that person
  is a current *dirigeant*: company name, SIREN, and role. When the id carries first names,
  the match is narrowed by them to separate homonyms.
- **`mode: "disqualifications"`** returns an honest not-available message — France publishes
  no free per-individual disqualified-directors register (a *faillite personnelle* /
  *interdiction de gérer* is ordered per court case, not exposed as a searchable dataset).

## Implementation notes

- **ODSQL injection safety.** The OAM `where` clause is built from single-quoted ODSQL
  string literals; user input is escaped by backslash-escaping any `\` first, then any `'`
  (verified live: doubling the quote is rejected with HTTP 400, backslash-escaping is
  accepted), so a company name containing `'`, `\`, or an `… or 1=1 --` fragment can never
  break out of the literal.
- **Zero runtime dependencies.** Records are fetched as JSON (no scraping); the document PDF
  path reuses the shared 25 MB cap, page-count, and save-to-disk machinery.
- **PDF text extraction is zero-dep and best-effort.** `mode: "xhtml"` runs the in-repo
  `src/core/pdfText.ts` extractor (object-level parse, `/FlateDecode` inflate via the shared
  `zip.ts` zlib wrapper, `Tj`/`TJ` operator text, WinAnsi + `/ToUnicode` CMap decoding — so
  French accents round-trip). It is a **text-layer extractor, not a renderer**: table/column
  layout is not preserved, and scanned PDFs or custom-encoded fonts with no `/ToUnicode` map
  are surfaced as an honest "no reliable text layer" note rather than garbage.
- recherche-entreprises calls go through a **7 req/s** rate limiter.

## Caveats

- **`CompanyOwners` is a partial capability.** *Franchissement de seuil* is a
  threshold-notification regime, and the OAM index carries only the notification metadata and
  its PDF — the holder identity and percentage are inside the document. Absence of a
  notification is not proof no notifiable holder exists.
- **No managers'-transaction feed.** Art. 19 MAR declarations are not in the OAM flux, so
  `CompanyInsiders` is honestly unsupported; use `PersonAppointments` for officers.
- **Homonyms are common.** recherche-entreprises matches people by name; disambiguate by
  first names, birth year, and company before trusting an `appointments` result.
- **Listed-issuer financials live on the EU route.** Use `jurisdiction: "EU"` (ESEF) rather
  than the OAM's PDF annual reports.
