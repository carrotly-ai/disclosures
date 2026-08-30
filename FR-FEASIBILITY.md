# FR (France) adapter — open-data feasibility finding

> **Historical research record.** FR resolution, filings, documents, person appointments, and bounded owner extraction subsequently shipped. See [`docs/jurisdictions/FR.md`](docs/jurisdictions/FR.md) and the changelog.

> **Status:** finding only — no adapter or tool change ships with this document. Records
> the research for a future `FR` jurisdiction adapter behind the existing intent tools,
> using only free, keyless-or-free-key, redistributable data and **zero runtime
> dependencies**.

**Question:** can an `FR` jurisdiction adapter surface French regulated-information
filings, major-holding notifications, officer/appointment data, and filed-document content
under the existing intent tools, on free open data only?

**Verdict: feasible and recommended** for `CompanyResolve`, `CompanyFilings`,
`CompanyDocument`, and `PersonAppointments`, and **partial** for `CompanyOwners`. Two
clean, keyless, JSON-API sources carry the load: **info-financiere.gouv.fr** (France's
official OAM — the central store of regulated information, successor to the AMF/BDIF
database, run by DILA) exposes a full **OpenDataSoft Explore v2 JSON API** over 535,285
regulated-filing records with direct PDF URLs; and **recherche-entreprises.api.gouv.fr**
(DINUM) is a keyless company + officer registry search. `CompanyInsiders` (managers'
transactions / Art. 19 MAR), `CompanyFinancials`, `PrivateRaises`, and `CompanyCharges`
are **not** cleanly feasible on free structured data and should stay out of scope with
honest unsupported explanations (details below).

Assessed against **live** endpoints on **2026-08-20**. Verification issuers:
**TOTALENERGIES SE** (`ISIN FR0000120271`, `LEI 529900S21EQ1BO4ESM68`, `SIREN 542051180`),
DBV Technologies (`FR0010417345`), plus BODACC / recherche-entreprises for the registry
paths. Every endpoint, parameter, and response fragment below was fetched from this box
unless explicitly marked unreachable.

---

## Per-intent verdict

| Intent | FR feasibility | Primary source |
|---|---|---|
| `CompanyResolve` | ✅ feasible | recherche-entreprises (name→SIREN) + info-financiere (name/ISIN/LEI, listed) + GLEIF |
| `CompanyFilings` | ✅ feasible — **standout** | info-financiere `flux-amf-new-prod` (ODS Explore v2 JSON) |
| `CompanyInsiders` | ❌ not feasible | managers' transactions live only on the AMF BDIF web UI (HTML-only, unreachable from here); not in the OAM flux |
| `CompanyOwners` | ⚠️ partial | info-financiere threshold-crossing notifications — **filing list only; holder + % are inside the PDF** |
| `CompanyFinancials` | ❌ not feasible (FR-specific) | listed FR issuers already covered via `jurisdiction: "EU"` (ESEF); non-listed accounts need token-gated INPI |
| `PrivateRaises` | ❌ not feasible | no Form D analogue |
| `CompanyDocument` | ✅ feasible — **standout** | info-financiere direct PDF URLs (verified `200 application/pdf`) |
| `CompanyCharges` | ❌ not feasible | no free national charges/nantissements register (greffes/Infogreffe are paid) |
| `PersonAppointments` | ✅ feasible | recherche-entreprises officer (`dirigeants`) + person-name search over RNE/RCS |
| `OwnershipChain` | ✅ already global via GLEIF | GLEIF (FR verified) |

✅ supported · ⚠️ partial · ❌ honest unsupported-jurisdiction explanation

---

## Source 1 — info-financiere.gouv.fr (the OAM / ex-BDIF) → `CompanyFilings`, `CompanyDocument`, `CompanyResolve`, partial `CompanyOwners`

France's **official centralised store of regulated information** ("le mécanisme officiel
français de stockage centralisé des informations réglementées" — the Transparency-Directive
OAM), operated by **DILA**. `info-financiere.fr` `301`-redirects to `info-financiere.gouv.fr`.
The site is an **OpenDataSoft** portal, so it ships the standard **Explore v2 JSON API** —
no key, no login, no token.

