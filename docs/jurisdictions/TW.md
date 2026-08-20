# TW — TWSE OpenAPI

**Data source:** [TWSE OpenAPI](https://openapi.twse.com.tw/) whole-market open-data
snapshots (Taiwan Stock Exchange).
**Credentials:** none.

## Accepted `company` inputs

A company name or a **4-digit TWSE listing code**. The fetched whole-market datasets are
cached (6h default TTL) via the injectable `AdapterOptions.cache`. Republic-of-China
(`民國`) filing dates are converted to ISO.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Keyless resolution against the TWSE listing set. |
| `CompanyFilings` | Material-information announcements with clause/subject and a per-company profile link. |
| `CompanyInsiders` | Directors-and-supervisors register with current, at-election, and pledged share counts per holder. |
| `CompanyOwners` | >10% major shareholders, with an honest "no >10% holders reported" when the snapshot lists none. |
| `CompanyFinancials` | Latest-period headline totals (revenue, operating income, net income, total assets, total equity) in NT$, from the general-industry (一般業) statement snapshots. Finance/insurance-sector issuers are explained honestly (see below). |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## `CompanyFinancials` detail

Parsed from two general-industry whole-market snapshots — the comprehensive income
statement `t187ap06_L_ci` (綜合損益表) and the balance sheet `t187ap07_L_ci` (資產負債表).
The canonical concept set maps to the live columns:

| Concept | TWSE column | Statement |
|---|---|---|
| `revenue` | 營業收入 | comprehensive income |
| `operating_income` | 營業利益（損失） | comprehensive income |
| `net_income` | 本期淨利（淨損） | comprehensive income |
| `total_assets` | 資產總計 | balance sheet |
| `stockholders_equity` | 權益總計 | balance sheet |

- **Period coverage:** each dataset is the whole-market snapshot for the **single most
  recent reported period only** (year `年度` + quarter `季別` → period end). TWSE open data
  serves no historical statement archive — for prior periods or the full statements (notes,
  XBRL) use MOPS (mops.twse.com.tw). Income figures are **cumulative year-to-date** through
  the labelled quarter end; balance-sheet figures are **as-of** that date.
- **Units:** the feed reports NT$ thousands (仟元); values are scaled to whole NT$ and shown
  with the `NT$` symbol (unit `TWD`).
- **Financial-industry variants:** banks (銀行業), securities firms (證券業), insurers
  (保險業) and financial-holding companies (金控業) — 產業別 `17` — file the sector
  statement variants (`…_basi`/`_bd`/`_ins`/`_fh`), whose income statement reports net
  revenue (淨收益) with no 營業收入/營業利益 lines at all. This release parses only the
  general-industry (`_ci`) statements and degrades honestly for a sector issuer rather than
  force-fit a concept set its statements do not carry.

## Caveats

- The insider and owner feeds are whole-market snapshots filtered to the resolved company;
  they reflect the exchange's most recent published snapshot, not a real-time register.
