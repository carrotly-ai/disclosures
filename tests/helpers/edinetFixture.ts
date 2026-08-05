import type { Route } from "./routedFetch.js";
import { makeStoredZip } from "./zipFixture.js";

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
