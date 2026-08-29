# CN — cninfo (+ SZSE disclosure API)

**Data sources:** [cninfo](http://www.cninfo.com.cn/) (the CSRC-designated disclosure
portal), covering the Shanghai and Shenzhen exchanges plus an HKEX mirror; and the
**SZSE disclosure query API** (`www.szse.cn/api/report/ShowReport/data`) for Shenzhen
insider share-change disclosures.
**Credentials:** none. Resolution and the announcement feed use public POST endpoints;
the SZSE feed is a keyless GET needing only a `szse.cn` `Referer`.

## Accepted `company` inputs

A company name, a **6-digit A-share code**, or a **5-digit HK stock code**.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution across SSE, SZSE, and the HKEX mirror. |
| `CompanyFilings` | Date-filterable announcement feed with direct PDF links, including latest annual/quarterly periodic-report lookup. |
| `CompanyInsiders` | **Asymmetric by exchange.** SZSE codes (0/3xxxxx) → SZSE's keyless structured 董监高及相关人员股份变动 transaction feed. SSE codes (6xxxxx) → **bounded/best-effort** as-published 董监高 roster from the latest annual-report PDF. |
| `CompanyOwners` | **Bounded/best-effort** — 前十名股东 top-10 shareholders parsed from the freshest periodic-report PDF. |
| `CompanyFinancials` | **Bounded/best-effort** — headline figures extracted from the 主要会计数据 key-data table of the issuer's latest periodic-report PDF. |
| `CompanyDocument` | Announcement PDF `metadata` / `xhtml` (CJK-normalized extracted text, paged) / `pdf` (download). |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## `CompanyFinancials` — latest periodic-report figures

CN issuers file no keyless structured-XBRL feed, but their standardized SSE/SZSE periodic
reports carry a **主要会计数据 (key accounting data)** summary table that the shipped
zero-dependency PDF extractor recovers. The mode:

1. Selects the issuer's newest **full annual report (年度报告)**, else the newest
   interim/quarterly (半年度/一季度/三季度), filtering out summaries, English translations
   and corrections (摘要/英文/更正/…).
2. Downloads the PDF (capped at **40 MB** — large bank/insurer annuals can exceed it),
   extracts and space-collapse-normalizes the text (these PDFs position every glyph
   individually, so the extractor space-separates every character — a mandatory
   normalizer joins them back).
3. Anchors **only on the 主要会计数据 table** (the safest, unambiguous summary; the detailed
   合并 statements are deliberately not used, their scale/consolidation being harder to pin
   down safely), takes the **current-period (first) figure** for `revenue`,
   `operating_profit`, `total_profit`, `net_profit`, `total_assets`, `total_liabilities`,
   and `total_equity`, and normalizes each to **whole RMB** from the unit the report itself
   declares (元 / 千元 / 万元 / 百万元) — dropping any figure whose scale it cannot determine.

It is the **latest report only (no history)** and labels figures *as published*. It
**degrades to the PDF link** — never wrong numbers — when the report is mojibake
(`cjk === 0`: page/font objects packed in an object stream the extractor cannot read), over
the size cap, or has no readable key-data table.

## `CompanyOwners` — top-10 shareholders (前十名股东)

Every periodic report — **annual and quarterly alike** — carries the
**前十名股东持股情况** table, so the mode reads the *freshest* report of any kind rather
than preferring the annual.

The table is genuinely ragged: **column order varies by issuer** (Kweichow Moutai prints
name → 报告期内增减 → 期末持股数量 → 比例 → 股东性质; CATL prints name → 股东性质 → 比例 →
期末持股数量 → 增减), a holder with no change has one fewer numeric cell, and long names
wrap across lines. So the parser is a **value heuristic keyed on cell shape, not position**:

- a CJK-leading, non-header cell starts (or continues) a shareholder name;
- the value in `(0, 100]` — preferring an explicit `%` or a fractional one — is 比例;
- the largest remaining integer is 期末持股数量;
- a 股东性质 cell (国有法人 / 境内一般法人 / 境外法人 / …) fills the nature column.

**Only rows where both a percentage and a holding count matched are emitted** — a row the
parser cannot read confidently is dropped rather than guessed at, so a holder missing from
the output may still be in the table. `thresholdRegime` is
`"CN top-10 shareholders (periodic report, as published)"`.

