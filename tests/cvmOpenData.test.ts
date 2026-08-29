import { beforeEach, describe, expect, test } from "bun:test";
import {
  CVM_FINANCIAL_CONCEPT_NAMES,
  CVM_REGISTRATION_URL,
  CvmRateLimitError,
  dfpYearsToScan,
  freYearsToScan,
  getCvmFinancials,
  getCvmInsiders,
  getCvmOwners,
  ipeYearsForWindow,
  isCvmCode,
  maskCpf,
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

// --- FRE ownership + administrators ----------------------------------------

// Exact live column orders for the two FRE members this release parses.
const POSICAO_HEADER =
  "CNPJ_Companhia;Data_Referencia;Versao;ID_Documento;Nome_Companhia;ID_Acionista;" +
  "Acionista;Tipo_Pessoa_Acionista;CPF_CNPJ_Acionista;ID_Acionista_Relacionado;" +
  "Acionista_Relacionado;Tipo_Pessoa_Acionista_Relacionado;CPF_CNPJ_Acionista_Relacionado;" +
  "Quantidade_Acao_Ordinaria_Circulacao;Percentual_Acao_Ordinaria_Circulacao;" +
  "Quantidade_Acao_Preferencial_Circulacao;Percentual_Acao_Preferencial_Circulacao;" +
  "Quantidade_Total_Acoes_Circulacao;Percentual_Total_Acoes_Circulacao;Nacionalidade;" +
  "Sigla_UF;Residente_Exterior;Representante_Legal;Tipo_Pessoa_Representante_Legal;" +
  "CPF_CNPJ_Representante_legal;Data_Composicao_Capital_Social;Data_Ultima_Alteracao;" +
  "Acionista_Controlador;Participante_Acordo_Acionistas";

const ADMIN_HEADER =
  "CNPJ_Companhia;Data_Referencia;Versao;ID_Documento;Nome_Companhia;Orgao_Administracao;" +
  "Nome;CPF;Profissao;Cargo_Eletivo_Ocupado;Complemento_Cargo_Eletivo_Ocupado;Data_Eleicao;" +
  "Data_Posse;Data_Inicio_Primeiro_Mandato;Prazo_Mandato;Eleito_Controlador;Outro_Cargo_Funcao;" +
  "Experiencia_Profissional;Data_Nascimento;Numero_Mandatos_Consecutivos;" +
  "Percentual_Participacao_Reunioes";

/** Build one CSV line from a header + sparse column map (missing cols blank). */
function csvRow(header: string, values: Record<string, string>): string {
  return header.split(";").map((col) => values[col] ?? "").join(";");
}

const VALE = "33.592.510/0001-54";

function posRow(values: Record<string, string>): string {
  return csvRow(POSICAO_HEADER, {
    CNPJ_Companhia: VALE,
    Data_Referencia: "2025-12-31",
    Versao: "2",
    ...values,
  });
}

// Vale posição acionária: named holders (PJ + a PF to mask), aggregate rows, a
// golden PN share, a controlling bloc, a superseded version, an older reference
// date, a related-shareholder chain row, a duplicate, and a fully-zero row.
const POSICAO_2025 = [
  POSICAO_HEADER,
  // Latin-1 accents (Ê) prove the decoder; PJ holder, not the controller.
  posRow({
    Acionista: "PREVI - CAIXA DE PREVIDÊNCIA",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "33.754.482/0001-24",
    Percentual_Acao_Ordinaria_Circulacao: "7.650000",
    Percentual_Total_Acoes_Circulacao: "7.650000",
    Nacionalidade: "Brasil",
    Acionista_Controlador: "N",
    Participante_Acordo_Acionistas: "N",
  }),
  // Exact duplicate of PREVI — dedupe must collapse it.
  posRow({
    Acionista: "PREVI - CAIXA DE PREVIDÊNCIA",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "33.754.482/0001-24",
    Percentual_Acao_Ordinaria_Circulacao: "7.650000",
    Percentual_Total_Acoes_Circulacao: "7.650000",
    Nacionalidade: "Brasil",
    Acionista_Controlador: "N",
    Participante_Acordo_Acionistas: "N",
  }),
  // Corporate CNPJ placeholder (00.000.000/0000-00) → treated as no doc.
  posRow({
    Acionista: "BLACKROCK, INC.",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "00.000.000/0000-00",
    Percentual_Acao_Ordinaria_Circulacao: "6.708000",
    Percentual_Total_Acoes_Circulacao: "6.708000",
    Acionista_Controlador: "N",
    Participante_Acordo_Acionistas: "N",
  }),
  // Natural person → CPF middle digits must be masked.
  posRow({
    Acionista: "JOÃO DA SILVA",
    Tipo_Pessoa_Acionista: "PF",
    CPF_CNPJ_Acionista: "048.556.228-69",
    Percentual_Acao_Ordinaria_Circulacao: "3.000000",
    Percentual_Total_Acoes_Circulacao: "3.000000",
    Acionista_Controlador: "N",
    Participante_Acordo_Acionistas: "N",
  }),
  // Controlling bloc: both controlador and acordo de acionistas flags set.
  posRow({
    Acionista: "CONTROLADORA LTDA",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "12.345.678/0001-90",
    Percentual_Acao_Ordinaria_Circulacao: "50.000000",
    Percentual_Total_Acoes_Circulacao: "40.000000",
    Acionista_Controlador: "S",
    Participante_Acordo_Acionistas: "S",
  }),
  // Free-float aggregate row — kept, as filed.
  posRow({
    Acionista: "Outros",
    Percentual_Acao_Ordinaria_Circulacao: "43.342000",
    Percentual_Total_Acoes_Circulacao: "49.342000",
  }),
  // Golden PN share: ON 0, PN 100, total 0 — NOT all-zero, must be kept.
  posRow({
    Acionista: "GOVERNO FEDERAL",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "00.394.460/0001-41",
    Percentual_Acao_Ordinaria_Circulacao: "0.000000",
    Percentual_Acao_Preferencial_Circulacao: "100.000000",
    Percentual_Total_Acoes_Circulacao: "0.000000",
  }),
  // Fully-zero treasury padding row — must be dropped.
  posRow({
    Acionista: "Ações Tesouraria",
    Percentual_Acao_Ordinaria_Circulacao: "0.000000",
    Percentual_Acao_Preferencial_Circulacao: "0.000000",
    Percentual_Total_Acoes_Circulacao: "0.000000",
  }),
  // Related-shareholder chain row (Acionista_Relacionado set) — must be excluded
  // (its 100% is relative to the intermediary, not the issuer).
  posRow({
    Acionista: "UNIÃO FEDERAL",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "00.394.460/0409-50",
    ID_Acionista_Relacionado: "999",
    Acionista_Relacionado: "BNDES",
    Percentual_Acao_Ordinaria_Circulacao: "100.000000",
    Percentual_Total_Acoes_Circulacao: "100.000000",
  }),
  // Superseded older version (Versao 1) — must be ignored in favour of v2.
  posRow({
    Versao: "1",
    Acionista: "STALE HOLDER V1",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "11.111.111/0001-11",
    Percentual_Total_Acoes_Circulacao: "99.000000",
  }),
  // Older reference date — must be ignored in favour of 2025-12-31.
  posRow({
    Data_Referencia: "2024-12-31",
    Acionista: "STALE HOLDER OLD REF",
    Tipo_Pessoa_Acionista: "PJ",
    CPF_CNPJ_Acionista: "22.222.222/0001-22",
    Percentual_Total_Acoes_Circulacao: "88.000000",
  }),
  // A different company that a CNPJ filter must drop.
  csvRow(POSICAO_HEADER, {
    CNPJ_Companhia: "00.000.000/0001-91",
    Data_Referencia: "2025-12-31",
    Versao: "3",
    Acionista: "OTHER CO HOLDER",
    Tipo_Pessoa_Acionista: "PJ",
    Percentual_Total_Acoes_Circulacao: "77.000000",
  }),
].join("\n");

function admRow(values: Record<string, string>): string {
  return csvRow(ADMIN_HEADER, {
    CNPJ_Companhia: VALE,
    Data_Referencia: "2025-12-31",
    Versao: "2",
    ...values,
  });
}

const ADMIN_2025 = [
  ADMIN_HEADER,
  admRow({
    Orgao_Administracao: "Pertence apenas à Diretoria",
    Nome: "GUSTAVO DUARTE PIMENTA",
    CPF: "035.844.246-07",
    Profissao: "Engenheiro",
    Cargo_Eletivo_Ocupado: "10 - Diretor Presidente / Superintendente",
    Data_Eleicao: "2024-08-26",
    Prazo_Mandato: "31/05/2027",
    Eleito_Controlador: "N",
  }),
  admRow({
    Orgao_Administracao: "Pertence apenas ao Conselho de Administração",
    Nome: "DANIEL ANDRÉ STIELER",
    CPF: "391.145.110-53",
    Cargo_Eletivo_Ocupado: "20 - Presidente do Conselho de Administração",
    Data_Eleicao: "2025-04-30",
    Prazo_Mandato: "Até a realização da AGO de 2027",
    Eleito_Controlador: "S",
  }),
  admRow({
    Orgao_Administracao: "Conselho Fiscal",
    Nome: "RAPHAEL MANHÃES MARTINS",
    CPF: "096.952.607-56",
    Cargo_Eletivo_Ocupado: "42 - Pres. C.F.Eleito p/Minor.Ordinaristas",
    Data_Eleicao: "2026-04-30",
    Prazo_Mandato: "Até a AGO de 2027",
    Eleito_Controlador: "N",
  }),
  // The fourth live órgão value: a dual membership with no "apenas", whose
  // article must still be stripped and which must not sort as a plain board seat.
  admRow({
    Orgao_Administracao: "Pertence à Diretoria e ao Conselho de Administração",
    Nome: "BEATRIZ DUAL MEMBRO",
    CPF: "555.555.555-55",
    Cargo_Eletivo_Ocupado: "19 - Outros Diretores",
    Data_Eleicao: "2025-04-30",
    Prazo_Mandato: "26/05/2027",
    Eleito_Controlador: "N",
  }),
  // A superseded version — ignored.
  admRow({
    Versao: "1",
    Orgao_Administracao: "Pertence apenas à Diretoria",
    Nome: "STALE DIRECTOR V1",
    CPF: "000.000.000-00",
    Cargo_Eletivo_Ocupado: "19 - Outros Diretores",
  }),
  // Another company — dropped by the CNPJ filter.
  csvRow(ADMIN_HEADER, {
    CNPJ_Companhia: "00.000.000/0001-91",
    Data_Referencia: "2025-12-31",
    Versao: "1",
    Orgao_Administracao: "Conselho Fiscal",
    Nome: "OTHER CO DIRECTOR",
    CPF: "111.111.111-11",
  }),
].join("\n");

function freZip(year: number, posicao: string, admin: string): Uint8Array {
  return makeStoredZipMulti([
    { name: `fre_cia_aberta_posicao_acionaria_${year}.csv`, content: latin1Bytes(posicao) },
    // Sibling member the posicao filter must NOT grab; garbage if inflated.
    {
      name: `fre_cia_aberta_posicao_acionaria_classe_acao_${year}.csv`,
      content: "garbage;should;not;parse",
    },
    {
      name: `fre_cia_aberta_administrador_membro_conselho_fiscal_${year}.csv`,
      content: latin1Bytes(admin),
    },
    // Unrelated members the selective reader must skip without inflating.
    { name: `fre_cia_aberta_${year}.csv`, content: "noise-root-member" },
    { name: `fre_cia_aberta_auditor_${year}.csv`, content: "noise-auditor-member" },
  ]);
}

const fre2025Route: Route = {
  pattern: "fre_cia_aberta_2025.zip",
  body: freZip(2025, POSICAO_2025, ADMIN_2025),
};

describe("maskCpf", () => {
  test("masks a natural person's CPF middle digits, leaves other ids intact", () => {
    expect(maskCpf("048.556.228-69")).toBe("048.***.***-69");
    expect(maskCpf("04855622869")).toBe("048.***.***-69");
    // A 14-digit CNPJ is not an 11-digit CPF → returned unchanged.
    expect(maskCpf("33.754.482/0001-24")).toBe("33.754.482/0001-24");
    expect(maskCpf("")).toBe("");
  });
});

describe("freYearsToScan", () => {
  test("returns three years newest-first, floored at 2010", () => {
    expect(freYearsToScan(2026)).toEqual([2026, 2025, 2024]);
    expect(freYearsToScan(2011)).toEqual([2011, 2010]);
  });
});

describe("getCvmOwners", () => {
  test("parses direct holders, masks CPF, keeps ON/PN split and bloc flags", async () => {
    const fetchFn = routedFetch([registrationRoute, fre2025Route]);
    const { entity, owners, referenceDate, year } = await getCvmOwners(
      "Vale",
      options(fetchFn),
      2025,
    );
    expect(entity.cvmCode).toBe("4170");
    expect(referenceDate).toBe("2025-12-31");
    expect(year).toBe(2025);

    const names = owners.map((owner) => owner.holderName);
    // Sorted by total % desc: Outros 49.342, Controladora 40, Previ 7.65,
    // BlackRock 6.708, João 3, Governo 0 (golden PN).
    expect(names).toEqual([
      "Outros",
      "CONTROLADORA LTDA",
      "PREVI - CAIXA DE PREVIDÊNCIA", // Latin-1 Ê decoded
      "BLACKROCK, INC.",
      "JOÃO DA SILVA",
      "GOVERNO FEDERAL",
    ]);
    // Duplicate PREVI collapsed, treasury (all-zero) dropped, related-chain and
    // stale version/reference and other-company rows all excluded.
    expect(names).not.toContain("Ações Tesouraria");
    expect(names).not.toContain("UNIÃO FEDERAL");
    expect(names).not.toContain("STALE HOLDER V1");
    expect(names).not.toContain("STALE HOLDER OLD REF");
    expect(names).not.toContain("OTHER CO HOLDER");
    expect(names.filter((n) => n === "PREVI - CAIXA DE PREVIDÊNCIA")).toHaveLength(1);

    const previ = owners.find((owner) => owner.holderName.startsWith("PREVI"));
    expect(previ?.documentId).toBe("33.754.482/0001-24"); // CNPJ intact
    expect(previ?.personType).toBe("PJ");
    expect(previ?.pctOrdinary).toBe(7.65);
    expect(previ?.pctTotal).toBe(7.65);

    const joao = owners.find((owner) => owner.holderName === "JOÃO DA SILVA");
    expect(joao?.documentId).toBe("048.***.***-69"); // CPF middle masked
    expect(joao?.personType).toBe("PF");

    const blackrock = owners.find((owner) => owner.holderName === "BLACKROCK, INC.");
    expect(blackrock?.documentId).toBeUndefined(); // 00.000.000/0000-00 → no doc

    const bloc = owners.find((owner) => owner.holderName === "CONTROLADORA LTDA");
    expect(bloc?.isController).toBe(true);
    expect(bloc?.inShareholdersAgreement).toBe(true);
    expect(bloc?.pctOrdinary).toBe(50);
    expect(bloc?.pctTotal).toBe(40);

    const golden = owners.find((owner) => owner.holderName === "GOVERNO FEDERAL");
    expect(golden?.pctPreferred).toBe(100);
    expect(golden?.pctTotal).toBe(0);
  });

  test("falls back to the prior FRE year when the current lacks the company", async () => {
    const other = [
      POSICAO_HEADER,
      csvRow(POSICAO_HEADER, {
        CNPJ_Companhia: "00.000.000/0001-91",
        Data_Referencia: "2026-12-31",
        Versao: "1",
        Acionista: "SOMEONE ELSE",
        Percentual_Total_Acoes_Circulacao: "10.000000",
      }),
    ].join("\n");
    const fetchFn = routedFetch([
      registrationRoute,
      { pattern: "fre_cia_aberta_2026.zip", body: freZip(2026, other, ADMIN_HEADER) },
      fre2025Route,
    ]);
    const { owners, year } = await getCvmOwners("Vale", options(fetchFn), 2026);
    expect(year).toBe(2025);
    expect(owners.length).toBeGreaterThan(0);
  });

  test("caps at the top 25 holders by total percentage", async () => {
    const rows = [POSICAO_HEADER];
    for (let index = 0; index < 30; index += 1) {
      rows.push(posRow({
        Acionista: `HOLDER ${index}`,
        Tipo_Pessoa_Acionista: "PJ",
        CPF_CNPJ_Acionista: `10.000.000/00${String(index).padStart(2, "0")}-00`,
        Percentual_Total_Acoes_Circulacao: `${index + 1}.000000`,
      }));
    }
    const fetchFn = routedFetch([
      registrationRoute,
      { pattern: "fre_cia_aberta_2025.zip", body: freZip(2025, rows.join("\n"), ADMIN_HEADER) },
    ]);
    const { owners } = await getCvmOwners("Vale", options(fetchFn), 2025);
    expect(owners).toHaveLength(25);
    // The largest (HOLDER 29 at 30%) leads; the smallest kept is HOLDER 5 at 6%.
    expect(owners[0]?.holderName).toBe("HOLDER 29");
    expect(owners.at(-1)?.holderName).toBe("HOLDER 5");
  });

  test("returns an empty holder list honestly when the company has no FRE", async () => {
    const empty = [
      POSICAO_HEADER,
      csvRow(POSICAO_HEADER, {
        CNPJ_Companhia: "00.000.000/0001-91",
        Data_Referencia: "2025-12-31",
        Versao: "1",
        Acionista: "SOMEONE ELSE",
        Percentual_Total_Acoes_Circulacao: "5.000000",
      }),
    ].join("\n");
    const fetchFn = routedFetch([
      registrationRoute,
      { pattern: "fre_cia_aberta_2025.zip", body: freZip(2025, empty, ADMIN_HEADER) },
      { pattern: "fre_cia_aberta_2024.zip", body: freZip(2024, POSICAO_HEADER, ADMIN_HEADER) },
      { pattern: "fre_cia_aberta_2023.zip", body: freZip(2023, POSICAO_HEADER, ADMIN_HEADER) },
    ]);
    const { entity, owners } = await getCvmOwners("Vale", options(fetchFn), 2025);
    expect(entity.legalName).toBe("VALE S.A.");
    expect(owners).toEqual([]);
  });

  test("propagates an upstream failure", async () => {
    const fetchFn = routedFetch([
      registrationRoute,
      { pattern: "fre_cia_aberta_2025.zip", body: "boom", status: 500 },
    ]);
    await expect(getCvmOwners("Vale", options(fetchFn), 2025)).rejects.toBeTruthy();
  });
});

describe("getCvmInsiders", () => {
  test("parses administrators, normalizes órgão + cargo, sorts, keeps accents", async () => {
    const fetchFn = routedFetch([registrationRoute, fre2025Route]);
    const { entity, administrators, referenceDate, year } = await getCvmInsiders(
      "Vale",
      options(fetchFn),
      2025,
    );
    expect(entity.cvmCode).toBe("4170");
    expect(referenceDate).toBe("2025-12-31");
    expect(year).toBe(2025);

    // Sorted: board, dual membership, Diretoria, Conselho Fiscal.
    expect(administrators.map((admin) => admin.name)).toEqual([
      "DANIEL ANDRÉ STIELER", // accent decoded
      "BEATRIZ DUAL MEMBRO",
      "GUSTAVO DUARTE PIMENTA",
      "RAPHAEL MANHÃES MARTINS", // accent decoded
    ]);
    // Every "Pertence (apenas) à/ao" wrapper is stripped, including the dual
    // membership that carries no "apenas" — no dangling article survives.
    expect(administrators.map((admin) => admin.organ)).toEqual([
      "Conselho de Administração",
      "Diretoria e Conselho de Administração",
      "Diretoria",
      "Conselho Fiscal",
    ]);

    const chair = administrators[0];
    expect(chair?.role).toBe("Presidente do Conselho de Administração"); // NN- stripped
    expect(chair?.electionDate).toBe("2025-04-30");
    expect(chair?.term).toBe("Até a realização da AGO de 2027");
    expect(chair?.electedByController).toBe(true);

    const ceo = administrators.find((admin) => admin.name === "GUSTAVO DUARTE PIMENTA");
    expect(ceo?.role).toBe("Diretor Presidente / Superintendente");
    expect(ceo?.profession).toBe("Engenheiro");
    expect(ceo?.term).toBe("31/05/2027");

    // Stale version and the other company are excluded.
    expect(administrators.map((admin) => admin.name)).not.toContain("STALE DIRECTOR V1");
    expect(administrators.map((admin) => admin.name)).not.toContain("OTHER CO DIRECTOR");
  });

  test("returns an empty administrator list honestly when the company has no FRE", async () => {
    const fetchFn = routedFetch([
      registrationRoute,
      { pattern: "fre_cia_aberta_2025.zip", body: freZip(2025, POSICAO_HEADER, ADMIN_HEADER) },
      { pattern: "fre_cia_aberta_2024.zip", body: freZip(2024, POSICAO_HEADER, ADMIN_HEADER) },
      { pattern: "fre_cia_aberta_2023.zip", body: freZip(2023, POSICAO_HEADER, ADMIN_HEADER) },
    ]);
    const { administrators } = await getCvmInsiders("Vale", options(fetchFn), 2025);
    expect(administrators).toEqual([]);
  });

  test("propagates an upstream failure", async () => {
    const fetchFn = routedFetch([
      registrationRoute,
      { pattern: "fre_cia_aberta_2025.zip", body: "boom", status: 500 },
    ]);
    await expect(getCvmInsiders("Vale", options(fetchFn), 2025)).rejects.toBeTruthy();
  });
});
