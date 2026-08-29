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
| `CompanyInsiders` | Administrator register from the latest **FRE (Formulário de Referência) item 12**: name, órgão (Diretoria / Conselho de Administração / Conselho Fiscal), elective post, election date, mandate term. A governance register, **not** a directors'-dealings feed. |
| `CompanyOwners` | Shareholder positions from the latest **FRE item 15 (posição acionária)**: holder, CPF/CNPJ, % ON / % PN / % total, and the issuer's controlador / acordo de acionistas marking. Top 25 by total %. |
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
- **FRE year bundles** (`fre_cia_aberta_YYYY.zip`, ~8 MB) hold ~36 member CSVs; only
  `fre_cia_aberta_posicao_acionaria_YYYY.csv` and
  `fre_cia_aberta_administrador_membro_conselho_fiscal_YYYY.csv` are inflated. The member
  filter matches on the full filename ending, so `posicao_acionaria` never picks up its
  `_classe_acao_` sibling.
- Despite its name, the `administrador_membro_conselho_fiscal` member carries **every**
  órgão, not just the Conselho Fiscal — `Orgao_Administracao` distinguishes them.
- The FRE members key on **`CNPJ_Companhia`**, not the `CD_CVM` used by DFP/IPE, so the
  resolved entity's CNPJ (from the registration feed) is the join key; it is compared
  digits-only so punctuation differences cannot break the match.
- A year bundle can hold **several document versions per company**. The newest
  `Data_Referencia` and, within it, the highest `Versao` are isolated before any row is
  surfaced, so a superseded filing never mixes into the current snapshot. Years are scanned
  newest-first (up to three) because companies file the FRE mid-year.
- Only **direct** holdings are surfaced. Rows carrying an `Acionista_Relacionado` describe
  that holder's own ownership chain and their percentages are relative to the intermediary,
  not the issuer — including them would misstate the cap table (e.g. Petrobras lists União
  Federal at 100% *of BNDES*, alongside its real 50.26% ON direct stake).

## Caveats

- FRE owners and insiders are the **annual as-filed snapshot**, not a live cap table or a
  real-time register: a holder who moved, or an administrator who left, after the filing
  still appears as filed. Intra-year 5% threshold movements (CVM 44 communications) are not
  folded in.
- Percentages are **as declared by the issuer**. Aggregate rows (`Outros` = free float,
  `Ações Tesouraria` = treasury) appear exactly as filed and are not netted out; a row
  reporting zero across every class is dropped as empty padding, but a golden PN share
  (ON 0 / PN 100 / total 0) is kept.
- **LGPD prudence:** a natural person's CPF is middle-masked (`048.***.***-69`) in
  `CompanyOwners`, and directors' CPFs are omitted entirely from `CompanyInsiders`.
  Corporate CNPJs identify a company, not a natural person, and are shown in full. CVM's
  placeholder document id `00.000.000/0000-00` (used for foreign holders such as BlackRock)
  is surfaced as no id rather than as a real number.
- The administrator register can list **the same person twice** within one snapshot when
  they held successive elective posts during the reference year (e.g. Vale's FRE 2026 shows
  one director as member from 2025-04-30 and as Chairman from 2026-07-22). Both rows are
  genuine as-filed history and are preserved rather than collapsed.
