import { beforeEach, describe, expect, test } from "bun:test";
import {
  INFO_FINANCIERE_OWNER_PLACEHOLDER,
  INFO_FINANCIERE_OWNERS_PARSE_CAP,
  InfoFinanciereApiError,
  InfoFinanciereRateLimitError,
  escapeOdsqlString,
  getInfoFinanciereDocumentSize,
  getInfoFinanciereOwners,
  getInfoFinancierePdf,
  odsqlLiteral,
  parseThresholdCrossing,
  resolveInfoFinanciereDocument,
  searchInfoFinanciereCompanies,
  searchInfoFinanciereFilings,
} from "../src/adapters/infoFinanciere.js";
import { infoFinanciereRateLimiter, resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { buildFrenchTextPdf } from "./helpers/pdfFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

/** The decoded `where`/`limit`/etc. query param of the first recorded request. */
function paramOf(fetchFn: ReturnType<typeof routedFetch>, name: string): string {
  return new URL(fetchFn.requests[0]?.url ?? "").searchParams.get(name) ?? "";
}

const PDF_URL =
  "https://fr.ftp.opendatasoft.com/datadila/INFOFI/BWR/2026/08/FCBWR169110_20260818.pdf";

const tteRecords = {
  total_count: 1746,
  results: [
    {
      uin_idt_uin: "169110_20260818",
      identificationsociete_iso_nom_soc: "TOTALENERGIES SE",
      identificationsociete_iso_cd_isi: "FR0000120271",
      identificationsociete_iso_cd_lei: "529900S21EQ1BO4ESM68",
      identificationsociete_iso_pay_ss: "FR",
      informationdeposee_inf_dat_emt: "2026-08-18T06:00:00+00:00",
      informationdeposee_inf_tit_inf:
        "Acquisition ou cession des actions de l'émetteur / Transactions sur actions propres (version agrégée)",
      sous_type_d_information: "Acquisition ou cession des actions de l'émetteur",
      subtype_of_information: "Acquisition or disposal of the issuer's own shares",
      type_d_information: "Informations réglementées continues",
      type_of_information: "Ongoing regulated information",
      url_de_recuperation: PDF_URL,
    },
    {
      uin_idt_uin: "154327_20240103",
      identificationsociete_iso_nom_soc: "TOTALENERGIES SE",
      identificationsociete_iso_cd_isi: "FR0000120271",
      identificationsociete_iso_cd_lei: "529900S21EQ1BO4ESM68",
      informationdeposee_inf_dat_emt: "2024-01-03T07:00:00+00:00",
      informationdeposee_inf_tit_inf: "Information privilégiée",
      sous_type_d_information: "Informations privilégiées",
      subtype_of_information: "Inside Information",
      url_de_recuperation:
        "https://fr.ftp.opendatasoft.com/datadila/INFOFI/BWR/2024/01/FCBWR154327_20240103.pdf",
    },
  ],
};

const dbvThreshold = {
  total_count: 91,
  results: [
    {
      uin_idt_uin: "642623_20260817",
      identificationsociete_iso_nom_soc: "DBV TECHNOLOGIES",
      identificationsociete_iso_cd_isi: "FR0010417345",
      informationdeposee_inf_dat_emt: "2026-08-17T06:00:00+00:00",
      informationdeposee_inf_tit_inf: "Franchissements de seuils et déclaration d'intention",
      sous_type_d_information: "Décision de franchissement de seuil",
      subtype_of_information: "Threshold crossing",
      url_de_recuperation:
        "https://fr.ftp.opendatasoft.com/datadila/INFOFI/307/8888/01/FC307642623_20260817.pdf",
    },
  ],
};

const emptyRecords = { total_count: 0, results: [] };

// A byte body that countPdfPages recognises as a one-page PDF.
const fakePdf = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n%%EOF",
);

const nameRoute: Route = { pattern: /records\?.*nom_soc\+like/, body: tteRecords };
const isinRoute: Route = { pattern: /records\?.*cd_isi/, body: tteRecords };
const leiRoute: Route = { pattern: /records\?.*cd_lei/, body: tteRecords };
const thresholdRoute: Route = { pattern: /franchissement/, body: dbvThreshold };
const recordIdRoute: Route = {
  pattern: /uin_idt_uin%3D/,
  body: { total_count: 1, results: [tteRecords.results[0]] },
};

beforeEach(() => {
  resetRateLimiters();
});

