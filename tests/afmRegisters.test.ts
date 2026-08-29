import { beforeEach, describe, expect, test } from "bun:test";
import {
  AFM_EXPORT_URL,
  AFM_REGISTER_GUIDS,
  AFM_WFT_THRESHOLD_REGIME,
  AfmRateLimitError,
  afmExportUrl,
  extractToelichtingDocument,
  getAfmInsiders,
  getAfmOwners,
  parseAfmDate,
  parseAfmNumber,
  parseCsvLine,
  parseDirectorHoldingsXml,
  parseDutchPercent,
  parseManagersTransactionsXml,
  parseSubstantialHoldingsCsv,
  rankIssuerNames,
  resetAfmRegisterCache,
  searchAfmCompanies,
  splitVermeldingen,
} from "../src/adapters/afmRegisters.js";
import { InMemoryCache } from "../src/core/cache.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { loadFixture, loadFixtureBytes } from "./helpers/loadFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

// The substantial-holdings fixture is stored Windows-1252 (as AFM serves it),
// so it is loaded as bytes: reading it as UTF-8 would mangle the `Reëel`
// column the adapter's decoding path exists to handle.
const holdingsCsvBytes = loadFixtureBytes("afm", "substantiele-deelnemingen.csv");
const holdingsCsv = new TextDecoder("windows-1252").decode(holdingsCsvBytes);
const managersXml = loadFixture("afm", "transacties-leidinggevenden.xml");
const directorsXml = loadFixture("afm", "bestuurders-commissarissen.xml");

const holdingsRoute: Route = {
  pattern: AFM_REGISTER_GUIDS.substantialHoldings,
  body: holdingsCsvBytes,
};
const managersRoute: Route = {
  pattern: AFM_REGISTER_GUIDS.managersTransactions,
  body: managersXml,
};
const directorsRoute: Route = {
  pattern: AFM_REGISTER_GUIDS.directorHoldings,
  body: directorsXml,
};
const allRoutes: Route[] = [holdingsRoute, managersRoute, directorsRoute];

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

beforeEach(() => {
  resetRateLimiters();
  // Each test starts from a cold register memo so cache behaviour is explicit.
  resetAfmRegisterCache();
});

describe("AFM export URLs", () => {
  test("builds keyless export URLs per register and format", () => {
    expect(afmExportUrl("substantialHoldings", "csv")).toBe(
      `${AFM_EXPORT_URL}?type=${AFM_REGISTER_GUIDS.substantialHoldings}&format=csv`,
    );
    expect(afmExportUrl("managersTransactions", "xml")).toBe(
      `${AFM_EXPORT_URL}?type=${AFM_REGISTER_GUIDS.managersTransactions}&format=xml`,
    );
    // No key, token, or credential is ever appended.
    expect(afmExportUrl("directorHoldings", "xml")).not.toMatch(/key|token|auth/i);
  });
});

describe("Dutch value parsing", () => {
  test("parseDutchPercent reads a comma decimal with a spaced percent sign", () => {
    expect(parseDutchPercent("2,55 %")).toBeCloseTo(2.55, 2);
    expect(parseDutchPercent("50,01 %")).toBeCloseTo(50.01, 2);
    expect(parseDutchPercent("0,00 %")).toBe(0);
    expect(parseDutchPercent("")).toBeUndefined();
    expect(parseDutchPercent(undefined)).toBeUndefined();
    expect(parseDutchPercent("n.v.t.")).toBeUndefined();
  });

  test("parseAfmNumber reads the register's padded decimals", () => {
    expect(parseAfmNumber("2227413.00000")).toBe(2227413);
    expect(parseAfmNumber("-1553.115")).toBeCloseTo(-1553.115, 3);
    expect(parseAfmNumber("")).toBeUndefined();
    expect(parseAfmNumber("Gewoon aandeel")).toBeUndefined();
  });

  test("parseAfmDate normalises both export date styles to ISO", () => {
    // CSV style.
    expect(parseAfmDate("2026-08-27 00:00:00")).toBe("2026-08-27");
    // XML style (US-formatted, with and without a time).
    expect(parseAfmDate("8/27/2026 12:00:00 AM")).toBe("2026-08-27");
    expect(parseAfmDate("8/7/2026")).toBe("2026-08-07");
    expect(parseAfmDate("")).toBeUndefined();
    expect(parseAfmDate(undefined)).toBeUndefined();
  });

  test("extractToelichtingDocument resolves AFM's unquoted relative href", () => {
    const url = extractToelichtingDocument(
      "<a href=wmzk_documents/199404_Org%20Chart.pdf>Org Chart.pdf</a>",
    );
    expect(url).toBe(
      "https://www.afm.nl/nl-nl/sector/registers/meldingenregisters/" +
        "substantiele-deelnemingen/wmzk_documents/199404_Org%20Chart.pdf",
    );
    expect(extractToelichtingDocument("")).toBeUndefined();
    expect(extractToelichtingDocument("no link here")).toBeUndefined();
  });
});

