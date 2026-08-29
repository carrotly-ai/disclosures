# TR — KAP, the Public Disclosure Platform (kap.org.tr)

**Data source:** [KAP — Kamuyu Aydınlatma Platformu](https://www.kap.org.tr/en/), Türkiye's
statutory disclosure platform for every Borsa İstanbul (BIST) issuer, operated by **MKK**
(Merkezi Kayıt Kuruluşu, the central securities depository). **Credentials:** none.
**Licence:** KAP/MKK content is copyright, rights reserved — this adapter takes the
**link-first, on-demand** posture used for cninfo: it reads what a caller asks for and cites
the source, and never bulk-mirrors.

KAP covers the **whole listed market** and serves three things keylessly: the BIST company
directory, any disclosure's detail page, and any disclosure's PDF. What it no longer serves
keylessly is a **query** — and that single fact shapes the entire TR route. See
[The enumeration wall](#the-enumeration-wall).

## Accepted `company` inputs

A **BIST stock code** (e.g. `THYAO`, `GARAN`, `ASELS`) — the highest-confidence input and the
one that resolves exactly. An issuer may carry **more than one stock code** (Türkiye Garanti
Bankası is both `GARAN` and `TGB`; Türkiye İş Bankası carries five — `ISATR`, `ISBTR`,
`ISCTR`, `ISKUR`, `TIB`); every code resolves to the same issuer, with the secondary codes kept as aliases.

Or a **KAP company id** (the number in a `/sirket-bilgileri/ozet/<id>-<slug>` URL, e.g.
`1107`), or the issuer's **legal name**.

Names are matched with Turkish spelling folded — the dotted/dotless `i` pair and the
`A.Ş.` / `A.O.` legal-form suffixes — so `Turkiye Is Bankasi`, `İŞ BANKASI` and
`TÜRKİYE İŞ BANKASI A.Ş.` all reach the same issuer. **Query in Turkish, not English:** KAP
is a Turkish-language register, so `Turkish Airlines` matches nothing while
`TÜRK HAVA YOLLARI` (or simply `THYAO`) resolves. A query that matches nothing returns an
empty result rather than the rest of the directory.

For `CompanyDocument`, `transaction_id` is the **numeric KAP disclosure id** — the integer in
a `/en/Bildirim/<id>` URL (e.g. `1446919`). A full `kap.org.tr` URL is also accepted and
reduced to its id; a URL on any other host is rejected before any request is made.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | The whole BIST directory: **stock code(s)**, legal name, **province**, **independent audit firm**, and KAP company id, plus a **GLEIF LEI** where one matches. One SSR page covers the market and is cached 24 h. |
| `CompanyDocument` | Any disclosure by KAP id. `metadata` reads the SSR detail page (title, company, stock code, publish date, disclosure class/category, summary, attachment count, late-filing flag, corrected-disclosure link) plus the PDF's size; `pdf` downloads the PDF to disk (25 MB cap, page count); `xhtml` runs the shipped text-layer extractor, paged via `text_offset` and fenced as untrusted. |
| `CompanyFilings` | **Unsupported** — see [The enumeration wall](#the-enumeration-wall). |
| `CompanyInsiders` | Unsupported — shareholding-change and board events are individual *disclosures*, not a structured dealings register; MKK e-YATIRIMCI is login-gated. |
| `CompanyOwners` | Unsupported — no free keyless substantial-shareholding register exists for Türkiye. |
| `CompanyFinancials` | Unsupported — KAP hosts statements, but the structured feed rides the non-public backend. |
| `PrivateRaises` / `CompanyCharges` / `PersonAppointments` | Unsupported — no Form D analogue; pledges live in Ticaret Sicili/MERSIS and TARES (paid, no keyless search); no keyless person-to-company directorship index. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## The enumeration wall

KAP was **rebuilt as a Next.js application** and its data layer moved to
`https://kapsitebackend.mkk.com.tr`. That host **does not resolve publicly** (verified from
this box: `getent hosts` returns nothing, `curl` exits 6), and the historically documented
`/tr/api/...` JSON endpoints now `404`.

The consequence is precise, and worth stating exactly because it decides what TR can honestly
promise:

- **Addressable by id → works keylessly.** `/en/Bildirim/<id>` returns a server-rendered page
  carrying a structured `disclosureBasic` block, and `/en/api/BildirimPdf/<id>` returns
  `application/pdf`. Both verified `200`.
- **Queryable by issuer → does not work.** The per-company notifications page
  (`/en/sirket-bildirimleri/<id>-<slug>`) returns `200`, but the body is an **empty shell**:
  filter chrome, date-range options, and a `SERVER_BASE_URL` pointing at the unreachable
  backend — **zero `/en/Bildirim/` links and zero `disclosureIndex` keys**. The rows are
  fetched by the browser at runtime from a host this package cannot reach. The site-wide
  detailed-search page (`/en/bildirim-sorgu`) is the same story.

So `CompanyFilings` for TR **returns an honest unsupported explanation** naming the cause and
pointing at the issuer's own KAP notifications page, rather than inventing a list or silently
returning nothing. `CompanyResolve` surfaces that page's URL for exactly this reason: it is
where a human gets the disclosure ids that `CompanyDocument` then reads keylessly.

If MKK republishes a public query endpoint, `CompanyFilings` becomes a small addition to this
adapter — the document and resolve halves already exist.

## Turkish text

Turkish is Latin-with-diacritics (`ı ğ ş ç ö ü İ Ğ Ş Ç Ö Ü`), so there is no non-Latin-script
extraction problem — but there is a subtler one, and it was a **real bug in this repo**.

KAP's PDFs use Identity-H composite fonts whose glyph ids are written into the content stream
as raw bytes. The shipped extractor decoded those bytes with `new TextDecoder("latin1")`,
which under the WHATWG Encoding Standard is **windows-1252, not ISO-8859-1**: it remaps
`0x80–0x9F` to typographic characters (`0x95` → `U+2022 BULLET`). Any glyph id in that window
decoded to the wrong character — Turkish `Ö` is glyph `0x0095`, so `PORTFÖY` came out
`PORTFeY` and `Özet` came out `ezet`. Fixed in `src/core/pdfText.ts` by building the string
from the raw bytes; the fix benefits **every** PDF-serving jurisdiction, not just TR, and is
covered by a regression test.

`CompanyResolve` output carries Turkish characters end to end as well (`İSTANBUL`,
`TÜRK HAVA YOLLARI A.O.`, `BAĞIMSIZ DENETİM`).

## Caveats

- **Listed issuers only.** KAP is a disclosure platform for BIST companies. Unlisted Turkish
  companies live in **Ticaret Sicili / MERSIS**, which is paid and not read here.
- **One issuer, several stock codes.** Resolve on any of them; the primary code leads and the
  rest are aliases.
- **GLEIF enrichment is conservative by design.** KAP carries no LEI, so it is fetched from
  GLEIF by legal name — but the two registers write legal forms differently (KAP abbreviates
  `A.Ş.` / `A.O.`, GLEIF expands `ANONİM ŞİRKETİ` / `Anonim Ortaklığı`), so the query drops
  the legal form and a hit is accepted **only** when both names agree with their forms
  removed. That check is load-bearing: a prefix query for `TÜRK HAVA YOLLARI` also matches
  the airline's staff pension foundation. Where the names genuinely differ beyond the legal
  form (KAP `AKBANK T.A.Ş.` vs GLEIF `AKBANK TÜRK ANONİM ŞİRKETİ`) **no LEI is attached** —
  a conservative miss is preferred to a wrong identifier.
- **The directory is cached 24 h** via `AdapterOptions.cache`. It is one ~1.5 MB page for the
  whole market; pass a cache so it survives process restarts.
- **Document text is best-effort.** Layout (tables, columns, reading order) is not preserved,
  and a scanned or image-only PDF reports an honest "no extractable text layer" rather than
  emitting garbage.
- Disclosure content is **issuer-authored**. `xhtml` output is fenced as untrusted data.

## Live verification

Verified through the built artifact on 2026-08-29 (keyless, no credentials configured):

| Query | Resolved | Stock code(s) | Province | LEI (via GLEIF) | KAP id |
|---|---|---|---|---|---|
| `THYAO` | TÜRK HAVA YOLLARI A.O. | THYAO | İSTANBUL | `789000EV8M3BL7ZPFB03` | 1107 |
| `GARAN` | TÜRKİYE GARANTİ BANKASI A.Ş. | GARAN, TGB | İSTANBUL | — | 2422 |
| `TGB` | TÜRKİYE GARANTİ BANKASI A.Ş. (secondary code) | GARAN, TGB | İSTANBUL | — | 2422 |
| `Aselsan` | ASELSAN ELEKTRONİK SANAYİ VE TİCARET A.Ş. | ASELS | ANKARA | — | 866 |
| `Ford Otosan` | FORD OTOMOTİV SANAYİ A.Ş. | FROTO | İSTANBUL | `7890006XJG6ZE2H34671` | 956 |
| `Turkiye Is Bankasi` | TÜRKİYE İŞ BANKASI A.Ş. | ISATR, ISBTR, ISCTR, ISKUR, TIB | İSTANBUL | `789000FIRX9MDN0KTM91` | 2425 |
| `Turkish Airlines` | *(no match — query in Turkish)* | — | — | — | — |

`CompanyDocument` (disclosure `1446919`, Türk Hava Yolları "Articles of Association",
published `2025-06-10 17:32:58`, class `DG`, category `ODA`, 2 attachments):

- `metadata` — returned the fields above from the SSR page.
- `pdf` — 252,011 bytes written to disk.
- `xhtml` — extracted the filing text with Turkish characters intact
  (`TÜRK HAVA YOLLARI A.O.`, `KAMUYU AYDINLATMA PLATFORMU`, `Hayır (No)`), fenced as
  untrusted.

Disclosure `1500000` (a fund expense-ratio report) round-tripped
`TRIVE PORTFÖY BİRİNCİ FON SEPETİ FONU` and the summary `TVN GİDER ORANI RAPORU`, and its
2-page PDF (84,573 bytes) extracted `Fon Toplam Gider Oranı`, `Özet Bilgi` and
`Konuya İlişkin Daha Önce Yapılan Açıklamanın Tarihi` — the uppercase `Ö` cases that
exercised the decoder fix.

An off-host `transaction_id` (`https://evil.example.com/en/Bildirim/1446919`) was rejected
with no network request made.