describe("ODSQL literal escaping", () => {
  test("escapes single quotes and backslashes so input cannot break the clause", () => {
    expect(escapeOdsqlString("L'Oréal")).toBe("L\\'Oréal");
    expect(escapeOdsqlString("a\\b")).toBe("a\\\\b");
    expect(escapeOdsqlString("x' OR 1=1 --")).toBe("x\\' OR 1=1 --");
    expect(odsqlLiteral("L'Oréal")).toBe("'L\\'Oréal'");
    // A backslash before a quote is escaped in order (backslash first).
    expect(odsqlLiteral("\\'")).toBe("'\\\\\\''");
  });
});

describe("searchInfoFinanciereCompanies", () => {
  test("resolves by name and collapses duplicate records to one issuer", async () => {
    const fetchFn = routedFetch([nameRoute]);
    const results = await searchInfoFinanciereCompanies("TotalEnergies", options(fetchFn));
    expect(results.length).toBe(1);
    expect(results[0]?.legalName).toBe("TOTALENERGIES SE");
    expect(results[0]?.isin).toBe("FR0000120271");
    expect(results[0]?.lei).toBe("529900S21EQ1BO4ESM68");
    expect(results[0]?.jurisdiction).toBe("FR");
    expect(results[0]?.source).toBe("info-financiere");
    expect(results[0]?.sourceIdentifiers?.isin).toBe("FR0000120271");
  });

  test("an ISIN query hits the ISIN identity field, not a name like", async () => {
    const fetchFn = routedFetch([isinRoute]);
    const results = await searchInfoFinanciereCompanies("FR0000120271", options(fetchFn));
    expect(results[0]?.isin).toBe("FR0000120271");
    expect(paramOf(fetchFn, "where")).toContain("identificationsociete_iso_cd_isi='FR0000120271'");
  });

  test("a LEI query hits the LEI identity field", async () => {
    const fetchFn = routedFetch([leiRoute]);
    await searchInfoFinanciereCompanies("529900S21EQ1BO4ESM68", options(fetchFn));
    expect(paramOf(fetchFn, "where")).toContain("identificationsociete_iso_cd_lei='529900S21EQ1BO4ESM68'");
  });

  test("empty upstream returns no candidates", async () => {
    const fetchFn = routedFetch([{ pattern: "records", body: emptyRecords }]);
    expect(await searchInfoFinanciereCompanies("Nonexistent SA", options(fetchFn))).toEqual([]);
  });
});

describe("searchInfoFinanciereFilings", () => {
  test("maps records to filings with FR+EN subtype, id, and PDF url", async () => {
    const fetchFn = routedFetch([nameRoute]);
    const filings = await searchInfoFinanciereFilings({ company: "TotalEnergies" }, options(fetchFn));
    expect(filings.length).toBe(2);
    const first = filings[0];
    expect(first?.filedDate).toBe("2026-08-18");
    expect(first?.form).toBe("Acquisition ou cession des actions de l'émetteur");
    expect(first?.category).toBe("Acquisition or disposal of the issuer's own shares");
    expect(first?.accession).toBe("169110_20260818");
    expect(first?.sourceUrl).toBe(PDF_URL);
    expect(first?.source).toBe("info-financiere");
  });

  test("a date window and limit are pushed into the ODSQL where/limit", async () => {
    const fetchFn = routedFetch([nameRoute]);
    await searchInfoFinanciereFilings(
      { company: "TotalEnergies", startDate: "2026-01-01", endDate: "2026-08-18", limit: 5 },
      options(fetchFn),
    );
    const where = paramOf(fetchFn, "where");
    expect(where).toContain("informationdeposee_inf_dat_emt >= '2026-01-01'");
    expect(where).toContain("informationdeposee_inf_dat_emt <= '2026-08-18T23:59:59Z'");
    expect(paramOf(fetchFn, "limit")).toBe("5");
  });

  test("a company name with an apostrophe is escaped, not injected", async () => {
    const fetchFn = routedFetch([{ pattern: "records", body: tteRecords }]);
    await searchInfoFinanciereFilings({ company: "L'Oréal" }, options(fetchFn));
    // The apostrophe is backslash-escaped inside a single-quoted literal, so the
    // where clause stays one string and the injection attempt is inert.
    expect(paramOf(fetchFn, "where")).toContain("identificationsociete_iso_nom_soc like 'L\\'Oréal'");
  });
});