- **Base:** `https://info-financiere.gouv.fr/api/explore/v2.1/`
- **Licence:** **etalab-2.0** (Licence Ouverte 2.0) — confirmed on the portal
  ("tous les contenus de ce site sont sous licence etalab-2.0"). Redistributable with
  attribution.
- **Auth:** none. **Rate limit:** standard ODS anonymous quotas; be polite and cache.

### The dataset: `flux-amf-new-prod` — 535,285 regulated filings

`GET /api/explore/v2.1/catalog/datasets/flux-amf-new-prod` reports `records_count 535285`.
Verified fields (subset) include the issuer identity and, crucially, a **direct retrieval
URL** per filing:

```
identificationsociete_iso_nom_soc   # issuer legal name
identificationsociete_iso_cd_isi    # ISIN
identificationsociete_iso_cd_lei    # LEI
informationdeposee_inf_dat_emt      # transmission datetime
informationdeposee_inf_tit_inf      # document title
type_d_information / sous_type_d_information       # FR type + subtype
type_of_information / subtype_of_information       # EN type + subtype
url_de_recuperation                 # direct PDF URL (opendatasoft FTP)
fichierdecontenu_inf_fic_nom        # PDF path/filename
```

**Records query (verified, TotalEnergies, newest first):**

```
GET /api/explore/v2.1/catalog/datasets/flux-amf-new-prod/records
    ?where=identificationsociete_iso_nom_soc like "TotalEnergies"
    &order_by=informationdeposee_inf_dat_emt desc&limit=2
```

Real response (truncated) → `total_count: 1746`:

```json
{
  "identificationsociete_iso_nom_soc": "TOTALENERGIES SE",
  "identificationsociete_iso_cd_isi": "FR0000120271",
  "identificationsociete_iso_cd_lei": "529900S21EQ1BO4ESM68",
  "informationdeposee_inf_dat_emt": "2026-08-18T06:00:00+00:00",
  "informationdeposee_inf_tit_inf": "Acquisition ou cession des actions de l'émetteur / Transactions sur actions propres (version agrégée)",
  "sous_type_d_information": "Acquisition ou cession des actions de l'émetteur",
  "url_de_recuperation": "https://fr.ftp.opendatasoft.com/datadila/INFOFI/BWR/2026/08/FCBWR169110_20260818.pdf"
}
```

### `CompanyFilings` → ✅ feasible (standout)

This is a genuine per-issuer filing index — the closest FR analogue to SEC EDGAR's
submissions feed — reachable as **JSON, not HTML scraping**. Resolve by name/ISIN/LEI,
then list filings with title, FR+EN type/subtype, date, and document URL. Facet on
`sous_type_d_information` (verified live) enumerates the disclosure taxonomy, e.g.:

```
204872  Informations privilégiées               (inside/privileged information PRs)
 65762  Total du nombre de droits de vote et du capital
 36050  Acquisition ou cession des actions de l'émetteur (buybacks)
 19762  Rapports financiers et d'audit semestriels
 19143  Rapports financiers et d'audit annuels
  9368  Décision de franchissement de seuil      (threshold crossings → owners)
```

Maps directly onto `FilingRecord`: `title` = `informationdeposee_inf_tit_inf`,
`filedDate` = `informationdeposee_inf_dat_emt`, `category` = subtype, `url` =
`url_de_recuperation`, and `sourceIdentifiers` can carry ISIN + LEI.

### `CompanyDocument` → ✅ feasible (standout)

Every filing's `url_de_recuperation` is a direct, keyless PDF. **Verified live:**

```
GET https://fr.ftp.opendatasoft.com/datadila/INFOFI/BWR/2026/08/FCBWR169110_20260818.pdf
→ 200  content-type: application/pdf  size: 240709 bytes
```

