import { beforeEach, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  GleifRateLimitError,
  normalizeEntityName as normalizeGleifEntityName,
  rankEntities as rankGleifEntities,
} from "../src/adapters/gleif.js";
import {
  SEC_NO_CONFIG_MESSAGE,
  SEC_RATE_LIMIT_MESSAGE,
  SecConfigurationError,
  SecRateLimitError,
} from "../src/adapters/secEdgar.js";
import { rankEntities } from "../src/core/entityMatching.js";
import {
  AdapterConfigurationError,
  AdapterRateLimitError,
} from "../src/core/errors.js";
import { getBinary } from "../src/core/http.js";
import { formatNumber } from "../src/core/markdown.js";
import {
  MultiWindowRateLimiter,
  bseRateLimiter,
  cninfoRateLimiter,
  companiesHouseRateLimiter,
  edinetRateLimiter,
  fcaNsmRateLimiter,
  openDartRateLimiter,
  resetRateLimiters,
} from "../src/core/rateLimiter.js";
import { DATA_SOURCES, JURISDICTIONS, type Entity } from "../src/core/types.js";
import { crc32, readSingleZipEntry, readZipEntries } from "../src/core/zip.js";
import { failureResult } from "../src/tools/shared.js";
import { routedFetch } from "./helpers/routedFetch.js";

interface ZipFixtureEntry {
  name: string;
  text: string;
  method: 0 | 8;
}

function pushUint16(output: number[], value: number): void {
  output.push(value & 0xff, (value >>> 8) & 0xff);
}