describe("getInfoFinanciereOwners", () => {
  test("returns threshold-crossing notifications with holder in the linked PDF", async () => {
    const fetchFn = routedFetch([thresholdRoute]);
    const owners = await getInfoFinanciereOwners("DBV Technologies", options(fetchFn));
    expect(owners.length).toBe(1);
    const owner = owners[0];
    expect(owner?.holderName).toBe(INFO_FINANCIERE_OWNER_PLACEHOLDER);
    expect(owner?.pct).toBeUndefined();
    expect(owner?.form).toBe("Décision de franchissement de seuil");
    expect(owner?.naturesOfControl).toEqual([
      "Franchissements de seuils et déclaration d'intention",
    ]);
    expect(owner?.thresholdRegime).toContain("franchissement de seuil");
    expect(owner?.accession).toBe("642623_20260817");
    // The query is scoped to the threshold subtype.
    expect(paramOf(fetchFn, "where")).toContain("sous_type_d_information='Décision de franchissement de seuil'");
  });

  test("no threshold notifications returns an empty list", async () => {
    const fetchFn = routedFetch([{ pattern: "records", body: emptyRecords }]);
    expect(await getInfoFinanciereOwners("Some Issuer", options(fetchFn))).toEqual([]);
  });
});

// Realistic AMF notification prose, modelled on the live corpus (DBV / TTE /
// LVMH). A single Tj literal — the extractor still fragments it far less than a
// real positioned-text PDF, but the parser regexes are the same.
const NOTIF_HAUSSE_SPLIT =
  "DBV TECHNOLOGIES (Euronext Paris) 1. Par courrier reçu le 13 août 2026, " +
  "la société Acme Capital Management (200 rue de Rivoli, 75001 Paris) a déclaré " +
  "avoir franchi en hausse, le 7 août 2026, indirectement par l'intermédiaire des " +
  "sociétés qu'elle contrôle, les seuils de 10% du capital et des droits de vote " +
  "de la société DBV TECHNOLOGIES et détenir, à cette date, 33 025 522 actions " +
  "DBV TECHNOLOGIES représentant 40 000 000 droits de vote, soit 11,15% du capital " +
  "et 12,50% des droits de vote de cette société.";
const NOTIF_HAUSSE_COMBINED =
  "TOTALENERGIES SE (Euronext Paris) Par courrier reçu le 15 avril 2026, la " +
  "société The Capital Group Companies, Inc. (333 South Hope Street, Los Angeles) " +
  "a déclaré avoir franchi en hausse, le 13 avril 2026, les seuils de 5% du " +
  "capital et des droits de vote de la société TOTALENERGIES SE et détenir " +
  "111 573 985 actions TOTALENERGIES SE représentant autant de droits de vote, " +
  "soit 5,10% du capital et des droits de vote de cette société.";
const NOTIF_BAISSE =
  "TOTALENERGIES SE (Euronext Paris) Par courrier reçu le 18 juin 2026, la " +
  "société Amundi Asset Management (91 boulevard Pasteur, 75015 Paris) a déclaré " +
  "avoir franchi en baisse, le 18 juin 2026, les seuils de 5% du capital et des " +
  "droits de vote de la société TOTALENERGIES SE et détenir 112 785 377 actions, " +
  "soit 4,96% du capital et des droits de vote de cette société.";
// Threshold + direction present, but no resulting "soit N%" clause.
const NOTIF_PARTIAL =
  "ACME SA (Euronext Paris) Par courrier reçu le 2 mars 2026, la société " +
  "Bidco Holdings (10 Downing Street, Londres) a déclaré avoir franchi en hausse, " +
  "le 1 mars 2026, les seuils de 15% du capital et des droits de vote de la " +
  "société ACME SA. Les précisions chiffrées figurent dans le tableau annexé.";

