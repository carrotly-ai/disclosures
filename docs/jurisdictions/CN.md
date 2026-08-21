# CN — cninfo

**Data source:** [cninfo](http://www.cninfo.com.cn/) (the CSRC-designated disclosure
portal), covering the Shanghai and Shenzhen exchanges plus an HKEX mirror.
**Credentials:** none. Resolution and the announcement feed use public POST endpoints.

## Accepted `company` inputs

A company name, a **6-digit A-share code**, or a **5-digit HK stock code**.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution across SSE, SZSE, and the HKEX mirror. |
| `CompanyFilings` | Date-filterable announcement feed with direct PDF links, including latest annual/quarterly periodic-report lookup. |
| `CompanyInsiders` | Unsupported — insider (董监高) data lives inside Chinese-language report PDFs this release does not parse. |
| `CompanyOwners` | Unsupported — shareholding (前十名股东) data lives inside report PDFs. |
| `CompanyFinancials` | **Bounded/best-effort** — headline figures extracted from the 主要会计数据 key-data table of the issuer's latest periodic-report PDF. |
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

## Caveats

- `CompanyFilings` returns real announcement PDF links; the insider/owner intents degrade
  honestly rather than parsing report PDFs.
- `CompanyFinancials` figures are the issuer's own as-published numbers (e.g. a
  revenue-recognition change can produce a large year-on-year swing) — treat them as read
  from the filing, not a normalized/adjusted series. Verified live on a 10-issuer corpus
  (main board, ChiNext, STAR, a bank in 千元, and an insurer in 百万元 — the last recovered by
  the object-stream upgrade).
