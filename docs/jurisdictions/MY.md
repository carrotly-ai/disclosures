# MY — Bursa Malaysia company announcements

**Data source:** [Bursa Malaysia](https://www.bursamalaysia.com/)'s company-announcements
search, `https://www.bursamalaysia.com/api/v1/announcements/search`, plus the announcement
documents it links on `https://disclosure.bursamalaysia.com/FileAccess/viewHtml`.
**Credentials:** none — the API is keyless. **But** both hosts sit behind a Cloudflare
managed challenge, so in practice the MY route needs a browser-backed
`AdapterOptions.fetchFn` (see [Cloudflare posture](#cloudflare-posture) below).

One feed backs the whole jurisdiction. It is a single ~2.09-million-row index of every
company announcement on the exchange, and it is unusual among the sources in this package
in carrying **first-class structured categories for both insiders and owners**:

| Bursa announcement category | Backs |
|---|---|
| all company announcements | `CompanyFilings` |
| **"Changes in Director's Interest (Section 219 of CA 2016)"** | `CompanyInsiders` |
| **"Changes in Sub. S-hldr's Int (Section 138 of CA 2016)"** | `CompanyOwners` |
| the issuer name + `stock_code` each row carries | `CompanyResolve` |

Both disclosure categories live under the exchange's own **`SH,CHSH` ("Changes in
Shareholdings")** category value, so `CompanyInsiders` and `CompanyOwners` request that
one category server-side and then separate the two by announcement-title prefix.

## Accepted `company` inputs

- A **4-digit Bursa stock code** — `1155` (Malayan Banking / Maybank), `1295` (Public
  Bank), `5020` (Glomac). Instrument suffixes are accepted too (`1155OR`, `0800EA`),
  because Bursa keys warrants, rights and ETF classes off the same base code.
- An **issuer name** — matched against the issuer names the announcements feed itself
  carries, ranked exact → prefix → substring.
- Bursa publishes **no keyless company-directory JSON endpoint**: the listing directory's
  company list is server-rendered into the announcements page's `<select>` (3,894 options,
  verified live). So the announcements feed is the resolution surface, which means an
  issuer with no announcements in the searched window will not resolve by name. A stock
  code always resolves if the issuer has ever announced.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Issuer legal name + Bursa stock code, linked to the official company-profile page. |
| `CompanyFilings` | The announcements feed for one issuer: announced date, announcement title, the trailing sub-headline Bursa renders under some titles, the `ann_id`, and a link to the official announcement. Supports a date window (`start_date`/`end_date`), a `limit`, and the exchange's **own category taxonomy** via `forms` (see below). The response states the true `recordsTotal` so a caller knows how much it is not seeing. |
| `CompanyInsiders` | The s.219 director-interest announcements: director name, announced date, transaction type and nature of interest, trade date, share count, and the resulting **direct** holding percentage — parsed from the linked announcement document. |
| `CompanyOwners` | The s.138 substantial-shareholder announcements: holder name, announced date, acquired/disposed direction, trade date, share count, and the resulting **direct** percentage — likewise parsed from the linked document. `thresholdRegime` is `MY Companies Act 2016 s.137/138 substantial shareholding`. |
| `CompanyFinancials` | Unsupported — see below. |
| `CompanyDocument` / `CompanyCharges` / `PersonAppointments` / `PrivateRaises` | Unsupported — see below. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

### `forms` uses Bursa's own category values

`CompanyFilings` filters server-side by one category. Pass the exchange's own value as the
first `forms` entry; any second entry is passed on as the feed's title keyword. The
taxonomy is read from the search form itself and is printed in every `CompanyFilings`
response:

`AL,ALCO` · `AA,AACO` · `AR,ARCO` (Annual Report) · `CI,COCI` · **`SH,CHSH` (Changes in
Shareholdings)** · `CS,CSCO` · `DRCO` · `DLCO` · `DMCO` · `EA,ENCO` · `ES,EMCO` ·
**`FA,FRCO` (Financial Results)** · `GA,GACO` · `GM,MECO` · `IO,IPOA` · `TR` · `IA,IACO` ·
`LC,LCCO` · `IP,LICO` · `PP,PPCO` · `RQ,RQCO` · `SB,SBBA` · `SA,SACO` · `TECO` · `TL,TRFL` ·
`UMA,UMCO`

## The announcement documents are structured — so insiders and owners are too

The finding that produced this adapter noted that if the feed gave only titles and links,
the honest answer was to return the announcement *list* and say plainly that the
per-transaction detail lives in the linked document (as FR owners does). **Live
verification on 2026-08-29 found better than that:** the linked document on
`disclosure.bursamalaysia.com` is a fixed-template HTML table, not a PDF and not a scan,
and it carries every field the intents want. So this adapter parses it.

A real s.219 document (Timberwell, `ann_id=3700853`) yields:

| Field | Value |
|---|---|
| Director | `MR WONG WAI FOO` |
| Transactions | `2026-08-26` **Acquired** 300,000 Direct Interest, consideration `RM1.950 per ordinary share`; `2026-08-27` **Acquired** 200,000, `RM1.980 per ordinary share` |
| Registered holder | `MBSB Investment Nominees (Tempatan) Sdn Bhd [Pledged Securities Account for Wong Wai Foo]` |
| Resulting direct | 45,845,259 units / **51.482%** |
| Resulting indirect/deemed | 17,060,251 units / 19.158% |
| Circumstances | `Acquisition Shares via Open Market` |

A real s.138 document (Maybank, `ann_id=3700039`) yields:

| Field | Value |
|---|---|
| Substantial holder | `EMPLOYEES PROVIDENT FUND BOARD` |
| Transaction | `2026-08-24` **Disposed** 2,403,400 Direct Interest |
| Resulting direct | 1,511,246,097 units / **12.494%** |
| Circumstances | `DISPOSAL OF SHARES` |
| Notice / received | `2026-08-26` / `2026-08-28` |

### Bounds, stated honestly

- **A capped number of documents is opened per call** (`BURSA_MAX_DETAIL_FETCHES`, 10). A
  call that returns more rows than that fetches detail for the first 10 and says so; the
  remaining rows are **link-only**, with the announcement link that carries their detail.
- **`Direct %` is the direct limb only.** A transaction marked *Indirect Interest* moves
  the deemed limb, whose separate units and percentage are in the linked announcement.
  Every rendered response states this rather than letting the column be read as a total.
- **Where a template leaves the indirect columns blank, they stay unset** — never coerced
  to a misleading `0`.
- **Owners is a dealings feed, not a cap table.** A holder appears when it crosses or
  moves within the 5% threshold; the absence of a holder is not evidence it holds nothing.
  Stated on every response.

## Cloudflare posture

**Verified live from this box on 2026-08-29.** Both `www.bursamalaysia.com` and
`disclosure.bursamalaysia.com` answer a plain request with **HTTP 403 and Cloudflare's
"Just a moment..." managed-challenge interstitial**. This was retested with:

- full realistic browser headers (UA, `Accept`, `Referer`, `Accept-Language`) — still 403;
- the **exact XHR header set the site's own page uses** (`X-Requested-With:
  XMLHttpRequest`, `Accept: application/json, text/javascript, */*; q=0.01`, the page as
  `Referer`, plus the cache-busting `_=<epoch>` the page appends) — still 403;
- a real headless Chromium that had already loaded and solved the announcements page,
  issuing the request via `fetch` **and** via the page's own jQuery — **still 403**, with a
  fresh `_cf_chl_opt` challenge each time;
- top-level navigation directly to the API URL — the interstitial, never the JSON.

Only the page's **own auto-issued XHR** carries the clearance. The clearance is bound to a
cookie issued after the challenge is solved, so **no static header set can substitute for
it** — this is a stricter posture than the finding anticipated, and stricter than BSE
India's Akamai gate.

The adapter therefore follows the **BSE India precedent** exactly: it tries the request
with realistic headers, detects the interstitial (by title, by `_cf_chl_opt`, by the
`challenges.cloudflare.com` CSP markers, and by the `403` status), and returns the honest
message naming the escape hatch:

> Bursa Malaysia (…) is behind a Cloudflare managed challenge and answered this request
> with the "Just a moment..." interstitial instead of data. The clearance is bound to a
> cookie issued only after the challenge is solved in a real browser, so no static header
> set can substitute for it. To use the MY route, inject a browser-backed `fetchFn` via
> `AdapterOptions.fetchFn` … **This adapter will not fabricate or silently return an empty
> result.**

`AdapterOptions.fetchFn` is available to TypeScript-library users and custom server wrappers;
the stock `npx disclosures` stdio process has no way to receive a JavaScript function. In a
plain stdio deployment, expect the actionable Cloudflare refusal unless the host itself is
allowed through.

Every MY intent takes that path. **A challenge is never degraded to an empty result** —
including a challenge on the *document* host mid-way through an insiders/owners call,
which surfaces rather than silently reverting the rows to link-only.

### Verified through the injected `fetchFn`

With a browser-backed `fetchFn` injected, the built artifact returns real data (live,
2026-08-29):

```
CompanyResolve  1155  → MALAYAN BANKING BERHAD (stock 1155)
CompanyFilings  1155  → 10,279 announcements match; s.138 rows, a DRP securities
                        announcement with its sub-headline, the 30/06/2026 quarterly
CompanyOwners   1155  → EMPLOYEES PROVIDENT FUND BOARD  Disposed 2026-08-24
                        2,403,400 → 12.494%
                        KUMPULAN WANG PERSARAAN (KWAP)  Acquired 2026-08-27
                        125,000 → 4.77%
                        AMANAHRAYA TRUSTEES - AMANAH SAHAM BUMIPUTERA
                        Acquired 2026-08-21 2,000,000 → 28.673%
CompanyInsiders 5020  → DATUK SERI FATEH ISKANDAR …  Acquired (Direct Interest)
                        2026-08-20  4,000 → 20.864%
                        TAN SRI DATO' MOHAMED MANSOR …  Acquired (Indirect Interest)
                        2026-08-20  4,000 → 13.718%
```

## Not supported, and why

- **`CompanyFinancials`** — Bursa publishes quarterly and annual results as announcement
  *documents*, not as a normalized or XBRL feed. Use `CompanyFilings` with `forms:
  ["FA,FRCO"]` (Financial Results) or `["AR,ARCO"]` (Annual Report) to locate the report
  and open the linked announcement. (Contrast Indonesia, whose IDX publishes a real XBRL
  instance per report.)
- **`CompanyDocument`** — the announcement body is served from the second
  Cloudflare-challenged host, and `CompanyFilings`, `CompanyInsiders` and `CompanyOwners`
  already return the official announcement link on every row — with insiders and owners
  additionally parsing that document's structured detail. MY is therefore absent from
  `CompanyDocument`'s jurisdiction list, as SG/TH/NL are.
- **`PersonAppointments`** — Bursa indexes announcements by issuer, not by person; there
  is no person→companies index.
- **`PrivateRaises`** — Malaysia has no Form D analogue published as open data. Private
  placements by listed issuers appear as ordinary announcements (use `CompanyFilings`);
  unlisted-company raises are not disclosed openly.
- **`CompanyCharges`** and any **private-company** lookup — **SSM**
  ([`ssm-einfo.my`](https://www.ssm-einfo.my/), Suruhanjaya Syarikat Malaysia, the national
  companies registry) sells company information per document rather than publishing it.
  Confirmed live: the e-Info FAQ describes RM-priced "purchase for company information"
  transactions. Honest unsupported — the same posture as HK ICRIS and SG BizFile.

## Rate limiting

`bursaRateLimiter` — a 90-request/60 s sliding window, deliberately modest. One
`CompanyInsiders` or `CompanyOwners` call is a resolve, a category search, and up to 10
document reads, so a single bounded lookup never self-trips, while cross-call abuse does.
The budget is conservative on purpose: this host runs an anti-bot challenge, and this
package should not add to the pressure that exists for.

## Licence / ToS posture

Bursa Malaysia site content is **exchange copyright with no open-data licence** — the same
posture as the already-shipped BSE India, cninfo, TWSE and HKEXnews adapters, and *not*
the "personal, non-commercial, no-redistribute" class that disqualified ASX — and that PH
(PSE EDGE) sits in, which is why PH ships with an explicit terms-of-use conflict recorded in
[PH.md](PH.md) while MY needs no such warning.
Under this package's link-first, fetch-on-demand model (return the official source link,
fetch content for the end user, cite the source) MY sits on the accepted side of that line.
Every rendered MY response carries the `© Bursa Malaysia` attribution.

## Provenance

Endpoints, parameter names, response shapes and both document templates were verified live
from this box on **2026-08-29**. The request shape (`ann_type=company`,
`company=<stock_code>`, `cat`, `keyword`, `dt_ht`/`dt_lt` as **DD/MM/YYYY**, `per_page`
capped at 50, `page`) was read from the search form's own controls and confirmed against
real responses; the category taxonomy is that form's `cat` `<select>`. The offline test
fixtures under `tests/fixtures/bursa/` are verbatim captures from those calls.