function pushUint32(output: number[], value: number): void {
  output.push(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function append(output: number[], bytes: Uint8Array): void {
  for (const byte of bytes) output.push(byte);
}

function zipFixture(entries: ZipFixtureEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const output: number[] = [];
  const central: Array<{
    name: Uint8Array;
    method: 0 | 8;
    crc: number;
    compressed: Uint8Array;
    uncompressedSize: number;
    localOffset: number;
  }> = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const compressed = entry.method === 0
      ? data
      : new Uint8Array(deflateRawSync(data));
    const checksum = crc32(data);
    const localOffset = output.length;
    pushUint32(output, 0x04034b50);
    pushUint16(output, 20);
    pushUint16(output, 0x0800);
    pushUint16(output, entry.method);
    pushUint16(output, 0);
    pushUint16(output, 0);
    pushUint32(output, checksum);
    pushUint32(output, compressed.length);
    pushUint32(output, data.length);
    pushUint16(output, name.length);
    pushUint16(output, 0);
    append(output, name);
    append(output, compressed);
    central.push({
      name,
      method: entry.method,
      crc: checksum,
      compressed,
      uncompressedSize: data.length,
      localOffset,
    });
  }

  const centralOffset = output.length;
  for (const entry of central) {
    pushUint32(output, 0x02014b50);
    pushUint16(output, 20);
    pushUint16(output, 20);
    pushUint16(output, 0x0800);
    pushUint16(output, entry.method);
    pushUint16(output, 0);
    pushUint16(output, 0);
    pushUint32(output, entry.crc);
    pushUint32(output, entry.compressed.length);
    pushUint32(output, entry.uncompressedSize);
    pushUint16(output, entry.name.length);
    pushUint16(output, 0);
    pushUint16(output, 0);
    pushUint16(output, 0);
    pushUint16(output, 0);
    pushUint32(output, 0);
    pushUint32(output, entry.localOffset);
    append(output, entry.name);
  }
  const centralSize = output.length - centralOffset;
  pushUint32(output, 0x06054b50);
  pushUint16(output, 0);
  pushUint16(output, 0);
  pushUint16(output, central.length);
  pushUint16(output, central.length);
  pushUint32(output, centralSize);
  pushUint32(output, centralOffset);
  pushUint16(output, 0);
  return Uint8Array.from(output);
}

beforeEach(() => {
  resetRateLimiters();
});

describe("jurisdiction-neutral foundations", () => {
  test("exports the planned jurisdictions and data sources", () => {
    expect(Object.values(JURISDICTIONS)).toEqual(["US", "GB", "EU", "KR", "JP", "CN", "IN", "TW", "BR", "DE", "FR", "HK", "SG", "TH", "NL", "ID"]);
    expect(Object.values(DATA_SOURCES)).toEqual([
      "SEC",
      "GLEIF",
      "SEC+GLEIF",
      "Companies House",
      "OpenDART",
      "EDINET",
      "cninfo",
      "SZSE",
      "BSE India",
      "FCA NSM",
      "filings.xbrl.org",
      "TWSE",
      "CVM",
      "BaFin",
      "info-financiere",
      "recherche-entreprises",
      "HKEXnews",
      "ACRA",
      "DBD",
      "AFM",
      "IDX",
    ]);
  });

  test("preserves CJK names while ranking exact matches", () => {
    expect(normalizeGleifEntityName("삼성전자 주식회사")).toBe("삼성전자 주식회사");
    expect(normalizeGleifEntityName("株式会社ソニー")).toBe("株式会社ソニー");
    expect(normalizeGleifEntityName("ガバナンス株式会社")).toBe("ガバナンス株式会社");
    expect(normalizeGleifEntityName("Société Générale")).toBe("societe generale");
    const entities: Entity[] = [
      { legalName: "삼성물산 주식회사", source: "GLEIF" },
      { legalName: "삼성전자 주식회사", source: "GLEIF" },
    ];
    expect(rankGleifEntities("삼성전자 주식회사", entities)[0]?.legalName).toBe(
      "삼성전자 주식회사",
    );
    expect(rankEntities("ソニー", [
      { legalName: "ソニーグループ株式会社", source: "EDINET" },
      { legalName: "トヨタ自動車株式会社", source: "EDINET" },
    ])[0]?.legalName).toBe("ソニーグループ株式会社");
  });
});

describe("shared adapter errors", () => {
  test("existing SEC and GLEIF errors retain names, messages, and shared classification", () => {
    const configuration = new SecConfigurationError();
    const secRateLimit = new SecRateLimitError();
    const gleifRateLimit = new GleifRateLimitError();
    expect(configuration).toBeInstanceOf(AdapterConfigurationError);
    expect(configuration.name).toBe("SecConfigurationError");
    expect(configuration.message).toBe(SEC_NO_CONFIG_MESSAGE);
    expect(configuration.source).toBe("SEC");
    expect(secRateLimit).toBeInstanceOf(AdapterRateLimitError);
    expect(secRateLimit.name).toBe("SecRateLimitError");
    expect(secRateLimit.message).toBe(SEC_RATE_LIMIT_MESSAGE);
    expect(secRateLimit.limit).toBe(30);
    expect(secRateLimit.windowMs).toBe(60_000);
    expect(gleifRateLimit).toBeInstanceOf(AdapterRateLimitError);
    expect(gleifRateLimit.name).toBe("GleifRateLimitError");
    expect(failureResult("Example", configuration).isError).toBe(true);
    expect(failureResult("Example", gleifRateLimit).isError).toBe(true);
  });
});

describe("multi-jurisdiction rate limiters", () => {
  test("defines CH, OpenDART, EDINET, cninfo, and BSE limits", () => {
    expect([companiesHouseRateLimiter.limit, companiesHouseRateLimiter.windowMs]).toEqual([
      600,
      300_000,
    ]);
    expect(openDartRateLimiter.windows).toEqual([
      { limit: 1_000, windowMs: 60_000 },
      { limit: 20_000, windowMs: 86_400_000 },
    ]);
    // EDINET's window must exceed EDINET_MAX_SCAN_DAYS (365) so a single
    // date-indexed scan never self-trips; cross-call abuse still trips it.
    expect([edinetRateLimiter.limit, edinetRateLimiter.windowMs]).toEqual([600, 60_000]);
    expect([cninfoRateLimiter.limit, cninfoRateLimiter.windowMs]).toEqual([300, 60_000]);
    expect([bseRateLimiter.limit, bseRateLimiter.windowMs]).toEqual([120, 60_000]);
    expect([fcaNsmRateLimiter.limit, fcaNsmRateLimiter.windowMs]).toEqual([60, 60_000]);
  });

  test("multi-window acquisition is atomic and reset clears every window", () => {
    let now = 0;
    const limiter = new MultiWindowRateLimiter([
      { limit: 2, windowMs: 1_000 },
      { limit: 3, windowMs: 10_000 },
    ], () => now);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.sizes).toEqual([2, 2]);
    now = 1_000;
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.sizes).toEqual([1, 3]);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.reset();
    expect(limiter.sizes).toEqual([0, 0]);
    expect(limiter.tryAcquire()).toBe(true);
  });

  test("global reset includes the new limiters", () => {
    expect(companiesHouseRateLimiter.tryAcquire()).toBe(true);
    expect(openDartRateLimiter.tryAcquire()).toBe(true);
    expect(edinetRateLimiter.tryAcquire()).toBe(true);
    expect(cninfoRateLimiter.tryAcquire()).toBe(true);
    expect(bseRateLimiter.tryAcquire()).toBe(true);
    expect(fcaNsmRateLimiter.tryAcquire()).toBe(true);
    resetRateLimiters();
    expect(companiesHouseRateLimiter.size).toBe(0);
    expect(openDartRateLimiter.sizes).toEqual([0, 0]);
    expect(edinetRateLimiter.size).toBe(0);
    expect(cninfoRateLimiter.size).toBe(0);
    expect(bseRateLimiter.size).toBe(0);
    expect(fcaNsmRateLimiter.size).toBe(0);
  });
});