Mirrors the shipped US EDGAR `CompanyDocument` pattern (chain the document URL off the
filing the index already returned; reuse the 25 MB cap + save-to-disk machinery). PDFs are
scanned/text PDFs — a `metadata`/save-to-disk mode is trivial; a `text` mode needs PDF text
extraction (out of scope for a zero-dep v1, same honest limitation as GB image-only
accounts).

### `CompanyResolve` → ✅ feasible

`flux-amf-new-prod` resolves a listed issuer by name (`... like "…"`), ISIN
(`identificationsociete_iso_cd_isi`), or LEI, returning all three identifiers — so an FR
listed entity resolves end-to-end and carries `isin`/`lei` in `sourceIdentifiers`. Helper
datasets on the same portal (`codes-lei`, `liste-code-isi`, `societes-cac40`) can seed a
name↔ISIN↔LEI cache. For **non-listed** companies, resolution comes from Source 2.

### `CompanyOwners` → ⚠️ partial (filing list only, no structured %)

The subtype **"Décision de franchissement de seuil"** (9,368 records) is France's
major-holding / threshold-crossing regime (franchissement de seuil, Art. L233-7 CoMoFi),
and **"Total du nombre de droits de vote et du capital"** (65,762) is the denominator
disclosure. **Verified** record:

```json
{
  "identificationsociete_iso_nom_soc": "DBV TECHNOLOGIES",
  "identificationsociete_iso_cd_isi": "FR0010417345",
  "informationdeposee_inf_tit_inf": "Franchissements de seuils et déclaration d'intention",
  "sous_type_d_information": "Décision de franchissement de seuil",
  "url_de_recuperation": ".../datadila/INFOFI/307/8888/01/FC307642623_20260817.pdf"
}
```

**The honest limitation:** unlike Germany's BaFin AnteileInfo (which serves the holder name
and the §§33/38/39 percentages as **structured table cells**), info-financiere gives only
the *notification as a PDF* — the crossing holder and the percentage live **inside the PDF
text**, not in any JSON field. So an FR `CompanyOwners` can honestly return *"here are the
threshold-crossing notifications for this issuer, newest first, each linked to its filing"*
but cannot populate `pct`/`holderName` without PDF parsing. Ship it as a linked
notification list with an explicit caveat, **or** defer it. Do **not** claim a structured
cap table.

---

## Source 2 — recherche-entreprises.api.gouv.fr (DINUM) → `CompanyResolve`, `PersonAppointments`

Keyless national company search over the merged **RNE / Sirene / RCS** data (DINUM /
annuaire-entreprises).

- **Base:** `https://recherche-entreprises.api.gouv.fr/`
- **Licence:** Open Licence 2.0 (Etalab). **Auth:** none. **Rate limit:** documented
  **7 calls/second** (administration may lower under load).

### `CompanyResolve` (non-listed + listed) → ✅

```
GET /search?q=TotalEnergies&per_page=1  → total_results 632
```

Real result (truncated): `nom_complet: "TOTALENERGIES MARKETING FRANCE"`, `siren:
"531680445"`, full `siege` address + NAF, and a populated `dirigeants` array. This gives FR
a **SIREN**-keyed resolver for the ~millions of companies with no ISIN/LEI.

### `PersonAppointments` → ✅ feasible

Two verified capabilities:

1. **Officers per company** — each `/search` result carries a `dirigeants[]` array of named
   officers with role and birth year, plus corporate auditors, e.g. (verified):

   ```json
   "dirigeants": [
     {"nom": "LARROQUE", "prenoms": "GUILLAUME", "annee_de_naissance": "1971",
      "qualite": "Président de SAS", "type_dirigeant": "personne physique"},
     {"nom": "LEBLOND", "prenoms": "NICOLAS JULIEN", "qualite": "Directeur général délégué"},
     {"denomination": "ERNST & YOUNG AUDIT", "qualite": "Commissaire aux comptes titulaire",
      "type_dirigeant": "personne morale"}
   ]
   ```