describe("CSV parsing", () => {
  test("parseCsvLine splits on semicolons outside quotes", () => {
    expect(parseCsvLine('"a";"b";"c"')).toEqual(["a", "b", "c"]);
    // A semicolon inside a quoted field is data, not a delimiter.
    expect(parseCsvLine('"a;b";"c"')).toEqual(["a;b", "c"]);
    // Doubled quotes are an escaped quote character.
    expect(parseCsvLine('"say ""hi""";"x"')).toEqual(['say "hi"', "x"]);
    expect(parseCsvLine('"";""')).toEqual(["", ""]);
  });

  test("decodes the Windows-1252 register without mojibake", () => {
    // If this were read as UTF-8 the header would carry a replacement char.
    expect(holdingsCsv).toContain("Rechtstreeks reëel");
    expect(holdingsCsv).not.toContain("�");
  });
});

describe("parseSubstantialHoldingsCsv", () => {
  const digest = parseSubstantialHoldingsCsv(holdingsCsv);

  test("collapses the register to the latest notification per issuer+holder", () => {
    // The fixture holds three BlackRock/Heineken rows across two notification
    // dates plus an older 2019 one; all collapse to a single latest record.
    const heinekenBlackRock = digest.filter(
      (row) => row.i === "Heineken N.V." && row.h === "BlackRock Inc.",
    );
    expect(heinekenBlackRock).toHaveLength(1);
    expect(heinekenBlackRock[0]?.d).toBe("2026-08-10");
    // The superseded 2019 notification must not win.
    expect(heinekenBlackRock[0]?.cap).toBeCloseTo(2.53, 2);
  });

  test("folds the capital and voting limbs of one notification into one row", () => {
    // AFM writes each notification twice — once under "Kapitaalbelang" and once
    // under "Stemrecht" — carrying a different Totale deelneming each time.
    const row = parseSubstantialHoldingsCsv(holdingsCsv).find(
      (entry) => entry.i === "Heineken N.V." && entry.h === "BlackRock Inc.",
    );
    expect(row?.cap).toBeCloseTo(2.53, 2);
    expect(row?.vot).toBeCloseTo(3.0, 2);
  });

  test("keeps issuer domicile, share class, and the linked notification annex", () => {
    const row = digest.find(
      (entry) => entry.i === "Koninklijke Philips N.V." && entry.h === "BlackRock Inc.",
    );
    expect(row?.p).toBe("Amsterdam");
    expect(row?.s).toBe("Ordinary share");
    expect(row?.u).toContain("wmzk_documents/194048_12-Page");
  });

  test("returns nothing for an empty or headerless export", () => {
    expect(parseSubstantialHoldingsCsv("")).toEqual([]);
    expect(parseSubstantialHoldingsCsv("not;a;register\n")).toEqual([]);
  });
});

describe("XML register parsing", () => {
  test("splitVermeldingen does not truncate on the nested label element", () => {
    // Each record nests a second <vermelding> as a display label; a lazy regex
    // would stop at the inner close tag and lose the tail of the record.
    const records = splitVermeldingen(managersXml);
    expect(records).toHaveLength(5);
    expect(records[0]).toContain("<lei>7245009C5FZE6G9ODQ71</lei>");
  });

  test("parseManagersTransactionsXml reads person, function, LEI, and date", () => {
    const rows = parseManagersTransactionsXml(managersXml);
    expect(rows).toHaveLength(5);
    const first = rows[0];
    expect(first?.i).toBe("argenx SE");
    expect(first?.n).toBe("DelGiacco E.");
    expect(first?.f).toBe("Corporate Affairs");
    expect(first?.l).toBe("7245009C5FZE6G9ODQ71");
    expect(first?.d).toBe("2026-08-26");
    // An empty <nauwgelieerdaan> stays unset rather than becoming "".
    expect(first?.a).toBeUndefined();
    // A populated one is kept.
    expect(rows.find((row) => row.n === "Houdart A.")?.a).toBe("Houdart Holding B.V.");
  });

  test("parseDirectorHoldingsXml reads before/change/after from nested blocks", () => {
    const rows = parseDirectorHoldingsXml(directorsXml);
    expect(rows).toHaveLength(6);
    const conix = rows.find((row) => row.n === "B.M.  Conix");
    expect(conix?.i).toBe("ASML Holding N.V.");
    expect(conix?.d).toBe("2026-07-22");
    expect(conix?.b).toBe(254);
    expect(conix?.c).toBe(125);
    expect(conix?.t).toBe(379);
    expect(conix?.v).toBe(1556);
    expect(conix?.cur).toBe("EUR");
    expect(conix?.s).toBe("Gewoon aandeel");
  });

  test("parses a disposal's negative change", () => {
    const rows = parseDirectorHoldingsXml(directorsXml);
    const fouquet = rows.find((row) => row.n === "C.D.  Fouquet");
    expect(fouquet?.c).toBeCloseTo(-1553.115, 3);
    expect(fouquet?.t).toBeCloseTo(2928.162, 3);
  });

  test("returns nothing for an empty register", () => {
    expect(parseManagersTransactionsXml("<register></register>")).toEqual([]);
    expect(parseDirectorHoldingsXml("")).toEqual([]);
  });
});

