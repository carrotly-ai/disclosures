import type { Route } from "./routedFetch.js";
import { makeStoredZip, makeStoredZipMulti } from "./zipFixture.js";

// A minimal EdinetcodeDlInfo.csv encoded in Shift_JIS (cp932), base64-wrapped so
// the fixture stays byte-exact and zero-dependency at runtime. It reproduces the
// real file's title line + header and three rows: Toyota (E02144, sec 72030),
// Sony (E01777, sec 67580) and a synthetic unlisted filer (E99999, no sec code).
// Generated from real EDINET data with Python's cp932 codec.
const CODE_CSV_SHIFT_JIS_BASE64 =
  "g1+DRYOTg42BW4NojsCNc5P6LDIwMjaUTjA4jI4wNZP6jLuN3SyMj5CULDSMjw0KgmSCY4Jog" +
  "m2CZIJzg1KBW4NoLJLxj2+O0o7tlcosj+OP6ovmlaosmEGMi4LMl0yWsyyOkZZ7i+AsjIiOWp" +
  "P6LJLxj2+O0pa8LJLxj2+O0pa8gWmJcI6agWoskvGPb47SlryBaYOIg36BaiyPio3dkm4skvG" +
  "Pb47Si8aO7SyP2IyUg1KBW4NoLJLxj2+O0pZAkGyU1I2GDQoiRTAyMTQ0Iiwik+CNkZZAkGyB" +
  "RZFnjYciLCKP44/qIiwil0wiLCI2MzU0MDEiLCIzjI4zMZP6Iiwig2eDiINejqmTro7UipSOr" +
  "onvjtAiLCJUT1lPVEEgTU9UT1IgQ09SUE9SQVRJT04iLCKDZ4OIg16DV4Nog0WDVoODg0qDdY" +
  "NWg0yDS4NDg1aDgyIsIpZMk2OOc4Nng4iDXpKsglCU1JJuIiwil0GRl5dwi0CK7SIsIjcyMDM" +
  "wIiwiMTE4MDMwMTAxODc3MSINCiJFMDE3NzciLCKT4I2RlkCQbIFFkWeNhyIsIo/jj+oiLCKX" +
  "TCIsIjg4MDM2NSIsIjOMjjMxk/oiLCKDXINqgVuDT4OLgVuDdoqUjq6J747QIiwiU09OWSBHU" +
  "k9VUCBDT1JQT1JBVElPTiIsIoNcg2qBW4NPg4uBW4N2g0qDdYNWg0yDS4NDg1aDgyIsIpOMi5" +
  "6Tc41gi+aNYJPsiOqSmpbaglaU1IJQjYYiLCKTZItDi0CK7SIsIjY3NTgwIiwiNTAxMDQwMTA" +
  "2NzI1MiINCiJFOTk5OTkiLCKT4I2RlkCQbIFFkWeNhyIsIpTxj+OP6iIsIpazIiwiMTAwMDAi" +
  "LCIxMoyOMzGT+iIsIoNlg1iDZ5OKjpGM2pbiipSOronvjtAiLCJURVNUIElOVkVTVE1FTlQgQ" +
  "URWSVNPUlMgQ08uLCBMVEQuIiwig2WDWINng2eDRYNWg1KDgoOTg0qDdYNWg0yDS4NDg1aDgy" +
  "IsIpOMi56Tc5DnkeOTY4vmituCzJPgiOqSmpbaglCU1IJQjYYiLCKCu4LMkbyL4Jdai8YiLCI" +
  "iLCI5MDEwMDAxMDk5OTk5Ig0K";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Raw Shift_JIS bytes of the fixture CSV (before ZIP wrapping). */
export const EDINET_CODE_CSV_BYTES = base64ToBytes(CODE_CSV_SHIFT_JIS_BASE64);

/** Route serving the public EDINET code-list ZIP (a Shift_JIS CSV inside). */
export const edinetCodeListRoute: Route = {
  pattern: "Edinetcode.zip",
  body: makeStoredZip("EdinetcodeDlInfo.csv", EDINET_CODE_CSV_BYTES),
};