describe("parseThresholdCrossing", () => {
  test("full parse: hausse, holder, date, threshold, distinct capital/voting %", () => {
    const c = parseThresholdCrossing(NOTIF_HAUSSE_SPLIT);
    expect(c.direction).toBe("up");
    expect(c.holderName).toBe("Acme Capital Management");
    expect(c.crossingDate).toBe("2026-08-07");
    expect(c.thresholdsCrossed).toEqual(["10%"]);
    expect(c.pctCapital).toBe(11.15);
    expect(c.pctVotingRights).toBe(12.5);
  });

  test("combined 'du capital et des droits de vote' sets both percentages equal", () => {
    const c = parseThresholdCrossing(NOTIF_HAUSSE_COMBINED);
    expect(c.direction).toBe("up");
    expect(c.holderName).toBe("The Capital Group Companies, Inc.");
    expect(c.pctCapital).toBe(5.1);
    expect(c.pctVotingRights).toBe(5.1);
  });

  test("baisse direction is detected", () => {
    const c = parseThresholdCrossing(NOTIF_BAISSE);
    expect(c.direction).toBe("down");
    expect(c.crossingDate).toBe("2026-06-18");
    expect(c.pctCapital).toBe(4.96);
  });

  test("French comma decimals are normalized to JS numbers", () => {
    const c = parseThresholdCrossing(NOTIF_HAUSSE_SPLIT);
    expect(c.pctCapital).toBeCloseTo(11.15, 5);
    expect(c.pctVotingRights).toBeCloseTo(12.5, 5);
  });

  test("multiple thresholds crossed at once are all captured, including fractions", () => {
    const text =
      "Par courrier reçu le 6 décembre 2022, la société Christian Dior a déclaré " +
      "avoir franchi en hausse, le 6 décembre 2022, les seuils de 5%, 10%, 15%, " +
      "20%, 25%, 30%, 1/3, 50%, 2/3, 90% et 95% du capital et des droits de vote de " +
      "la société LVMH et détenir 1 actions, soit 97,50% du capital et 98,37% des " +
      "droits de vote de cette société.";
    const c = parseThresholdCrossing(text);
    expect(c.thresholdsCrossed).toEqual([
      "5%", "10%", "15%", "20%", "25%", "30%", "1/3", "50%", "2/3", "90%", "95%",
    ]);
    expect(c.pctCapital).toBe(97.5);
    expect(c.pctVotingRights).toBe(98.37);
  });

  test("partial parse: threshold present but no resulting % leaves percentages unset", () => {
    const c = parseThresholdCrossing(NOTIF_PARTIAL);
    expect(c.direction).toBe("up");
    expect(c.thresholdsCrossed).toEqual(["15%"]);
    expect(c.pctCapital).toBeUndefined();
    expect(c.pctVotingRights).toBeUndefined();
  });

  test("non-standard text yields an empty object (never guesses)", () => {
    expect(parseThresholdCrossing("")).toEqual({});
    expect(parseThresholdCrossing(
      "This annual report contains no threshold-crossing declaration language.",
    )).toEqual({});
  });
});

describe("getInfoFinanciereOwners best-effort PDF extraction", () => {
  function thresholdRecords(count: number) {
    return {
      total_count: count,
      results: Array.from({ length: count }, (_, i) => ({
        uin_idt_uin: `6400${i}_2026081${i}`,
        identificationsociete_iso_nom_soc: "DBV TECHNOLOGIES",
        identificationsociete_iso_cd_isi: "FR0010417345",
        informationdeposee_inf_dat_emt: `2026-08-1${i}T06:00:00+00:00`,
        informationdeposee_inf_tit_inf: "Franchissements de seuils",
        sous_type_d_information: "Décision de franchissement de seuil",
        url_de_recuperation:
          `https://fr.ftp.opendatasoft.com/datadila/INFOFI/307/FC30764${i}_2026081${i}.pdf`,
      })),
    };
  }

  test("parses the newest notification's PDF into structured owner fields", async () => {
    const fetchFn = routedFetch([
      { pattern: /records/, body: thresholdRecords(1) },
      { pattern: /opendatasoft\.com/, body: buildFrenchTextPdf(NOTIF_HAUSSE_SPLIT) },
    ]);
    const owners = await getInfoFinanciereOwners("DBV Technologies", options(fetchFn));
    const o = owners[0]!;
    expect(o.machineReadable).toBe(true);
    expect(o.holderName).toBe("Acme Capital Management");
    expect(o.crossingDirection).toBe("up");
    expect(o.crossingDate).toBe("2026-08-07");
    expect(o.thresholdsCrossed).toEqual(["10%"]);
    expect(o.pctCapital).toBe(11.15);
    expect(o.pct).toBe(11.15);
    expect(o.pctVotingRights).toBe(12.5);
  });

  test("caps PDF downloads at the newest INFO_FINANCIERE_OWNERS_PARSE_CAP", async () => {
    const fetchFn = routedFetch([
      { pattern: /records/, body: thresholdRecords(6) },
      { pattern: /opendatasoft\.com/, body: buildFrenchTextPdf(NOTIF_BAISSE) },
    ]);
    const owners = await getInfoFinanciereOwners("DBV Technologies", options(fetchFn));
    expect(owners.length).toBe(6);
    const pdfRequests = fetchFn.requests.filter((r) => new URL(r.url).host.endsWith(".opendatasoft.com"));
    expect(pdfRequests.length).toBe(INFO_FINANCIERE_OWNERS_PARSE_CAP);
    // The 6th (beyond the cap) is untouched — link-only.
    expect(owners[5]?.machineReadable).toBeUndefined();
    expect(owners[5]?.holderName).toBe(INFO_FINANCIERE_OWNER_PLACEHOLDER);
    // The first five were parsed.
    expect(owners[0]?.machineReadable).toBe(true);
    expect(owners[4]?.machineReadable).toBe(true);
  });

  test("a PDF with no standard crossing prose stays an honest link-only row", async () => {
    const fetchFn = routedFetch([
      { pattern: /records/, body: thresholdRecords(1) },
      {
        pattern: /opendatasoft\.com/,
        body: buildFrenchTextPdf("Communiqué de presse sans langage de franchissement."),
      },
    ]);
    const owners = await getInfoFinanciereOwners("DBV Technologies", options(fetchFn));
    // Attempted (within cap) but nothing parsed → false, distinct from a
    // beyond-cap row which stays undefined.
    expect(owners[0]?.machineReadable).toBe(false);
    expect(owners[0]?.holderName).toBe(INFO_FINANCIERE_OWNER_PLACEHOLDER);
    expect(owners[0]?.pctCapital).toBeUndefined();
  });
});

