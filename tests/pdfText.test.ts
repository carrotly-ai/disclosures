import { describe, expect, test } from "bun:test";
import { extractPdfText } from "../src/core/pdfText.js";
import {
  buildImagePdf,
  buildObjStmPdf,
  buildRawByteGlyphPdf,
  buildShortfallObjStmPdf,
  buildSimplePdf,
  buildToUnicodePdf,
} from "./helpers/pdfFixture.js";

describe("extractPdfText", () => {
  test("extracts text from an uncompressed content stream with Tj and line moves", () => {
    const pdf = buildSimplePdf(
      "BT /F1 12 Tf (Hello World) Tj T* (Second line) Tj ET",
    );
    const result = extractPdfText(pdf);
    expect(result.text).toBe("Hello World\nSecond line");
    expect(result.pages).toBe(1);
    expect(result.notes).toHaveLength(0);
  });

  test("inflates a FlateDecode content stream", () => {
    const pdf = buildSimplePdf("BT (Compressed text here) Tj ET", { flate: true });
    const result = extractPdfText(pdf);
    expect(result.text).toBe("Compressed text here");
  });

  test("treats a large negative TJ kerning number as a word space", () => {
    const pdf = buildSimplePdf("BT [(Wor)-250(ld) 100 (joined)] TJ ET");
    const result = extractPdfText(pdf);
    // -250 inserts a space; +100 (positive) does not.
    expect(result.text).toBe("Wor ldjoined");
  });

  test("decodes octal escapes, escaped parens, and backslashes in literals", () => {
    const pdf = buildSimplePdf("BT (caf\\351 \\050x\\051 a\\\\b) Tj ET");
    const result = extractPdfText(pdf);
    expect(result.text).toBe("café (x) a\\b");
  });

  test("maps composite-font glyph codes through a ToUnicode CMap (é + CJK)", () => {
    const pdf = buildToUnicodePdf("000100020003", [
      { code: "0001", unicode: "00e9" }, // é
      { code: "0002", unicode: "4e2d" }, // 中
      { code: "0003", unicode: "0041" }, // A
    ]);
    const result = extractPdfText(pdf);
    expect(result.text).toBe("é中A");
    expect(result.notes).toHaveLength(0);
  });

  test("maps a ToUnicode bfrange run of codes", () => {
    // bfrange <0001> <0003> <0041> maps 0001->A, 0002->B, 0003->C.
    const pdf = buildToUnicodePdf("000100020003", [], [
      { lo: "0001", hi: "0003", dst: "0041" },
    ]);
    const result = extractPdfText(pdf);
    expect(result.text).toBe("ABC");
  });

  test("reports an honest fallback for an image-only PDF", () => {
    const pdf = buildImagePdf();
    const result = extractPdfText(pdf);
    expect(result.text).toBe("");
    expect(result.notes.join(" ")).toContain("scanned/image PDF");
  });

  test("flags punctuation/symbol soup from a mis-decoded font as unreliable", () => {
    // A large run of non-alphanumeric glyphs (what a custom-encoded subset font
    // with no /ToUnicode decodes to) must NOT be served as if it were text.
    const soup = "!\"#$%&'()*+,-./:;<=>?@[]".repeat(40);
    const pdf = buildSimplePdf(`BT (${soup}) Tj ET`);
    const result = extractPdfText(pdf);
    expect(result.text).toBe("");
    expect(result.notes.join(" ")).toContain("custom encodings");
  });

  test("recovers a Page + Font packed inside a compressed /ObjStm", () => {
    // Page node and Type0 font live in the object stream; their content stream
    // and /ToUnicode CMap are regular objects, referenced from the recovered
    // page/font. Correct output ("OBJSTM") proves the whole pipeline flows.
    const pdf = buildObjStmPdf();
    const result = extractPdfText(pdf);
    expect(result.text).toBe("OBJSTM");
    expect(result.pages).toBe(1);
    expect(result.declaredPages).toBe(1);
    expect(result.pagesWithText).toBe(1);
    expect(result.notes).toHaveLength(0);
  });

  test("reverses a PNG /Predictor 12 on a compressed /ObjStm", () => {
    const pdf = buildObjStmPdf({ predictor: true });
    const result = extractPdfText(pdf);
    expect(result.text).toBe("OBJSTM");
    expect(result.pages).toBe(1);
    expect(result.notes).toHaveLength(0);
  });

  test("flags a declared-vs-reached page shortfall (undecodable object stream)", () => {
    const pdf = buildShortfallObjStmPdf();
    const result = extractPdfText(pdf);
    expect(result.declaredPages).toBe(40);
    expect(result.pages).toBe(1);
    expect(result.pagesWithText).toBe(1);
    expect(result.notes.join(" ")).toContain("reached 1 of 40 declared pages");
  });

  test("round-trips Turkish glyph ids carried as raw bytes in 0x80-0x9F", () => {
    // Regression: `new TextDecoder("latin1")` is windows-1252 per the WHATWG
    // Encoding Standard, which remaps 0x80-0x9F (0x95 -> U+2022 BULLET). A
    // decoder using it breaks the byte==charCode invariant the extractor relies
    // on, and a Turkish "Ö" (glyph 0x0095 in KAP's PDFs) silently became "e".
    const turkish = "PORTFÖY Özet İĞŞÇÜ ığşçöü";
    const pdf = buildRawByteGlyphPdf(turkish);
    const result = extractPdfText(pdf);
    expect(result.text).toBe(turkish);
    expect(result.notes).toHaveLength(0);
  });

  test("does not throw on non-PDF input", () => {
    const result = extractPdfText(new TextEncoder().encode("not a pdf at all"));
    expect(result.text).toBe("");
    expect(result.notes.length).toBeGreaterThan(0);
  });
});