describe("issuer name ranking", () => {
  const names = [
    "Heineken N.V.",
    "Heineken Holding N.V.",
    "ASML Holding N.V.",
    "Koninklijke Philips N.V.",
  ];

  test("a verbatim legal name wins over a shorter near-namesake", () => {
    // Normalisation folds "Holding" away, so without the exact-match rule this
    // would resolve to the wrong (shorter) Heineken entity.
    expect(rankIssuerNames(names, "Heineken Holding N.V.")[0]).toBe(
      "Heineken Holding N.V.",
    );
  });

  test("a bare group name prefers the plainer issuer", () => {
    expect(rankIssuerNames(names, "Heineken")[0]).toBe("Heineken N.V.");
  });

  test("matches through Dutch legal-form noise", () => {
    expect(rankIssuerNames(names, "ASML")[0]).toBe("ASML Holding N.V.");
    expect(rankIssuerNames(names, "Philips")[0]).toBe("Koninklijke Philips N.V.");
  });

  test("an unknown name matches nothing", () => {
    expect(rankIssuerNames(names, "NoSuchIssuer")).toEqual([]);
  });
});

describe("getAfmOwners", () => {
  test("returns the issuer's holders newest first with both percentage limbs", async () => {
    const fetchFn = routedFetch([holdingsRoute]);
    const { issuerName, rows } = await getAfmOwners("Heineken", options(fetchFn));

    expect(issuerName).toBe("Heineken N.V.");
    expect(rows.length).toBeGreaterThan(0);
    const top = rows[0];
    expect(top?.holderName).toBe("BlackRock Inc.");
    expect(top?.pctCapital).toBeCloseTo(2.53, 2);
    expect(top?.pctVotingRights).toBeCloseTo(3.0, 2);
    // The headline pct is the voting-rights figure.
    expect(top?.pct).toBeCloseTo(3.0, 2);
    expect(top?.thresholdRegime).toBe(AFM_WFT_THRESHOLD_REGIME);
    expect(top?.source).toBe("AFM");
    expect(top?.notifiedDate).toBe("2026-08-10");
    // Newest first.
    expect(rows.map((row) => row.filedDate)).toEqual(
      [...rows.map((row) => row.filedDate)].sort().reverse(),
    );
  });

  test("links the notification annex where the register carries one", async () => {
    const fetchFn = routedFetch([holdingsRoute]);
    const { rows } = await getAfmOwners("Heineken N.V.", options(fetchFn));
    const blackRock = rows.find((row) => row.holderName === "BlackRock Inc.");
    expect(blackRock?.sourceUrl).toContain("wmzk_documents/198536_12-Page");
    // A holder with no annex still gets a real, resolvable register link.
    const founder = rows.find((row) => row.holderName.includes("Carvalho-Heineken"));
    expect(founder?.sourceUrl).toContain("afm.nl");
    expect(founder?.pct).toBeCloseTo(50.01, 2);
  });

  test("keeps the two Heineken entities apart", async () => {
    const fetchFn = routedFetch([holdingsRoute]);
    const holding = await getAfmOwners("Heineken Holding N.V.", options(fetchFn));
    expect(holding.issuerName).toBe("Heineken Holding N.V.");
    expect(holding.rows.map((row) => row.holderName)).toEqual(["FEMSA"]);
  });

  test("an issuer absent from the register returns no rows", async () => {
    const fetchFn = routedFetch([holdingsRoute]);
    const { issuerName, rows } = await getAfmOwners("NoSuchIssuer", options(fetchFn));
    expect(issuerName).toBe("");
    expect(rows).toEqual([]);
  });

  test("an empty query never touches the network", async () => {
    const fetchFn = routedFetch([holdingsRoute]);
    const { rows } = await getAfmOwners("   ", options(fetchFn));
    expect(rows).toEqual([]);
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("getAfmInsiders", () => {
  test("merges MAR transactions and director holdings, newest first", async () => {
    const fetchFn = routedFetch([managersRoute, directorsRoute]);
    const { issuerName, rows } = await getAfmInsiders("argenx", options(fetchFn));

    expect(issuerName).toBe("argenx SE");
    const forms = rows.map((row) => row.form);
    expect(forms).toContain("Art.19 MAR managers' transaction");
    expect(forms).toContain("Directors'/commissioners' holdings notification");
    expect(rows.map((row) => row.filedDate)).toEqual(
      [...rows.map((row) => row.filedDate)].sort().reverse(),
    );
  });

  test("carries the MAR function as the role and the issuer LEI", async () => {
    const fetchFn = routedFetch([managersRoute, directorsRoute]);
    const { rows } = await getAfmInsiders("argenx", options(fetchFn));
    const mar = rows.find((row) => row.name === "DelGiacco E.");
    expect(mar?.roles).toEqual(["Corporate Affairs"]);
    expect(mar?.sourceIdentifiers?.lei).toBe("7245009C5FZE6G9ODQ71");
    expect(mar?.filedDate).toBe("2026-08-26");
    expect(mar?.source).toBe("AFM");
  });

  test("renders the director position change as readable detail", async () => {
    const fetchFn = routedFetch([managersRoute, directorsRoute]);
    const { rows } = await getAfmInsiders("ASML", options(fetchFn));
    const conix = rows.find((row) => row.name === "B.M.  Conix");
    expect(conix?.occupation).toContain("before 254");
    expect(conix?.occupation).toContain("change 125");
    expect(conix?.occupation).toContain("after 379");
    expect(conix?.occupation).toContain("EUR 1556");
    expect(conix?.change).toBe(125);
  });

  test("resolves one issuer across both registers rather than two namesakes", async () => {
    const fetchFn = routedFetch([managersRoute, directorsRoute]);
    // "Heineken" is in the directors register as "Heineken N.V." and in the MAR
    // register only as "Heineken Holding N.V." — a different legal entity that
    // must not be folded in.
    const { issuerName, rows } = await getAfmInsiders("Heineken", options(fetchFn));
    expect(issuerName).toBe("Heineken N.V.");
    expect(rows.every((row) => row.form.startsWith("Directors'"))).toBe(true);

    const holding = await getAfmInsiders("Heineken Holding N.V.", options(fetchFn));
    expect(holding.issuerName).toBe("Heineken Holding N.V.");
    expect(holding.rows.every((row) => row.form.startsWith("Art.19"))).toBe(true);
  });

  test("an issuer in neither register returns no rows", async () => {
    const fetchFn = routedFetch([managersRoute, directorsRoute]);
    const { rows } = await getAfmInsiders("NoSuchIssuer", options(fetchFn));
    expect(rows).toEqual([]);
  });
});

describe("searchAfmCompanies", () => {
  test("resolves an issuer from the register names and reports its registers", async () => {
    const fetchFn = routedFetch(allRoutes);
    const results = await searchAfmCompanies("Philips", options(fetchFn));
    expect(results[0]?.legalName).toBe("Koninklijke Philips N.V.");
    expect(results[0]?.jurisdiction).toBe("NL");
    expect(results[0]?.source).toBe("AFM");
    expect(results[0]?.matchReason).toContain("AFM register");
    // The MAR export carries the issuer LEI, so no GLEIF call is needed here.
    expect(results[0]?.lei).toBe("724500O5JEJKV7RKQO88");
  });

  test("resolves an issuer known only from the holdings register", async () => {
    const fetchFn = routedFetch(allRoutes);
    // InPost appears in the substantial-holdings register only; it must still
    // resolve (just without an LEI, which the MAR export alone carries).
    const results = await searchAfmCompanies("InPost", options(fetchFn));
    expect(results[0]?.legalName).toBe("InPost S.A.");
    expect(results[0]?.lei).toBeUndefined();
  });

  test("resolves a bare LEI against the MAR register", async () => {
    const fetchFn = routedFetch(allRoutes);
    const results = await searchAfmCompanies(
      "724500QJ4QSZ3H9QU415",
      options(fetchFn),
    );
    expect(results[0]?.legalName).toBe("Euronext N.V.");
    expect(results[0]?.matchReason).toContain("exact LEI");
  });

  test("an ISIN resolves nothing — these registers carry no ISIN column", async () => {
    const fetchFn = routedFetch(allRoutes);
    expect(await searchAfmCompanies("NL0010273215", options(fetchFn))).toEqual([]);
  });

  test("a non-registered company honestly resolves to nothing", async () => {
    const fetchFn = routedFetch(allRoutes);
    expect(await searchAfmCompanies("Some Private Dutch BV", options(fetchFn)))
      .toEqual([]);
  });
});

describe("register caching", () => {
  test("a warm cache serves the second call without refetching", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch([holdingsRoute]);

    const first = await getAfmOwners("Heineken", { fetchFn, cache });
    expect(first.rows.length).toBeGreaterThan(0);
    const afterFirst = fetchFn.requests.length;
    expect(afterFirst).toBe(1);

    // A fresh process memo: only the injected cache can prevent a refetch.
    resetAfmRegisterCache();
    const second = await getAfmOwners("Heineken", { fetchFn, cache });
    expect(fetchFn.requests).toHaveLength(afterFirst);
    expect(second.rows).toEqual(first.rows);
  });

  test("caches only the reduced digest, never the raw export", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch([holdingsRoute]);
    await getAfmOwners("Heineken", { fetchFn, cache });

    const stored = await cache.get("afm:register:substantialHoldings:v1");
    expect(stored).toBeDefined();
    // The digest is JSON records, not the CSV text, and is far smaller than the
    // export it came from.
    expect(stored?.startsWith("[")).toBe(true);
    expect(stored).not.toContain("Datum meldingsplicht");
    expect(stored!.length).toBeLessThan(holdingsCsv.length);
  });

  test("each register is cached under its own key", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch(allRoutes);
    await getAfmInsiders("argenx", { fetchFn, cache });

    expect(await cache.get("afm:register:managersTransactions:v1")).toBeDefined();
    expect(await cache.get("afm:register:directorHoldings:v1")).toBeDefined();
    // CompanyInsiders must not pull the 108 MB holdings register.
    expect(await cache.get("afm:register:substantialHoldings:v1")).toBeUndefined();
  });

  test("a corrupt cache entry is treated as a miss and refetched", async () => {
    const cache = new InMemoryCache();
    cache.set("afm:register:substantialHoldings:v1", "{not json");
    const fetchFn = routedFetch([holdingsRoute]);

    const { rows } = await getAfmOwners("Heineken", { fetchFn, cache });
    expect(rows.length).toBeGreaterThan(0);
    expect(fetchFn.requests).toHaveLength(1);
  });

  test("without a cache, one process still fetches a register only once", async () => {
    const fetchFn = routedFetch([holdingsRoute]);
    await getAfmOwners("Heineken", options(fetchFn));
    await getAfmOwners("Philips", options(fetchFn));
    expect(fetchFn.requests).toHaveLength(1);
  });
});

describe("upstream failure", () => {
  test("a 500 from AFM propagates rather than reporting an empty register", async () => {
    const fetchFn = routedFetch([
      { pattern: AFM_REGISTER_GUIDS.substantialHoldings, body: "boom", status: 500 },
    ]);
    await expect(getAfmOwners("Heineken", options(fetchFn))).rejects.toThrow(
      /HTTP 500/,
    );
  });

  test("a 429 becomes a typed rate-limit error", async () => {
    const fetchFn = routedFetch([
      { pattern: AFM_REGISTER_GUIDS.managersTransactions, body: "slow down", status: 429 },
      directorsRoute,
    ]);
    await expect(getAfmInsiders("argenx", options(fetchFn))).rejects.toBeInstanceOf(
      AfmRateLimitError,
    );
  });

  test("an empty export is reported as an error, not as no holdings", async () => {
    const fetchFn = routedFetch([
      { pattern: AFM_REGISTER_GUIDS.substantialHoldings, body: "" },
    ]);
    await expect(getAfmOwners("Heineken", options(fetchFn))).rejects.toThrow(
      /no rows/i,
    );
  });

  test("a failed fetch is not memoized — the next call retries", async () => {
    const failing = routedFetch([
      { pattern: AFM_REGISTER_GUIDS.substantialHoldings, body: "boom", status: 500 },
    ]);
    await expect(getAfmOwners("Heineken", options(failing))).rejects.toThrow();

    const working = routedFetch([holdingsRoute]);
    const { rows } = await getAfmOwners("Heineken", options(working));
    expect(rows.length).toBeGreaterThan(0);
  });
});
