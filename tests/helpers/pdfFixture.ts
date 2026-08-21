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

/**
 * Encode a plain (accented) JS string as the body of a PDF literal string using
 * single-byte WinAnsi/Latin-1 octal escapes for any non-ASCII char — mirroring
 * how real simple-font notification PDFs carry "société"/"déclaré". Parens and
 * backslashes are escaped; code points above 0xFF are not expected in fixtures.
 */
function toWinAnsiLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "(") out += "\\(";
    else if (ch === ")") out += "\\)";
    else if (ch === "\\") out += "\\\\";
    else if (cp < 0x80) out += ch;
    else if (cp <= 0xff) out += `\\${cp.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return out;
}

/**
 * A one-page PDF whose text layer is `text` (French accents preserved via
 * WinAnsi octal escapes). Used to fixture AMF threshold-crossing notifications
 * for the FR CompanyOwners extraction path.
 */
export function buildFrenchTextPdf(text: string): Uint8Array {
  return buildSimplePdf(`BT /F1 12 Tf (${toWinAnsiLiteral(text)}) Tj ET`);
}

function toUnicodeCmap(bfchar: Array<{ code: string; unicode: string }>): string {
  return [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <ffff> endcodespacerange",
    `${bfchar.length} beginbfchar`,
    ...bfchar.map((e) => `<${e.code}> <${e.unicode}>`),
    "endbfchar",
    "endcmap end end",
  ].join("\n");
}

/**
 * PNG "Sub" filter (type 1, bytes-per-pixel 1) over a single row whose width is
 * the whole payload — the encode side of the predictor reversal the extractor
 * runs. Used to exercise `/DecodeParms /Predictor 12` on a compressed stream.
 */
function pngSubEncode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 1);
  out[0] = 1; // filter type: Sub
  out[1] = data[0] ?? 0;
  for (let i = 1; i < data.length; i += 1) {
    out[i + 1] = ((data[i] ?? 0) - (data[i - 1] ?? 0)) & 0xff;
  }
  return out;
}

/**
 * A one-page PDF whose Page node and (Type0 + `/ToUnicode`) Font dictionary live
 * inside a compressed `/Type /ObjStm` object stream — the class of file the
 * linear `N G obj` scan cannot see. Its content stream and `/ToUnicode` CMap
 * stay regular indirect objects (stream objects cannot live in an ObjStm),
 * referenced *from* the ObjStm-packed page/font, so a correct extraction proves
 * the whole pipeline flows through recovered objects. The content spells
 * "OBJSTM" through the ToUnicode map. With `predictor`, the ObjStm is
 * PNG-predicted (`/Predictor 12`) before deflate.
 */
export function buildObjStmPdf(options: { predictor?: boolean } = {}): Uint8Array {
  const cmap = toUnicodeCmap([
    { code: "0001", unicode: "004f" }, // O
    { code: "0002", unicode: "0042" }, // B
    { code: "0003", unicode: "004a" }, // J
    { code: "0004", unicode: "0053" }, // S
    { code: "0005", unicode: "0054" }, // T
    { code: "0006", unicode: "004d" }, // M
  ]);
  const content = "BT /F1 12 Tf <000100020003000400050006> Tj ET";
  const body3 = "<< /Type /Page /Parent 2 0 R /Contents 4 0 R " +
    "/Resources << /Font << /F1 5 0 R >> >> >>";
  const body5 = "<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>";
  const header = `3 0 5 ${body3.length} `;
  const first = header.length;
  const decoded = enc.encode(header + body3 + body5);

  let streamBytes: Uint8Array;
  let extra: string;
  if (options.predictor) {
    streamBytes = new Uint8Array(deflateSync(pngSubEncode(decoded)));
    extra = ` /Type /ObjStm /N 2 /First ${first} /Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 12 /Columns ${decoded.length} /Colors 1 /BitsPerComponent 8 >>`;
  } else {
    streamBytes = new Uint8Array(deflateSync(decoded));
    extra = ` /Type /ObjStm /N 2 /First ${first} /Filter /FlateDecode`;
  }

  return concat([
    enc.encode("%PDF-1.5\n"),
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    streamObject(4, "", enc.encode(content)),
    streamObject(6, "", enc.encode(cmap)),
    streamObject(7, extra, streamBytes),
    enc.encode("%%EOF"),
  ]);
}

/**
 * A PDF that declares many pages (`/Count 40`) but locks all but one inside an
 * object stream tagged `/FlateDecode` whose bytes are not actually deflate — so
 * it cannot be decoded and those pages stay unreachable. Models the CK Hutchison
 * failure class: the extractor reaches 1 page against 40 declared, so the
 * declared-vs-reached shortfall guard must fire. The one reachable page carries
 * real text so the file is not mistaken for a scanned document.
 */
export function buildShortfallObjStmPdf(): Uint8Array {
  const undecodable = enc.encode("this is not a valid deflate object stream body");
  return concat([
    enc.encode("%PDF-1.5\n"),
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 40 >>\nendobj\n"),
    enc.encode(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>\nendobj\n",
    ),
    streamObject(4, "", enc.encode("BT (Cover page only) Tj ET")),
    streamObject(8, " /Type /ObjStm /N 5 /First 20 /Filter /FlateDecode", undecodable),
    enc.encode("%%EOF"),
  ]);
}

/**
 * A one-page PDF whose text layer is `lines`, one per line (`T*` line moves).
 * Used to fixture HK results-announcement statement text for the financials
 * extractor. Lines are plain ASCII; parens and backslashes are escaped.
 */
export function buildTextLayoutPdf(lines: string[]): Uint8Array {
  const esc = (s: string): string =>
    s.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const ops = lines
    .map((line, i) => `${i === 0 ? "" : "T* "}(${esc(line)}) Tj`)
    .join(" ");
  return buildSimplePdf(`BT ${ops} ET`);
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
