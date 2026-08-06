# BR — CVM open data

**Data source:** [CVM open data](https://dados.cvm.gov.br/) (Comissão de Valores
Mobiliários) whole-market CSV/ZIP snapshots.
**Credentials:** none.

## Accepted `company` inputs

A company name or a **CVM registration code** (e.g. `4170` for Vale). The `CD_CVM` padding
gap between feeds is normalized (registration lists `4170`; DFP/IPE zero-pad to `004170`),
and the per-market-segment duplicate rows the registration feed ships are collapsed to one
entity per company.

## Supported intents

| Intent | Behaviour |
|---|---|
| `CompanyResolve` | Reads the CVM registration feed (`cad_cia_aberta`). |
| `CompanyFilings` | Per-year IPE disclosure index (2003+): category/species/subject rows with direct CVM RAD download links. |
| `CompanyInsiders` | Unsupported — CVM discloses officer data inside the Formulário de Referência, not parsed here. |
| `CompanyOwners` | Unsupported — relevant-holder data lives in the Formulário de Referência and CVM 44 filings, not parsed here. |
| `CompanyFinancials` | Annual DFP accounts: total assets, stockholders' equity, revenue, operating income, and net income in BRL (R$) by fiscal period end. Consolidated-when-filed, otherwise individual; `ESCALA_MOEDA` thousands scaling applied; a later restatement supersedes an earlier figure. |
| `PrivateRaises` | Unsupported — no Form D-equivalent dataset. |
| `OwnershipChain` | Global GLEIF — see the [index](README.md). |

## Implementation notes

- The CVM feeds are **Latin-1 (ISO-8859-1)** semicolon-delimited CSVs and are decoded
  accordingly.
- DFP year bundles are ZIPs whose filename uses the fiscal year but which ship in the
  following calendar year; only the balance-sheet/income-statement members are inflated.
- `ORDEM_EXERC = ÚLTIMO` selects the current fiscal year; the 14- vs 15-column shift
  between BPA/BPP and DRE members is handled by header-keyed parsing.

## Caveats

- Officer and relevant-holder disclosure requires parsing narrative Formulário de
  Referência / CVM 44 documents, which this release does not do — those intents degrade
  honestly.