2. **Person → companies (cross-company appointments)** — a person-name filter returns every
   company where that individual is a `dirigeant`:

   ```
   GET /search?nom_personne=Pouyanne&per_page=2  → total_results 189
   ```

   This is the direct analogue of the GB `PersonAppointments` `appointments` mode and is
   **stronger than the DE dealings-filer proxy** (it's the actual registry appointment, not
   a managers'-transaction artefact). Supports `nom_personne`, `prenoms_personne`, and
   birth-date narrowing for disambiguation. Same honesty caveats as GB/US: French homonyms
   are common — disambiguate by first name + birth year + company, never by name alone.

   `disqualifications`: no free per-individual disqualified-directors register exists (same
   as DE); return an honest not-available message.

---

## Source 3 — BODACC (DILA, via bodacc-datadila.opendatasoft.com) → supporting only

Official gazette of commercial announcements. ODS Explore v2 JSON, etalab-2.0, keyless.
Dataset `annonces-commerciales`, ~50M records. Verified family facets:

```
26,248,464  Dépôts des comptes        (accounts-deposit notices)
 8,480,706  Modifications diverses    (incl. officer changes)
 6,541,339  Créations
 4,190,639  Radiations
 3,325,749  Procédures collectives    (insolvency proceedings)
   888,907  Ventes et cessions
```

Useful as *supporting* signal (a company-events / insolvency feed, and officer-change
corroboration), but it is **not** a clean fit for any single intent: "Dépôts des comptes"
only *announces* that accounts were filed (the accounts themselves are at INPI, token-gated),
and it carries no charges register. Recommend leaving BODACC as an optional later
enrichment, not a v1 intent source.

---

## Not feasible on free structured data (honest unsupported)

### `CompanyInsiders` — managers' transactions (déclarations des dirigeants, Art. 19 MAR) ❌

France's managers'-transactions declarations are **not** in the OAM flux (the
`sous_type_d_information` facet was fully enumerated — no managers'-transactions subtype).
They live only on the **AMF's own BDIF web UI** at `data.amf-france.org`, which from this
box returned **`code=000` / an HTML holding page** (unreachable / anti-bot, no ODS API, no
JSON). The AMF's five open datasets on data.gouv.fr (all licence **lov2**) are: net short
positions history, two blacklists, the approved-portfolio-management-company list, and the
PSAN/biens-divers whitelists — **none** is managers' transactions. So `CompanyInsiders`
proper is **not feasible** on free redistributable structured data.

> *Bonus, optional:* the AMF **"Historique des positions courtes nettes"** CSV (net short
> positions ≥ disclosure threshold, per issuer, licence lov2) is a real, redistributable
> disclosure feed — but it is *short-seller positions*, a bearish-position regime, not
> managers' transactions and not long major-holdings. It maps to no existing intent cleanly;
> note it as a possible future specialised addition, not `CompanyInsiders`.

### `CompanyFinancials` (FR-specific) ❌ — already covered by EU, or token-gated

French **listed** issuers' annual financials are already served today via
`jurisdiction: "EU"` (filings.xbrl.org ESEF, structured xBRL-JSON). An FR-specific path
would add only: (a) the same annual/half-year reports as **PDFs** in info-financiere —
strictly worse than the structured ESEF EU path; or (b) **non-listed** companies' accounts,
which are announced in BODACC "Dépôts des comptes" but whose actual figures sit behind the
**INPI RNE API** — verified **`401 "Vous n'avez pas les droits"`**, i.e. free-account
**token-gated**, failing the keyless bar (same class as INSEE Sirene, also verified `401`).
Keep FR `CompanyFinancials` unsupported and point users to `jurisdiction: "EU"` for listed
issuers, exactly as the DE adapter does.

### `PrivateRaises` ❌

No Form D analogue. Company creations / capital changes appear in BODACC as events, but
there is no private-placement / exempt-offering register. Not feasible.

### `CompanyCharges` ❌

France has **no free national security-interest register**. Nantissements / privilèges are
held per commercial-court greffe and sold through **Infogreffe (paid)**; BODACC
`annonces-commerciales` (Bodacc A/B) does **not** carry the nantissements register. Consistent
with the cross-jurisdiction parity finding: `CompanyCharges` stays GB-only. Honest
unsupported.

---

## Auth / licence / limits summary

| Source | Auth | Licence | Rate limit | Reachable from box |
|---|---|---|---|---|
| info-financiere.gouv.fr (ODS Explore v2) | none | etalab-2.0 | ODS anon quota | ✅ verified |
| opendatasoft FTP PDFs | none | etalab-2.0 | — | ✅ verified 200/pdf |
| recherche-entreprises.api.gouv.fr | none | Open Licence 2.0 | 7 req/s | ✅ verified |
| BODACC (bodacc-datadila ODS) | none | etalab-2.0 | ODS anon quota | ✅ verified |
| GLEIF | none | CC0 | — | ✅ FR verified |
| AMF short-positions CSV (data.gouv.fr) | none | lov2 | — | ✅ (dataset listed) |
| AMF BDIF managers' transactions UI | — | — | — | ❌ code 000 / HTML-only |
| INPI RNE API | **token (free account)** | — | — | ❌ 401 (keyed) |
| INSEE Sirene API | **token** | Licence Ouverte | — | ❌ 401 (keyed) |

**Anti-bot / walls to flag:** `data.amf-france.org` and `bdif.amf-france.org` did not serve
usable machine-readable content from this box; INPI RNE and INSEE Sirene both require a
token, so they are excluded under the keyless-or-trivial-free-key bar (INSEE/INPI could be
optional-key extensions later, like `OPENDART_API_KEY`, but are not needed given
recherche-entreprises covers resolution + officers keylessly).

---

## Recommended implementation order + effort

| Priority | Work | Why | Effort |
|---|---|---|---|
| **1** | **info-financiere `CompanyFilings` + `CompanyDocument`** (ODS Explore v2 JSON records → filing index; `url_de_recuperation` → keyless PDF fetch/save) | One keyless JSON API, no scraping, 535k records, direct PDFs, chains filings→document exactly like US EDGAR. Fills **two** intents at once. Highest value, lowest risk. | **S–M**: one ODSQL query builder + record mapper; document path reuses the existing 25 MB cap / save-to-disk. No new runtime dep. |
| 2 | **recherche-entreprises `CompanyResolve` + `PersonAppointments`** (name→SIREN; `dirigeants[]`; `nom_personne` person→companies) | Keyless, covers non-listed companies and gives FR a real registry appointments view stronger than DE's proxy. | **S**: two GET shapes, straightforward JSON. |
| 3 | **info-financiere `CompanyResolve` for listed issuers** (name/ISIN/LEI + `codes-lei`/`societes-cac40` seed cache) | Lets listed FR entities carry ISIN+LEI and bridge to the EU financials path and GLEIF. | **S**: same API as #1. |
| 4 (optional) | `CompanyOwners` as a **threshold-crossing notification list** (linked PDFs, explicit "% is in the document" caveat) | Honest partial; only worthwhile if a linked-notification list (no structured %) is acceptable. | **S**, but low value without PDF parsing. |
| — | BODACC enrichment; AMF short-positions feed | Supporting signals, no clean intent fit. | Defer. |
| ✋ | `CompanyInsiders`, `CompanyFinancials` (FR), `PrivateRaises`, `CompanyCharges` | Not feasible on free structured data; ESEF EU already covers listed FR financials. | Honest unsupported-jurisdiction explanations. |

**Single highest-value first adapter to build:** the **info-financiere.gouv.fr
`CompanyFilings` + `CompanyDocument`** pair. It is a keyless JSON API (not HTML scraping),
etalab-2.0 licensed, spans every French listed issuer's regulated filings with direct PDF
URLs, and delivers two intents from one source with mechanics the codebase already has for
US EDGAR. Everything else (resolve/appointments via recherche-entreprises, partial owners)
layers on cleanly afterward.