describe("CompanyDocument (FR)", () => {
  test("resolves a record id to its OAM record via a query", async () => {
    const fetchFn = routedFetch([recordIdRoute]);
    const record = await resolveInfoFinanciereDocument("169110_20260818", options(fetchFn));
    expect(record.issuerName).toBe("TOTALENERGIES SE");
    expect(record.pdfUrl).toBe(PDF_URL);
    expect(paramOf(fetchFn, "where")).toContain("uin_idt_uin='169110_20260818'");
  });

  test("accepts a full OAM PDF URL without a network round trip", async () => {
    const fetchFn = routedFetch([]);
    const record = await resolveInfoFinanciereDocument(PDF_URL, options(fetchFn));
    expect(record.pdfUrl).toBe(PDF_URL);
    expect(fetchFn.requests.length).toBe(0);
  });

  test("rejects a transaction id that is neither a record id nor an OAM URL", async () => {
    const fetchFn = routedFetch([]);
    await expect(
      resolveInfoFinanciereDocument("../etc/passwd", options(fetchFn)),
    ).rejects.toThrow(InfoFinanciereApiError);
    expect(fetchFn.requests.length).toBe(0);
  });

  test("downloads a PDF and reports bytes + page count", async () => {
    const fetchFn = routedFetch([
      { pattern: ".pdf", body: fakePdf, headers: { "Content-Type": "application/pdf" } },
    ]);
    const pdf = await getInfoFinancierePdf(PDF_URL, options(fetchFn));
    expect(pdf.byteLength).toBe(fakePdf.byteLength);
    expect(pdf.pageCount).toBe(1);
    expect(pdf.suggestedFilename).toBe("FCBWR169110_20260818.pdf");
  });

  test("refuses to download from a non-OAM host", async () => {
    const fetchFn = routedFetch([]);
    await expect(
      getInfoFinancierePdf("https://evil.example.com/x.pdf", options(fetchFn)),
    ).rejects.toThrow(InfoFinanciereApiError);
    expect(fetchFn.requests.length).toBe(0);
  });

  test("metadata size is parsed from a ranged-GET content-range header", async () => {
    const fetchFn = routedFetch([
      {
        pattern: ".pdf",
        body: "x",
        status: 206,
        headers: { "Content-Range": "bytes 0-0/240709" },
      },
    ]);
    const size = await getInfoFinanciereDocumentSize(PDF_URL, options(fetchFn));
    expect(size).toBe(240709);
    const init = fetchFn.requests[0]?.init as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)?.Range).toBe("bytes=0-0");
  });
});

describe("failure and rate limiting", () => {
  test("an upstream 500 propagates", async () => {
    const fetchFn = routedFetch([{ pattern: "records", body: "boom", status: 500 }]);
    await expect(
      searchInfoFinanciereFilings({ company: "TotalEnergies" }, options(fetchFn)),
    ).rejects.toThrow();
  });

  test("a saturated window raises InfoFinanciereRateLimitError", async () => {
    for (let i = 0; i < 60; i += 1) infoFinanciereRateLimiter.tryAcquire();
    const fetchFn = routedFetch([nameRoute]);
    await expect(
      searchInfoFinanciereCompanies("TotalEnergies", options(fetchFn)),
    ).rejects.toThrow(InfoFinanciereRateLimitError);
  });
});
