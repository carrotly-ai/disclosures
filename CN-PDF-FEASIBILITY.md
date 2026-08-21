# CN (cninfo) deep-dive — can the zero-dep PDF extractor read Chinese periodic reports?

> **Status:** finding only — no code change ships with this document. Applies the
> `HKSG-DEEPDIVE.md` corpus method to **China (CN)**, the largest unfilled cell in the
> coverage matrix: fetch N real filings through the shipped `cninfo` adapter's endpoints →
> run each through the shipped `src/core/pdfText.ts` → assess **CompanyFinancials /
> CompanyOwners / CompanyInsiders** honestly, with verbatim garbled samples as proof where
> extraction fails. The honesty bar from the HK finding applies: a wrong ✅ costs far more
> than an honest ❌.
>
> All endpoints and PDFs re-verified **live from this box on 2026-08-21**. Egress IP
> **`219.75.71.94`** (HK). cninfo answered every request — no datacenter-IP block observed
> this run (the earlier "cninfo flaky from datacenter IPs" caveat did not bite).

## Headline

- **CN CompanyFinancials via periodic-report PDF extraction — ✅ FEASIBLE (bounded).** The
  shipped extractor pulls the consolidated income-statement and balance-sheet line items
  (营业收入 revenue, 利润总额 total profit, 归属于上市公司股东的净利润 net profit
  attributable, 资产总计 total assets, 负债合计 total liabilities, 归属于母公司所有者权益
  equity) out of standard SSE/SZSE annual, half-year and quarterly reports with **labels
  adjacent to figures in correct reading order** — after **one mandatory preprocessing step**
  (see below). Verified on 8 of 9 extracted annuals plus a bank, a half-year and two
  quarterlies. The dominant failure (ObjStm-packed filings → silent mojibake) is **detectable**
  (`cjk===0` / `pages===undefined`) so the mode degrades honestly, and is the exact class the
  concurrent ObjStm upgrade targets.

- **The one mandatory catch specific to CN:** these PDFs position **every glyph individually**,
  so the raw extractor output space-separates *every character* — `营业收入` comes out as
  `营 业 收 入` and `168,838,102,514.79` as `1 6 8 , 4 3 8 , 1 0 2 , 5 1 4 . 7 9`. The text is
  **fully correct and in reading order**; it just needs a deterministic space-collapse
  (join adjacent CJK glyphs; strip spaces inside `[\d,.]` runs) before any label match. This is
  a ~15-line normalizer, not a blocker — but nothing parses without it.

- **CompanyOwners (前十名股东 top-10 shareholders) and CompanyInsiders (董监高
  directors/supervisors/senior management) — ⚠️ PARTIAL.** Both tables **survive extraction
  with readable names, share counts, percentages, titles** in **all 9 clean docs**. Unlike HK
  (where the beneficial-owner DI register was captcha-walled and only custodian-level CCASS was
  reachable), here the **real major-shareholder register and the actual board roster are inside
  the PDF and extractable**. The downgrade to ⚠️ is purely structural: column order varies by
  issuer, rows are ragged (variable numeric-cell counts), names/dates wrap across lines — so a
  clean structured parse needs value-heuristic row logic and will carry row-level error, unlike
  the fixed-label financial statements.

---

## Per-intent verdict

| Intent | Verdict | Basis on the corpus |
|---|---|---|
| **CompanyFinancials** | ✅ **FEASIBLE (bounded)** | Revenue/profit/assets/liabilities/equity recovered with labels adjacent to figures on **8/9 extracted annuals + bank + half-year + 2 quarterlies**, after space-normalization. 1/9 mojibake (ObjStm, detectable + likely fixed by ObjStm upgrade). 主要会计数据 summary table is the safest anchor. |
| **CompanyOwners** | ⚠️ **PARTIAL (data survives; ragged parse)** | 前十名股东持股情况 present & readable in **9/9 clean docs** — shareholder names, 期末持股数量 share counts, 比例% all extract. Ragged columns + issuer-specific ordering + wrapped names need heuristic row parsing. Real beneficial/major shareholders (a genuine win vs HK). |
| **CompanyInsiders** | ⚠️ **PARTIAL (data survives; ragged parse)** | 董事、监事、高级管理人员 table present & readable in **9/9 clean docs** — names + titles + age + shareholdings + pre-tax pay (万元). Names/titles clean; date fields fragment. Same ragged-table parse challenge. |
| PrivateRaises | ❌ unchanged | No Form-D-equivalent dataset; out of scope of report PDFs. |

