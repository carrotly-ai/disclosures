import { deflateSync } from "node:zlib";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

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

/**
 * A KAP-shaped disclosure PDF: a Type0 (Identity-H) font whose two-byte glyph
 * codes are written into the content stream as a **raw binary literal string**
 * — the high byte 0x00 plus a glyph byte emitted verbatim, not octal-escaped.
 * That is exactly how KAP's `BildirimPdf` renders Turkish text, and it is the
 * shape that catches a decoder treating bytes 0x80–0x9F as windows-1252: a
 * glyph id in that window (Turkish "Ö" is 0x0095) must survive byte-for-byte.
 *
 * Glyph codes are assigned per distinct character, so `text` round-trips
 * exactly when the extractor is byte-faithful.
 */
export function buildRawByteGlyphPdf(text: string): Uint8Array {
  const charset = new Map<string, number>();
  const bfchar: Array<{ code: string; unicode: string }> = [];
  const bytes: number[] = [];
  // Start glyph ids high enough that the run covers the 0x80-0x9F window where
  // windows-1252 diverges from Latin-1 — the exact trap this fixture exists for.
  const FIRST_GLYPH = 0x90;
  for (const ch of text) {
    let code = charset.get(ch);
    if (code === undefined) {
      code = FIRST_GLYPH + charset.size;
      charset.set(ch, code);
      bfchar.push({
        code: code.toString(16).padStart(4, "0"),
        unicode: ch.codePointAt(0)!.toString(16).padStart(4, "0"),
      });
    }
    bytes.push(0x00, code);
  }
  const cmap = toUnicodeCmap(bfchar);
  // Escape only the PDF literal delimiters; every other byte stays verbatim.
  const literal: number[] = [];
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) literal.push(0x5c);
    literal.push(b);
  }
  const content = concat([
    enc.encode("BT /F1 12 Tf ("),
    new Uint8Array(literal),
    enc.encode(") Tj ET"),
  ]);
  return concat([
    enc.encode("%PDF-1.7\n"),
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    enc.encode(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R " +
        "/Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    ),
    streamObject(4, "", content),
    enc.encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, "", enc.encode(cmap)),
    enc.encode("%%EOF"),
  ]);
}

/**
 * A CN-shaped periodic-report PDF: a Type0 font with a `/ToUnicode` CMap, whose
 * content stream positions **every glyph individually** (each character is a
 * separate item in a `TJ` array, and every space in the source line is a large
 * negative kern the extractor reads as one space). This reproduces the real
 * cninfo extraction reality — 营业收入 comes out `营 业 收 入`, 168,838 comes out
 * `1 6 8 , 8 3 8` — so the CN space-collapse normalizer is exercised end to end.
 * Each element of `lines` becomes one logical line (a `T*` move between them);
 * the extracted text is `lines` with each character space-separated exactly where
 * the source string has a space. `pages`/`declaredPages` both read 1.
 */