// A minimal EDINET XBRL instance for the CompanyFinancials path. It carries the
// standard relative-period contexts (current + prior fiscal year), a
// non-consolidated companion for two lines, and one segment-dimensioned context
// that must be ignored. Consolidated NetSales/OperatingIncome/Assets/NetAssets
// are present; net income is filed ONLY on the non-consolidated basis so the
// per-line consolidated→separate fallback is exercised.
export const EDINET_XBRL_INSTANCE = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:jppfs_cor="http://disclosure.edinet-fsa.go.jp/taxonomy/jppfs/jppfs_cor">
  <xbrli:context id="CurrentYearDuration">
    <xbrli:entity><xbrli:identifier scheme="x">E02144-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="CurrentYearInstant">
    <xbrli:entity><xbrli:identifier scheme="x">E02144-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="Prior1YearDuration">
    <xbrli:entity><xbrli:identifier scheme="x">E02144-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2024-04-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="Prior1YearInstant">
    <xbrli:entity><xbrli:identifier scheme="x">E02144-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2025-03-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="CurrentYearDuration_NonConsolidatedMember">
    <xbrli:entity><xbrli:identifier scheme="x">E02144-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="CurrentYearInstant_NonConsolidatedMember">
    <xbrli:entity><xbrli:identifier scheme="x">E02144-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="CurrentYearDuration_ReportableSegmentsTotalMember">
    <xbrli:entity><xbrli:identifier scheme="x">E02144-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <jppfs_cor:NetSales contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">45000000000000</jppfs_cor:NetSales>
  <jppfs_cor:NetSales contextRef="CurrentYearDuration_NonConsolidatedMember" unitRef="JPY" decimals="-6">15000000000000</jppfs_cor:NetSales>
  <jppfs_cor:NetSales contextRef="Prior1YearDuration" unitRef="JPY" decimals="-6">43000000000000</jppfs_cor:NetSales>
  <jppfs_cor:NetSales contextRef="CurrentYearDuration_ReportableSegmentsTotalMember" unitRef="JPY" decimals="-6">99999999999999</jppfs_cor:NetSales>
  <jppfs_cor:OperatingIncome contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">5000000000000</jppfs_cor:OperatingIncome>
  <jppfs_cor:ProfitLossAttributableToOwnersOfParent contextRef="CurrentYearDuration_NonConsolidatedMember" unitRef="JPY" decimals="-6">4800000000000</jppfs_cor:ProfitLossAttributableToOwnersOfParent>
  <jppfs_cor:Assets contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">90000000000000</jppfs_cor:Assets>
  <jppfs_cor:Assets contextRef="CurrentYearInstant_NonConsolidatedMember" unitRef="JPY" decimals="-6">30000000000000</jppfs_cor:Assets>
  <jppfs_cor:Assets contextRef="Prior1YearInstant" unitRef="JPY" decimals="-6">88000000000000</jppfs_cor:Assets>
  <jppfs_cor:NetAssets contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">36000000000000</jppfs_cor:NetAssets>
</xbrli:xbrl>`;

/**
 * Route serving a filing's type=1 XBRL archive (a ZIP with the instance under
 * XBRL/PublicDoc plus a decoy AuditDoc .xbrl to exercise PublicDoc preference).
 */
export function edinetArchiveRoute(
  docId: string,
  instance: string = EDINET_XBRL_INSTANCE,
): Route {
  return {
    pattern: `documents/${docId}`,
    body: makeStoredZipMulti([
      {
        name: "XBRL/AuditDoc/jpaud-aai-cc-001_E02144-000_2026-03-31.xbrl",
        content: '<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="x"></xbrli:xbrl>',
      },
      {
        name: "XBRL/PublicDoc/jpcrp030000-asr-001_E02144-000_2026-03-31_01.xbrl",
        content: instance,
      },
      { name: "XBRL/PublicDoc/0000000_header_jpcrp030000-asr-001.htm", content: "<html></html>" },
    ]),
  };
}

/** Build a documents.json body for one calendar day. */
export function edinetDay(
  results: Array<Record<string, unknown>>,
  status = "200",
): Record<string, unknown> {
  return {
    metadata: {
      title: "提出された書類を把握するためのAPI",
      parameter: { date: "2026-08-05", type: "2" },
      resultset: { count: results.length },
      status,
      message: status === "200" ? "OK" : "error",
    },
    results,
  };
}