**Net:** CN moves from three ❌ ("data lives inside Chinese-language report PDFs this release
does not parse") to **one ✅ + two ⚠️**. The blanket "does not parse" line in `docs/jurisdictions/CN.md`
is now demonstrably too pessimistic.

---

## Corpus — 12 real cninfo PDFs, extracted with the shipped `pdfText.ts`

Fetched via the adapter's exact shape: `topSearch/query` to resolve → `hisAnnouncement/query`
with the periodic-report category → PDF at `static.cninfo.com.cn/{adjunctUrl}`.

### Annual reports (年度报告, `category_ndbg_szsh`)

| Issuer | Code | Board | PDF | Pages | CJK chars | Financials | Owners | Insiders |
|---|---|---|---|---|---|---|---|---|
| Kweichow Moutai 贵州茅台 | 600519 | SSE main (mega) | 1.08 MB | 143 | 80,861 | ✅ verified | ✅ present | ✅ present |
| Wuliangye 五粮液 | 000858 | SZSE main | 3.09 MB | 141 | 82,521 | ✅ | ✅ | ✅ |
| Midea 美的集团 | 000333 | SZSE main | 5.94 MB | 276 | 144,883 | ✅ | ✅ | ✅ |
| Hikvision 海康威视 | 002415 | SZSE main (mid) | 17.34 MB | 263 | 149,915 | ✅ | ✅ | ✅ |
| CATL 宁德时代 | 300750 | ChiNext | 2.04 MB | 232 | 126,525 | ✅ | ✅ verified | ✅ |
| East Money 东方财富 | 300059 | ChiNext | 4.98 MB | 181 | 106,925 | ✅ | ✅ | ✅ |
| Montage 澜起科技 | 688008 | STAR (688) | 3.72 MB | 248 | 132,635 | ✅ | ✅ | ✅ |
| Kingsoft Office 金山办公 | 688111 | STAR (688) | 1.87 MB | 262 | 147,398 | ✅ | ✅ | ✅ verified |
| Qingdao Bank 青岛银行 | 002948 | SZSE main (bank) | 2.17 MB | 310 | 158,478 | ✅ (bank layout) | ✅ | ✅ |
| **Ping An 中国平安** | **601318** | SSE main (mega insurer) | 9.50 MB | **undefined** | **0** | ❌ **mojibake** | ❌ | ❌ |
| CMB 招商银行 | 600036 | SSE main (mega bank) | **32.1 MB** | — | — | ⏭ **over 30 MB cap** (not extracted) | — | — |
| SMIC 中芯国际 | 688981 | STAR (688) | — | — | — | ⏭ **no annual in cninfo SSE feed** (dual HK/STAR quirk) | — | — |

### Interim / quarterly reports (same category machinery)

| Report | Code | Category | PDF | Pages | CJK | Financials |
|---|---|---|---|---|---|---|
| Moutai 2026 half-year 半年度报告 | 600519 | `category_bndbg_szsh` | 0.83 MB | 110 | 57,845 | ✅ revenue/net-profit/assets/net-assets clean |
| Midea 2026 Q1 一季度报告 | 000333 | `category_yjdbg_szsh` | 0.45 MB | 12 | 4,010 | ✅ (units **千元**) |
| CATL 2025 Q3 三季度报告 | 300750 | `category_sjdbg_szsh` | 0.35 MB | 12 | 5,097 | ✅ |

**Corpus stat:** of **9 annuals that extracted**, **8 clean, 1 mojibake** (Ping An). All 3
interim/quarterly reports clean. The bank extracted cleanly (no HK-style multi-column
fragmentation). Mojibake rate observed **1/9 ≈ 11%**, and that one is an ObjStm case (below).

---

## Evidence — the tables survive (verbatim from `extractPdfText`, after space-collapse)

### Financials — 主要会计数据 (key accounting data) summary table is the cleanest anchor

**Moutai 600519** — label on its own line, then figures in reading order (2025, 2024, Δ%, 2023):
```
营业收入
168,838,102,514.79   170,899,152,276.34   -1.21   147,693,604,994.14
利润总额
114,755,261,605.08   119,638,578,194.46   -4.08   103,662,553,689.81
归属于上市公司股东的净利润
82,320,067,101.68    86,228,146,421.62    -4.53   74,734,071,550.75
经营活动产生的现金流量净额
61,522,204,989.35    92,463,692,168.43    -33.46  66,593,247,721.09
```
(Moutai FY2025 revenue ≈ ¥168.8 bn, net profit ≈ ¥82.3 bn — both correct.)

**Moutai 600519** — consolidated balance sheet (合并资产负债表), labels adjacent to both-year
figures:
```
资产总计              303,834,844,021.44   298,944,579,918.70
负债合计               49,875,590,112.37    56,933,264,798.10
归属于母公司所有者权益   244,637,811,032.18   233,105,984,399.47
```

**Qingdao Bank 002948** — bank income statement/balance sheet extract cleanly, with the extra
bank line item 利息净收入 (net interest income); **no fragmentation** (contrast HK's segmented
bank/exchange statements):
```
营业收入        14,572,778
利息净收入      11,069,992
利润总额         6,243,835
归属于母公司股东的净利润  5,187,741
资产总计       814,960,084
负债合计       764,705,628
```

**Midea Q1 000333** — quarterly, **units 千元 (thousands)**, label wraps across lines:
```
营业收入（千元）                     131,098,601   127,838,538   2.55%
归属于上市公司股东的净利润（千元）      12,674,556    12,422,233   2.03%
```

### Owners — 前十名股东持股情况 (top-10 shareholders)

**Moutai 600519** (column order: name → 报告期内增减 → 期末持股数量 → 比例% → 股东性质):
```
中国贵州茅台酒厂（集团）有限责任公司   2,071,359   681,282,935   54.40   无   国有法人
贵州省国有资本运营有限责任公司                     56,996,777    4.55   未知  国有法人
香港中央结算有限公司                  -22,462,778   55,048,844    4.40   未知
```
**CATL 300750** (**different** column order: name → 股东性质 → 比例% → 期末持股数量 → 增减):
```
厦门瑞庭投资有限公司   境内一般法人   22.45%   1,024,704,949   1,024,704,949
香港中央结算有限公司   …
```
Names, share counts and percentages all readable. The **variable column order across issuers**
is the reason a parser must key on cell *shape* (the `%` cell; the largest integer = holding
count), not fixed position.

### Insiders — 董事、监事、高级管理人员 (directors / supervisors / senior management)

**Moutai 600519** — header row then data: name, title, gender, age, term dates, year-start/end
shareholdings, pre-tax pay (万元):
```
姓名  职务  性别  年龄  任期起始日期 … 报告期内从公司获得的税前薪酬总额（万元）
陈华  党委书记  男  54  2025年10…
```
**Kingsoft 688111**:
```
邹涛  董事、董事长  男  51  2019-07-19  2028-06-03 …
```
Names + titles + ages clean; **date fields fragment** (`2028-06-03` came out `202 8 - 0 6 - 03`).
Names/titles are the load-bearing fields and they hold.

### The honest ❌ — Ping An 601318 (mojibake, silent)

Raw extractor output, first bytes (no `notes`, `pages===undefined`, `cjk===0`):
```
i\x1cY\x17Ò\tw\x03ZU'K'L‹\x1a´\x03v\t\x13\x1c6\x17m\x184U'\x038\x07D@úA\x1a\x06¤\x1c6…
```
556,701 chars of Latin/control-symbol soup, **zero Chinese**. Cause (verified on the raw PDF):
Ping An packs **all page objects and all font `/ToUnicode` maps into 11 `/ObjStm` object
streams** — the raw file shows `/Type /Page` ×0 and `/ToUnicode` ×0 at top level. The current
linear scanner can't decompress `/ObjStm`, finds no `/Type /Page`, falls to its
render-every-stream fallback with the **default WinAnsi decoder**, and emits mojibake. By
contrast Midea (clean) keeps 277 page objects + 9 ToUnicode maps as regular objects *despite*
also using 148 ObjStm streams — it's *where* the producer put the critical objects that decides
clean-vs-mojibake.

> **This is the same ObjStm class flagged as the one hard failure in the HK finding, and the
> concurrent `pdfText.ts` ObjStm/xref-stream decompression upgrade should recover Ping An**
> (once ObjStm is inflated, its page objects + ToUnicode maps become visible and CJK should
> decode like every other issuer). Measured with what ships today it is ❌; mark as **"will
> improve."** Critically, the current build emits it **silently (empty `notes`)** — the
> `alnumRatio` garble-guard is fooled because Latin letters/digits keep the ratio > 0.35. A
> builder must add the CN-specific detector below.

---

## Number-format & label-lexicon groundwork (what a builder must target)

**Mandatory preprocessing (CN-specific, before any parse):**
1. **Collapse per-glyph spacing.** Repeatedly join two adjacent CJK glyphs separated by one
   space; strip spaces inside `[\d,.]` runs. Without this, *nothing* matches (labels and
   numbers arrive fully space-separated).
2. **Rejoin split numbers.** A trailing digit occasionally wraps to the next line
   (`…689.8` / `1` → `…689.81`). Merge a numeric line whose predecessor ends mid-number.
3. **Tolerate wrapped labels.** `营业收入（千元）` extracts as `营业收入（` / `千` / `元）`;
   the label anchor must span line breaks or match on the leading `营业收入` prefix.

**Units — read the qualifier, do not assume 元:**
- **元 (full yuan, comma-grouped)** — most annual-report statement tables (Moutai, Qingdao).
- **千元 (thousands)** — seen in Midea's quarterly; unit stated in the label `（千元）`.
- **万元 (ten-thousands)** — executive pre-tax compensation column (董监高 table).
- Statement tables use **Western digits + comma thousands separators + `.` decimal**. The
  Chinese 万/亿 groupings appear only in **narrative prose** (e.g. "148.9亿元"), not the tables.
- Decreases: leading `-` (sometimes `- ` with a space pre-collapse), e.g. `-22,462,778`.

**Financials label lexicon (income statement + balance sheet):**
| Concept | Primary label | Notes / variants |
|---|---|---|
| Revenue | `营业收入` | banks also carry `利息净收入`; `营业总收入` on some issuers |
| Operating profit | `营业利润` | present in full 利润表 (not always in the summary table) |
| Total profit | `利润总额` | pre-tax |
| Net profit attributable | `归属于上市公司股东的净利润` | statement form: `归属于母公司股东的净利润` |
| Total assets | `资产总计` | |
| Total liabilities | `负债合计` | |
| Equity attributable | `归属于母公司所有者权益` | summary table may use `归属于上市公司股东的净资产` (元) / `所有者权益合计` (incl. minority) |

**Disambiguation (the two real traps):**
- **Consolidated vs parent-company.** Every report prints 合并 (consolidated) statements
  **then** 母公司 (parent-only) — labels like `负债合计` recur. Anchor on the **first**
  occurrence / the `合并资产负债表`·`合并利润表` section headers; never blind first-label-match
  (a naive match hit per-quarter breakdown / parent tables and returned wrong figures for
  ~half the corpus in testing).
- **Summary table is the safe core.** The `主要会计数据` block near the front carries
  revenue + net-profit + assets + net-assets as a single clean, unambiguous table — the
  highest-reliability anchor, analogous to HK's "highlights block."

**Owners/Insiders table shape:** header cells arrive one-per-line, then data rows with
**issuer-specific column order** and **ragged cell counts** (a shareholder with no change has
one fewer numeric cell; names wrap across 1–3 lines). Parse by cell shape: the `%`-bearing
cell = 比例; the largest integer = 期末持股数量; a leading CJK run = the name.

**Detection signals for honest degrade (a builder must gate on these):**
- `cjk === 0` (or CJK-char ratio ≈ 0) on a Chinese report ⇒ **mojibake** ⇒ link-only.
- `pages === undefined` ⇒ no top-level page objects (ObjStm-packed) ⇒ link-only until the
  ObjStm upgrade lands.
- PDF size over the fetch cap (CMB 32 MB) ⇒ link-only. Big-4 bank annuals can exceed any
  sane cap; the shipped extractor's own guard is 64 MB inflated.

---

## Category codes (verified live 2026-08-21; already in the shipped adapter)

| Report kind | cninfo category | Adapter constant |
|---|---|---|
| Annual 年度报告 | `category_ndbg_szsh` | `CNINFO_ANNUAL_CATEGORY` |
| Half-year 半年度报告 | `category_bndbg_szsh` | `CNINFO_HALF_YEAR_CATEGORY` |
| Q1 一季度报告 | `category_yjdbg_szsh` | `CNINFO_Q1_CATEGORY` |
| Q3 三季度报告 | `category_sjdbg_szsh` | `CNINFO_Q3_CATEGORY` |

The adapter already exposes `getLatestCninfoReport(company, "annual"|"quarterly")` returning the
PDF `sourceUrl` — i.e. **the fetch half is already shipped**. Filter titles to exclude
`英文`(English), `摘要`(summary), `已取消/更正/补充/提示`(cancelled/correction) to land the full
Chinese report.

---

## Build recommendation

| Rank | Build | Intent | Value | Effort | Notes |
|---|---|---|---|---|---|
| **1** | **CN `CompanyFinancials` — "latest periodic-report figures"** | CN financials (now ❌) | **High** | **M** | Resolve → `getLatestCninfoReport` (shipped) → `extractPdfText` (shipped) → **CN space-normalizer** → anchor on `主要会计数据` + `合并` statement headers → label lexicon + unit detection. Gate on `cjk===0`/`pages===undefined`/over-cap ⇒ link-only. Directly mirrors the HK #1 build; both source and extractor already ship. |
| **1a** | **`pdfText.ts` ObjStm / xref-stream decompression** (concurrent) | enables #1's hard case + every PDF adapter | **High** | **M** | The single corpus failure (Ping An) is ObjStm page/font packing — same class as HK's CKH. Fixing it in the shared extractor lifts CN mojibake issuers *and* US/GB/HK document reading. Do alongside #1. |
| **2** | **CN `CompanyOwners`** (前十名股东) | CN owners (now ❌) | **Med-High** | **M–L** | Data survives in 9/9 clean docs and is the *real* major-shareholder register (better than HK, where DI was walled). Ragged, issuer-variable columns ⇒ value-heuristic row parser; expect row-level error; degrade to link-only on the same signals. |
| **3** | **CN `CompanyInsiders`** (董监高) | CN insiders (now ❌) | **Med** | **M–L** | Same table machinery/caveats as #2; names+titles clean, dates fragment. |

**Single recommended build: #1 — CN `CompanyFinancials` via periodic-report extraction, with
the shared ObjStm upgrade (#1a).** It converts a hard ❌ into a real ✅ using **only the source
and extractor the repo already ships**, extraction quality is genuinely good for standard
issuers (8/9 annuals + bank + interim + quarterly), the number/label reality is now mapped, and
the one hard failure mode is **detectable and silent-safe once the `cjk===0` gate is added** —
so the mode never emits wrong numbers. Owners and Insiders are strong ⚠️ follow-ons: the data
is provably in the PDF and readable; they just need a ragged-table parser and honest row-level
degradation. The concurrent ObjStm upgrade is the highest-leverage enabler — it likely reclaims
the Ping An class outright.

### Reproduction

Scratch scripts (kept in `/tmp`, outside the repo): `/tmp/fetch_corpus.ts`,
`/tmp/fetch_extras.ts` (bun, import `src/core/pdfText.ts` directly), `/tmp/cncorpus/norm.py`
(space-collapse normalizer), `/tmp/cncorpus/assess.py`. Extracted text + PDFs in
`/tmp/cncorpus/`.
