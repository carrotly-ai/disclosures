# HK — HKEXnews

**Data source:** [HKEXnews](https://www.hkexnews.hk/) (`www1.hkexnews.hk`) — the official
electronic-disclosure portal for **every** Hong Kong listed issuer (SEHK Main Board + GEM).
**Credentials:** none. Resolution, the title-search servlet, and the disclosure PDFs are all
keyless.

HKEXnews is driven by keyless JSON reference files and a keyless JSON search servlet whose
`FILE_LINK` rows are directly fetchable PDFs. This is the HK analogue of the SEC EDGAR
submissions feed and materially **extends** the existing CN `cninfo` HKEX mirror: `cninfo`
only carries the China-cross-referenced subset (H-shares / dual-listed / Stock-Connect
names), whereas HKEXnews covers the full SEHK/GEM universe (17,987 active securities), is the
authoritative primary filer with native English titles and the official HKEX taxonomy, and
serves PDFs from the native host. The `cninfo` `hke` path is unchanged — HK-native queries
use this adapter.

## Accepted `company` inputs

A **4/5-digit HKEX stock code** (e.g. `700` or `00700`) or a **listed issuer's name**.
Resolution fetches the keyless stock-list JSON (cached 24 h) and matches by code or name; it
carries the public stock code plus the **internal HKEXnews `stockId`** the search servlet
requires (for Tencent: code `00700` → `stockId` `7609`, which is *not* the public code and
*not* the list's `s` sequence field).

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution of listed SEHK/GEM issuers (code or name → stock code + internal `stockId`). |
| `CompanyFilings` | Date-filterable title-search feed with direct PDF links; `mode "latest_annual"` filters the Annual Report category (t1code 40000 / t2code 40100). |
| `CompanyDocument` | Fetches a filing's PDF by its `FILE_LINK` path (`metadata` for type + size via a HEAD request, `pdf` to download; `xhtml` returns **best-effort text-layer extraction from the PDF**, fenced as untrusted and paged via `text_offset` — bilingual EN/中文 text is decoded via each font's `/ToUnicode` CMap; scanned/image PDFs are reported honestly with no text). |
| `CompanyInsiders` | Unsupported — no Section 16-equivalent feed; the DI directors'-interests register is captcha-walled and `dirsearch` is session/anti-CSRF-gated HTML. |
| `CompanyOwners` | Unsupported — substantial-shareholder holdings sit behind the SFO Part XV Disclosure of Interests (DI) system (`di.hkex.com.hk` / `sdinotice.hkex.com.hk`), an ASP.NET WebForms + login-captcha wall with no keyless feed. |
| `CompanyFinancials` | **Bounded/best-effort** — headline figures (`revenue`, `operating_profit`, `profit_before_tax`, `net_profit`, `total_assets`, `total_equity`) extracted from the issuer's **latest results-announcement PDF** (Final/annual, else Interim). No structured XBRL feed exists; see the section below. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

Private Hong Kong companies do **not** resolve here — the Companies Registry (ICRIS /
e-Services) is a paid per-search/per-document portal, not a free keyless source, so private
`CompanyResolve`, `CompanyDocument`, and `CompanyCharges` for HK are honestly unsupported.

## `CompanyDocument` transaction-id scheme

The `transaction_id` for HK is the filing's **`FILE_LINK` path**, with its leading slash
preserved, exactly as returned by `CompanyFilings` (e.g.
`/listedco/listconews/sehk/2026/0820/2026082000673.pdf`). A full
`https://www1.hkexnews.hk/…` URL is also accepted. The reconstructed document URL is
validated to stay on `hkexnews.hk` (no SSRF to arbitrary hosts). Downloads are capped at
25 MB and written to disk (bytes are never inlined).

`mode: "xhtml"` downloads the same capped PDF and runs the zero-dependency in-repo extractor
(`src/core/pdfText.ts`): object-level parse, `/FlateDecode` inflate via the shared `zip.ts`
zlib wrapper, `Tj`/`TJ` operator text, and `/ToUnicode` CMap decoding so the bilingual
English/Traditional-Chinese text layer round-trips. It is a **text-layer extractor, not a
renderer** — table/column layout is not preserved — and a scanned/image PDF (or one whose
fonts carry no `/ToUnicode` map) is surfaced as an honest "no reliable text layer" note.

## `CompanyFinancials` — results-announcement extraction (bounded)

HK issuers file no keyless structured-XBRL financials, but their standardized
**Results Announcement** PDFs carry the consolidated income statement and balance sheet in a
form the in-repo `pdfText.ts` extractor recovers with labels adjacent to figures. The adapter
locates the newest **Final Results** announcement (headline category `10000`, sub-category
group `t2Gcode 3`, `t2code 13300`), falling back to **Interim Results** (`t2code 13400`),
downloads the (keyless) PDF, extracts its text, and parses the canonical concept set:

| Concept | Label lexicon (HKFRS/IFRS + REIT/property variants) |
|---|---|
| `revenue` | Total revenue / Revenue / Turnover |
| `operating_profit` | Profit from operations / Operating profit |
| `profit_before_tax` | Profit before taxation / before tax |
| `net_profit` | Profit attributable to owners/shareholders of the Company (preferred), else Profit for the year |
| `total_assets` | Total assets |
| `total_equity` | Total equity (preferred) / Net assets attributable to unitholders (REIT) |

**Units are carried honestly.** The filing's own declaration sets the currency and scale —
`HK$'000`, `HK$ million`, `(Expressed in Renminbi … Million)` (China Mobile and Tencent report
in **RMB/CNY**), or `($m)` with US dollars (HSBC reports in **USD**) — normalized to whole
currency units. When neither currency nor scale can be pinned down, **no figures are emitted**.

**Honest degradation.** Extraction is anchored to the consolidated-statement region (skipping
narrative highlights and quarterly tables), takes the **first (current-period) figure column**,
and emits only confidently-matched concepts (a partial parse serves what matched). Two guards
degrade to the **PDF link only** rather than serve uncertain numbers:

- **Page shortfall** — the consolidated statements packed inside compressed object streams the
  extractor cannot reach (declared-vs-reached page shortfall). The `pdfText.ts` ObjStm/xref
  decompressor now resolves this for most filings (e.g. CK Hutchison's ~270-page announcement),
  but the guard remains for anything still unreadable.
- **No statement found** — no consolidated income statement or balance sheet matched.

Output is labelled "extracted from the issuer's results announcement (as published — unaudited
or audited per the filing)", with the period end and announcement date, and states it is the
**latest announcement only — no historical series**. Verified live: China Mobile (RMB), HSBC
(USD), Tencent (RMB) extract cleanly; complex conglomerates with segment-split or multi-column
statements parse partially or degrade to the link.

## Licence / redistribution

HKEXnews content is **copyrighted** (not an open-data licence) — the same posture as the
already-shipped `cninfo`, `bseIndia`, and `twseOpenApi` adapters. This release does **not**
redistribute documents in bulk: it returns the **official source link** and fetches document
content **on demand** for the end user, citing the source. The stock-list and taxonomy JSONs
are used as internal lookups only, never re-published.

## Caveats

- Listed SEHK/GEM issuers only; private companies are in the paid Companies Registry.
- `CompanyFilings` returns real disclosure PDF links; `CompanyFinancials` extracts headline
  figures from the results-announcement PDF (bounded — degrades to the link when unreliable);
  the insider/owner intents degrade honestly rather than scraping captcha- or session-walled
  sources.
- Absence in a filings window is not proof a filing does not exist — adjust
  `start_date`/`end_date`.