describe("binary HTTP and ZIP", () => {
  test("returns response bytes without text conversion", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    const fetchFn = routedFetch([{ pattern: "/binary", body: bytes }]);
    expect(await getBinary("https://example.test/binary", {}, 1_000, fetchFn)).toEqual(bytes);
  });

  test("reads stored and deflated entries and validates the standard CRC vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const archive = zipFixture([
      { name: "corpCode.xml", text: "<result>삼성전자</result>", method: 8 },
      { name: "EdinetcodeDlInfo.csv", text: "ＥＤＩＮＥＴコード,提出者名\nE00001,株式会社例", method: 0 },
    ]);
    const entries = readZipEntries(archive);
    expect(entries.map((entry) => entry.name)).toEqual([
      "corpCode.xml",
      "EdinetcodeDlInfo.csv",
    ]);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe("<result>삼성전자</result>");
    expect(new TextDecoder().decode(entries[1]?.data)).toContain("株式会社例");
  });

  test("supports a single-entry archive and enforces size, path, and CRC checks", () => {
    const archive = zipFixture([{ name: "corpCode.xml", text: "safe", method: 0 }]);
    expect(new TextDecoder().decode(readSingleZipEntry(archive).data)).toBe("safe");
    expect(() => readSingleZipEntry(archive, { maxEntrySize: 2 })).toThrow(/entry exceeds/);
    expect(() => readZipEntries(zipFixture([
      { name: "../corpCode.xml", text: "unsafe", method: 0 },
    ]))).toThrow(/Invalid ZIP entry path/);

    const corrupted = new Uint8Array(archive);
    const dataOffset = 30 + new TextEncoder().encode("corpCode.xml").length;
    corrupted[dataOffset] = (corrupted[dataOffset] ?? 0) ^ 0xff;
    expect(() => readSingleZipEntry(corrupted)).toThrow(/CRC mismatch/);
  });
});

describe("currency formatting", () => {
  test("formats USD, GBP, KRW, and JPY without changing generic units", () => {
    expect(formatNumber(1_234_567.89, "USD")).toBe("$1,234,567.89");
    expect(formatNumber(1_234_567.89, "GBP")).toBe("£1,234,567.89");
    expect(formatNumber(1_234_567.89, "KRW")).toBe("₩1,234,568");
    expect(formatNumber(1_234_567.89, "JPY")).toBe("¥1,234,568");
    expect(formatNumber(1_234_567.89, "BRL")).toBe("R$1,234,567.89");
    expect(formatNumber(12.34567, "shares")).toBe("12.3457");
  });
});
