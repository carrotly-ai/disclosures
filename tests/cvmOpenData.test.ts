import { beforeEach, describe, expect, test } from "bun:test";
import {
  CVM_FINANCIAL_CONCEPT_NAMES,
  CVM_REGISTRATION_URL,
  CvmRateLimitError,
  dfpYearsToScan,
  getCvmFinancials,
  ipeYearsForWindow,
  isCvmCode,
  normalizeCvmCode,
  parseCvmCsv,
  parseCvmCsvLine,
  resetCvmDatasetCache,
  resolveCvmCompany,
  searchCvmCompanies,
  searchCvmFilings,
} from "../src/adapters/cvmOpenData.js";
import { InMemoryCache } from "../src/core/cache.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";
import { latin1Bytes, makeStoredZipMulti } from "./helpers/zipFixture.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

// --- Fixtures --------------------------------------------------------------

// Registration feed (cad_cia_aberta.csv). CD_CVM is unpadded here (4170) while
// the disclosure/financial feeds zero-pad it (004170) — normalizeCvmCode must
// bridge the two. "Extração Mineral" carries Latin-1 accents to prove the
// decoder reproduces them from ISO-8859-1 bytes, not UTF-8.
// Vale appears twice with the same CD_CVM/CNPJ/name — once per market segment
// (TP_MERC, not modelled here) — exactly as the live feed ships it; dedupe must
// collapse the pair to a single entity.
const REGISTRATION_CSV =
  "CNPJ_CIA;DENOM_SOCIAL;DENOM_COMERC;SIT;CD_CVM;SETOR_ATIV;CATEG_REG\n" +
  "33.592.510/0001-54;VALE S.A.;VALE;ATIVO;4170;Extração Mineral;Categoria A\n" +
  "33.592.510/0001-54;VALE S.A.;VALE;ATIVO;4170;Extração Mineral;Categoria A\n" +
  "00.000.000/0001-91;BANCO DO BRASIL S.A.;BB;ATIVO;1023;Bancos;Categoria B\n";

const registrationRoute: Route = {
  pattern: "cad_cia_aberta.csv",
  body: latin1Bytes(REGISTRATION_CSV),
};

// IPE disclosure index for 2025. Vale is 004170 (padded); the second row is a
// different company that a code filter must drop.
const IPE_CSV =
  "CNPJ_Companhia;Nome_Companhia;Codigo_CVM;Data_Referencia;Categoria;Tipo;Especie;Assunto;Data_Entrega;Link_Download\n" +
  "33.592.510/0001-54;VALE;004170;2025-05-10;Fato Relevante;Comunicado;Fato Relevante;Aquisição de ativos;2025-05-10;https://www.rad.cvm.gov.br/ENET/frmDownloadDocumento.aspx?doc=1\n" +
  "00.000.000/0001-91;BB;001023;2025-06-01;Aviso;Comunicado;Aviso;Dividendos;2025-06-01;https://www.rad.cvm.gov.br/ENET/frmDownloadDocumento.aspx?doc=2\n";

const ipeRoute: Route = {
  pattern: "ipe_cia_aberta_2025.zip",
  body: makeStoredZipMulti([
    { name: "ipe_cia_aberta_2025.csv", content: latin1Bytes(IPE_CSV) },
  ]),
};

// DFP bundle for fiscal 2024. BPA has 14 columns (no DT_INI_EXERC); DRE has 15
// (with DT_INI_EXERC), so the account code sits in a different position — the
// header-keyed parser must still read CD_CONTA correctly from both.
const BPA_HEADER =
  "CNPJ_CIA;DT_REFER;VERSAO;DENOM_CIA;CD_CVM;GRUPO_DFP;MOEDA;ESCALA_MOEDA;ORDEM_EXERC;DT_FIM_EXERC;CD_CONTA;DS_CONTA;VL_CONTA;ST_CONTA_FIXA";
const DRE_HEADER =
  "CNPJ_CIA;DT_REFER;VERSAO;DENOM_CIA;CD_CVM;GRUPO_DFP;MOEDA;ESCALA_MOEDA;ORDEM_EXERC;DT_INI_EXERC;DT_FIM_EXERC;CD_CONTA;DS_CONTA;VL_CONTA;ST_CONTA_FIXA";

const BPA_CON =
  BPA_HEADER + "\n" +
  // Current-year consolidated total assets (in thousands → ×1000).
  "33.592.510/0001-54;2024-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;2024-12-31;1;Ativo Total;496325000.00;S\n" +
  // A PENÚLTIMO (prior-year) row that must be excluded.
  "33.592.510/0001-54;2024-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;PENÚLTIMO;2023-12-31;1;Ativo Total;480000000.00;S\n";