**This is a point-in-time, as-published snapshot — not a live share register, not
beneficial-ownership or UBO tracing.** State-owned and nominee/custodian holders
(香港中央结算有限公司, 中国证券登记结算) appear exactly as printed, so a nominee line is a
custodian aggregate rather than one beneficial owner. Degrades to the report link on the
same mojibake / over-cap / no-table signals as `CompanyFinancials`.

## `CompanyInsiders` — asymmetric by exchange

Insider disclosure is **not symmetric across the two mainland exchanges**, and the mode
says so in its own output rather than pretending to one uniform dataset.

**SZSE (codes 0xxxxx main board, 3xxxxx ChiNext) — structured feed.** The Shenzhen
exchange backs its public 董监高人员股份变动 query page with a keyless JSON endpoint:

```
GET https://www.szse.cn/api/report/ShowReport/data
    ?SHOWTYPE=JSON&CATALOGID=1801_cxda&TABKEY=tab1&txtDMorJC=<code>&PAGENO=<n>
Referer: https://www.szse.cn/disclosure/supervision/change/index.html
```

It returns `[{ metadata, data }]`, filters by stock code, is newest-first, and pages at 20
rows with a `recordcount`. Each row is **one reported transaction**: 董监高姓名 (insider),
职务 (position), 变动日期 (date), 变动股份数量 (shares, in **万股** — converted to whole
shares), 成交均价 (average price), 变动原因 (竞价交易 / 大宗交易 / 盘后定价), 变动比例 (‰),
当日结存股数 (balance, also 万股), plus 股份变动人姓名 and 变动人与董监高的关系 — so a
transaction executed by a relative is attributed to the insider *with* the relationship.
Only a `szse.cn` `Referer` is needed; no captcha, login, or signed-header bypass is
involved.

**SSE (codes 6xxxxx) — annual-report roster fallback.** Shanghai publishes no equivalent
keyless per-code endpoint (its 董监高 changes sit inside the JS-gated 上市公司诚信记录 credit
file), so SSE issuers fall back to the **董事、监事、高级管理人员 roster table** in the latest
annual report PDF. Names and positions extract cleanly; **date and shareholding cells
fragment in extraction and are deliberately not emitted**. This is an as-published roster
snapshot — a *who sits on the board* view, not a transaction feed.

The two views answer different questions; read the response header (SZSE feed vs annual
report) before comparing issuers across exchanges.

## `CompanyDocument` — announcement PDFs

`transaction_id` is the **cninfo announcement PDF URL**, or its site-relative `adjunctUrl`
path (`finalpage/YYYY-MM-DD/<announcementId>.PDF`) — both are what `CompanyFilings` with
jurisdiction `"CN"` already returns for every row, and both resolve directly against the
static host with no re-query. Non-cninfo hosts are refused (SSRF guard).

- `metadata` (default) — source URL, byte size, page count.
- `xhtml` — best-effort extracted text with the **CJK space-collapse normalizer applied**,
  fenced as untrusted third-party content and paged 50,000 characters at a time via
  `text_offset`. A report whose text layer yields **zero CJK characters** is reported as
  mojibake rather than served as Latin/control soup.
- `pdf` — downloads to disk (25 MB cap) and returns the path, never inline bytes.

## Caveats

- `CompanyFinancials` figures are the issuer's own as-published numbers (e.g. a
  revenue-recognition change can produce a large year-on-year swing) — treat them as read
  from the filing, not a normalized/adjusted series. Verified live on a 10-issuer corpus
  (main board, ChiNext, STAR, a bank in 千元, and an insurer in 百万元 — the last recovered by
  the object-stream upgrade).
- The three PDF-derived modes (`CompanyFinancials`, `CompanyOwners`, SSE `CompanyInsiders`)
  share one honesty contract: **mojibake, over-cap or no-matchable-table returns the
  document link and no rows**, never a partially-guessed table.
- `CompanyOwners` and the SSE `CompanyInsiders` roster are **value-heuristic parses of a
  ragged table**, so they carry row-level extraction risk that the structured SZSE feed and
  the fixed-label financials table do not. Absence of a row is not evidence of absence in
  the filing.
- The SZSE insider feed is filing-based: an insider with no recently reported transaction
  simply does not appear, and the feed carries **Shenzhen-listed issuers only** (an SSE code
  legitimately returns zero rows there).
