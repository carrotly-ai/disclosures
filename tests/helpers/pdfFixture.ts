import { deflateSync } from "node:zlib";

// Test-only PDF builders. `node:zlib` is imported HERE (a test helper) purely to
// COMPRESS a FlateDecode fixture stream — the production extractor never imports
// node:zlib and inflates through src/core/zip.ts's shared wrapper.

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function streamObject(
  num: number,
  dictExtra: string,
  body: Uint8Array,
): Uint8Array {
  return concat([
    enc.encode(`${num} 0 obj\n<< /Length ${body.length}${dictExtra} >>\nstream\n`),
    body,
    enc.encode("\nendstream\nendobj\n"),
  ]);
}

/**
 * A minimal one-page PDF whose content stream is `content`. When `flate` is set
 * the stream is zlib-compressed and tagged `/FlateDecode` (exercising the
 * inflate path); otherwise it is stored verbatim.
 */
export function buildSimplePdf(
  content: string,
  options: { flate?: boolean } = {},
): Uint8Array {
  const raw = enc.encode(content);
  const streamBytes = options.flate ? new Uint8Array(deflateSync(raw)) : raw;
  const filter = options.flate ? " /Filter /FlateDecode" : "";
  return concat([
    enc.encode("%PDF-1.7\n"),
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    enc.encode(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>\nendobj\n",
    ),
    streamObject(4, filter, streamBytes),
    enc.encode("%%EOF"),
  ]);
}

/**
 * A one-page PDF with a composite (Type0) font carrying a `/ToUnicode` CMap. The
 * content stream shows two-byte codes; `bfchar` maps each code to a UTF-16BE
 * string, so the extractor must round-trip accented Latin / CJK characters.
 */
export function buildToUnicodePdf(
  hexCodes: string,
  bfchar: Array<{ code: string; unicode: string }>,
  bfrange: Array<{ lo: string; hi: string; dst: string }> = [],
): Uint8Array {
  const lines = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <ffff> endcodespacerange",
  ];
  if (bfchar.length) {
    lines.push(`${bfchar.length} beginbfchar`);
    lines.push(...bfchar.map((e) => `<${e.code}> <${e.unicode}>`));
    lines.push("endbfchar");
  }
  if (bfrange.length) {
    lines.push(`${bfrange.length} beginbfrange`);
    lines.push(...bfrange.map((e) => `<${e.lo}> <${e.hi}> <${e.dst}>`));
    lines.push("endbfrange");
  }
  lines.push("endcmap end end");
  const cmap = lines.join("\n");
  const content = `BT /F1 12 Tf <${hexCodes}> Tj ET`;
  return concat([
    enc.encode("%PDF-1.7\n"),
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    enc.encode(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R " +
        "/Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    ),
    streamObject(4, "", enc.encode(content)),
    enc.encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, "", enc.encode(cmap)),
    enc.encode("%%EOF"),
  ]);
}

/** A one-page, image-only PDF (a DCTDecode XObject, no text) over 20 KB. */
export function buildImagePdf(imageBytes = 30_000): Uint8Array {
  const image = new Uint8Array(imageBytes).fill(0x41);
  return concat([
    enc.encode("%PDF-1.7\n"),
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    enc.encode(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> >>\nendobj\n",
    ),
    streamObject(
      4,
      " /Type /XObject /Subtype /Image /Width 100 /Height 100 /Filter /DCTDecode",
      image,
    ),
    enc.encode("%%EOF"),
  ]);
}