// Individual (unconsolidated) BPA with a different value — consolidated must win.
const BPA_IND =
  BPA_HEADER + "\n" +
  "33.592.510/0001-54;2024-12-31;1;VALE S.A.;004170;DF Individual;Real;MIL;ÚLTIMO;2024-12-31;1;Ativo Total;400000000.00;S\n";

const BPP_CON =
  BPA_HEADER + "\n" +
  "33.592.510/0001-54;2024-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;2024-12-31;2.03;Patrimônio Líquido Consolidado;250000000.00;S\n";

const DRE_CON =
  DRE_HEADER + "\n" +
  "33.592.510/0001-54;2024-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;2024-01-01;2024-12-31;3.01;Receita de Venda de Bens e/ou Serviços;206005000.00;S\n" +
  "33.592.510/0001-54;2024-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;2024-01-01;2024-12-31;3.05;Resultado Antes do Resultado Financeiro e dos Tributos;55459000.00;S\n" +
  "33.592.510/0001-54;2024-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;2024-01-01;2024-12-31;3.11;Lucro/Prejuízo Consolidado do Período;30431000.00;S\n";

const dfpRoute: Route = {
  pattern: "dfp_cia_aberta_2024.zip",
  body: makeStoredZipMulti([
    { name: "dfp_cia_aberta_BPA_con_2024.csv", content: latin1Bytes(BPA_CON) },
    { name: "dfp_cia_aberta_BPA_ind_2024.csv", content: latin1Bytes(BPA_IND) },
    { name: "dfp_cia_aberta_BPP_con_2024.csv", content: latin1Bytes(BPP_CON) },
    { name: "dfp_cia_aberta_DRE_con_2024.csv", content: latin1Bytes(DRE_CON) },
    // A member outside the wanted set: the reader's filter must not inflate it.
    { name: "dfp_cia_aberta_DVA_con_2024.csv", content: "garbage-should-be-skipped" },
  ]),
};

beforeEach(() => {
  resetRateLimiters();
  resetCvmDatasetCache();
});

// --- Pure helpers ----------------------------------------------------------

describe("CSV and code helpers", () => {
  test("parseCvmCsvLine splits on semicolons and trims, honoring quotes", () => {
    expect(parseCvmCsvLine("A;B;C")).toEqual(["A", "B", "C"]);
    expect(parseCvmCsvLine(' a ; b ')).toEqual(["a", "b"]);
    expect(parseCvmCsvLine('"x;y";z')).toEqual(["x;y", "z"]);
  });

  test("parseCvmCsv builds header-keyed rows and skips blank lines", () => {
    const rows = parseCvmCsv("H1;H2\n1;2\n\n3;4\n");
    expect(rows).toEqual([
      { H1: "1", H2: "2" },
      { H1: "3", H2: "4" },
    ]);
  });

  test("normalizeCvmCode strips leading zeros; isCvmCode gates numeric queries", () => {
    expect(normalizeCvmCode("004170")).toBe("4170");
    expect(normalizeCvmCode("4170")).toBe("4170");
    expect(normalizeCvmCode("VALE")).toBeUndefined();
    expect(isCvmCode("4170")).toBe(true);
    expect(isCvmCode("VALE")).toBe(false);
  });

  test("ipeYearsForWindow and dfpYearsToScan bound the year fan-out", () => {
    expect(ipeYearsForWindow(undefined, undefined, 2025)).toEqual([2025]);
    expect(ipeYearsForWindow("2022-01-01", "2024-12-31", 2025)).toEqual([2024, 2023, 2022]);
    expect(dfpYearsToScan(2026, 2)).toEqual([2025, 2024]);
    expect(dfpYearsToScan(2026, 1)).toEqual([2025]);
  });
});

// --- Resolution ------------------------------------------------------------