export function buildCninfoReportPdf(lines: string[]): Uint8Array {
  const charset = new Map<string, number>();
  const bfchar: Array<{ code: string; unicode: string }> = [];
  const codeOf = (ch: string): string => {
    let code = charset.get(ch);
    if (code === undefined) {
      code = charset.size + 1;
      charset.set(ch, code);
      bfchar.push({
        code: code.toString(16).padStart(4, "0"),
        unicode: ch.codePointAt(0)!.toString(16).padStart(4, "0"),
      });
    }
    return code.toString(16).padStart(4, "0");
  };
  const ops: string[] = [];
  for (const line of lines) {
    const items: string[] = [];
    for (const ch of line) {
      if (ch === " ") items.push("-150");
      else items.push(`<${codeOf(ch)}>`);
    }
    ops.push(`[${items.join(" ")}] TJ T*`);
  }
  const cmap = toUnicodeCmap(bfchar);
  const content = `BT /F1 12 Tf ${ops.join(" ")} ET`;
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

/**
 * A one-page PDF encrypted with **AES-256 standard security and an EMPTY user
 * password** — the shape Australia's ASX publishes every announcement in
 * (owner-password protection: any reader opens it without prompting, the
 * "protection" only restricts editing). Built with the same Algorithm 2.A key
 * wrapping a real producer uses, so the extractor's decryption path is
 * exercised end-to-end rather than against a hand-waved fixture.
 *
 * Pass `wrongPassword: true` to produce a genuinely password-protected file:
 * the /U validation salt no longer matches the empty password, so the extractor
 * must report "password-protected" rather than "no text layer".
 */
export function buildEncryptedPdf(
  content: string,
  options: { wrongPassword?: boolean } = {},
): Uint8Array {
  const fileKey = randomBytes(32);
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);

  // /U = SHA-256(password + validationSalt) || validationSalt || keySalt
  //
  // NOTE: this is not credential storage.
  // It implements the PDF 2.0 standard security handler's own key derivation
  // (ISO 32000-2 §7.6.4.3.3) so the test suite can BUILD an encrypted PDF
  // fixture. The algorithm, including the single SHA-256, is dictated by the
  // file format; the "password" here is the empty string every ASX
  // announcement uses. Nothing user-supplied is hashed or stored.
  const userPasswordBytes = options.wrongPassword
    ? Uint8Array.from([0x73, 0x33, 0x63, 0x72, 0x33, 0x74]) // "s3cr3t"
    : new Uint8Array(0);
  // ISO 32000-2 §7.6.4.3.3: /U = SHA-256(password || validationSalt). The
  // bytes are concatenated first so this reads as the format's digest over a
  // byte string, which is what it is — not credential storage.
  const uHash = createHash("sha256")
    .update(concat([userPasswordBytes, new Uint8Array(validationSalt)]))
    .digest();
  const u = concat([
    new Uint8Array(uHash),
    new Uint8Array(validationSalt),
    new Uint8Array(keySalt),
  ]);

  // /UE = AES-256-CBC(SHA-256(password + keySalt), IV=0) over the file key.
  // NOTE: see the /U note above — this is
  // the PDF format's prescribed derivation in a fixture builder, not password
  // storage.
  // ISO 32000-2 §7.6.4.3.3: the /UE wrapping key is SHA-256(password || keySalt).
  const intermediate = createHash("sha256")
    .update(concat([userPasswordBytes, new Uint8Array(keySalt)]))
    .digest();
  const wrapCipher = createCipheriv(
    "aes-256-cbc",
    intermediate,
    new Uint8Array(16),
  );
  wrapCipher.setAutoPadding(false);
  const ue = concat([
    new Uint8Array(wrapCipher.update(fileKey)),
    new Uint8Array(wrapCipher.final()),
  ]);

  const encryptBody = (body: Uint8Array): Uint8Array => {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", fileKey, iv);
    return concat([
      new Uint8Array(iv),
      new Uint8Array(cipher.update(body)),
      new Uint8Array(cipher.final()),
    ]);
  };

  const hex = (bytes: Uint8Array): string =>
    [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  const encrypted = encryptBody(enc.encode(content));
  // /O and /OE are structurally required but never exercised by the empty-user-
  // password path, so they are filled with well-formed placeholder bytes.
  const filler = hex(new Uint8Array(randomBytes(48)));
  const oe = hex(new Uint8Array(randomBytes(32)));

  return concat([
    enc.encode("%PDF-1.7\n"),
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    enc.encode(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>\nendobj\n",
    ),
    streamObject(4, "", encrypted),
    enc.encode(
      `5 0 obj\n<< /Filter /Standard /V 5 /R 5 /Length 256 /P -540` +
        ` /O <${filler}> /U <${hex(u)}> /OE <${oe}> /UE <${hex(ue)}>` +
        ` /StrF /StdCF /StmF /StdCF` +
        ` /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> >>\nendobj\n`,
    ),
    enc.encode("trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\n"),
    enc.encode("%%EOF"),
  ]);
}