describe("searchCvmCompanies", () => {
  test("resolves an exact CVM code (normalizing the padding gap)", async () => {
    const fetchFn = routedFetch([registrationRoute]);
    const results = await searchCvmCompanies("4170", options(fetchFn));
    expect(results).toHaveLength(1);
    const vale = results[0];
    expect(vale?.legalName).toBe("VALE S.A.");
    expect(vale?.cvmCode).toBe("4170");
    expect(vale?.jurisdiction).toBe("BR");
    expect(vale?.source).toBe("CVM");
    expect(vale?.status).toContain("Extração Mineral"); // Latin-1 decoded
    expect(vale?.matchReason).toBe("Exact CVM-code match");
    expect(vale?.sourceIdentifiers?.companyNumber).toBe("33.592.510/0001-54");
  });

  test("ranks a name query and drops non-matches", async () => {
    const fetchFn = routedFetch([registrationRoute]);
    const results = await searchCvmCompanies("Vale", options(fetchFn));
    expect(results.map((entity) => entity.legalName)).toEqual(["VALE S.A."]);
  });

  test("resolveCvmCompany returns the top hit or null", async () => {
    const fetchFn = routedFetch([registrationRoute]);
    expect((await resolveCvmCompany("Banco do Brasil", options(fetchFn)))?.cvmCode).toBe("1023");
    resetCvmDatasetCache();
    const fetch2 = routedFetch([registrationRoute]);
    expect(await resolveCvmCompany("nonexistent-company", options(fetch2))).toBeNull();
  });

  test("returns nothing for a blank query without a network call", async () => {
    const fetchFn = routedFetch([registrationRoute]);
    expect(await searchCvmCompanies("   ", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });
});

// --- IPE disclosures -------------------------------------------------------

describe("searchCvmFilings", () => {
  test("filters IPE rows to the resolved company with real download links", async () => {
    const fetchFn = routedFetch([registrationRoute, ipeRoute]);
    const filings = await searchCvmFilings("Vale", options(fetchFn), 2025);
    expect(filings).toHaveLength(1);
    const filing = filings[0];
    expect(filing?.filedDate).toBe("2025-05-10");
    expect(filing?.form).toBe("Fato Relevante — Comunicado");
    expect(filing?.category).toBe("Fato Relevante");
    expect(filing?.description).toBe("Aquisição de ativos");
    expect(filing?.sourceUrl).toContain("rad.cvm.gov.br");
    expect(filing?.source).toBe("CVM");
  });

  test("applies a case-insensitive form filter", async () => {
    const fetchFn = routedFetch([registrationRoute, ipeRoute]);
    const none = await searchCvmFilings(
      { company: "Vale", forms: ["nonexistent"] },
      options(fetchFn),
      2025,
    );
    expect(none).toHaveLength(0);
  });
});

// --- DFP financials --------------------------------------------------------

describe("getCvmFinancials", () => {
  test("returns all five concepts, prefers consolidated, and scales MIL", async () => {
    const fetchFn = routedFetch([registrationRoute, dfpRoute]);
    const facts = await getCvmFinancials(
      { company: "Vale", periods: 1 },
      options(fetchFn),
      2025,
    );
    const byConcept = new Map(facts.map((fact) => [fact.concept, fact]));
    expect([...byConcept.keys()].sort()).toEqual([...CVM_FINANCIAL_CONCEPT_NAMES].sort());

    const assets = byConcept.get("total_assets");
    // Consolidated (496325000) wins over individual (400000000), scaled ×1000.
    expect(assets?.value).toBe(496_325_000_000);
    expect(assets?.basis).toBe("consolidated");
    expect(assets?.unit).toBe("BRL");
    expect(assets?.label).toBe("Ativo Total");
    expect(assets?.periodEnd).toBe("2024-12-31");

    // DRE lines are read despite the shifted account-code column position.
    expect(byConcept.get("revenue")?.value).toBe(206_005_000_000);
    expect(byConcept.get("net_income")?.label).toBe("Lucro/Prejuízo Consolidado do Período");
    expect(byConcept.get("net_income")?.value).toBe(30_431_000_000);
  });

  test("honors a concept subset", async () => {
    const fetchFn = routedFetch([registrationRoute, dfpRoute]);
    const facts = await getCvmFinancials(
      { company: "Vale", concepts: ["revenue"], periods: 1 },
      options(fetchFn),
      2025,
    );
    expect(facts.map((fact) => fact.concept)).toEqual(["revenue"]);
  });
});

// --- Caching and rate limiting --------------------------------------------

describe("caching and rate limiting", () => {
  test("serves the registration feed from the injected cache without refetching", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch([registrationRoute]);
    await searchCvmCompanies("Vale", { fetchFn, cache });
    resetCvmDatasetCache();
    await searchCvmCompanies("Banco do Brasil", { fetchFn, cache });
    const registrationCalls = fetchFn.requests.filter((request) =>
      request.url.includes("cad_cia_aberta.csv"),
    ).length;
    expect(registrationCalls).toBe(1);
  });

  test("maps an HTTP 429 to CvmRateLimitError", async () => {
    const fetchFn = routedFetch([
      { pattern: CVM_REGISTRATION_URL, body: "rate limited", status: 429 },
    ]);
    await expect(searchCvmCompanies("Vale", options(fetchFn))).rejects.toBeInstanceOf(
      CvmRateLimitError,
    );
  });
});
