import { createDecipheriv, createHash } from "node:crypto";
import { inflateZlib } from "./zip.js";

/**
 * Zero-dependency, best-effort PDF *text-layer* extractor.
 *
 * This is not a PDF renderer. It walks the file at the object level, inflates
 * `/FlateDecode` content streams (via the shared `node:zlib` wrapper in
 * `zip.ts`), and pulls text out of the content-stream operators (`Tj`, `TJ`,
 * `'`, `"`). It decodes strings through either a font's `/ToUnicode` CMap
 * (composite/embedded-subset fonts — the CJK and accented-Latin cases) or a
 * WinAnsi/Latin-1 table (simple fonts). Layout fidelity — tables, columns,
 * reading order across multi-column pages — is explicitly out of scope; line
 * breaks are heuristic. When a PDF has no extractable text layer (a scanned or
 * image-only document) the result carries an honest note and empty text rather
 * than emitting garbage.
 */

export interface PdfTextResult {
  text: string;
  /** Number of `/Type /Page` objects reached (after object-stream decoding). */
  pages?: number;
  /** Declared total from the page tree's root `/Count`, when present. */
  declaredPages?: number;
  /** How many of the reached pages produced any visible text. */
  pagesWithText?: number;
  notes: string[];
}

/** Guard rails so a hostile or pathological PDF cannot exhaust memory. */
const MAX_INFLATED_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_TEXT_CHARS = 12 * 1024 * 1024;
/** A `TJ` kerning adjustment more negative than this reads as a word space. */
const TJ_SPACE_THRESHOLD = 100;
/** Below this many visible characters we treat a sizable PDF as text-less. */
const MIN_MEANINGFUL_CHARS = 50;
const SCANNED_PDF_SIZE_HINT = 20 * 1024;

interface PdfObject {
  num: number;
  /** Generation number, needed to derive per-object decryption keys. */
  gen?: number;
  dict: string;
  /** Raw (still-encoded) stream bytes, when the object carries a stream. */
  stream?: Uint8Array;
}

interface FontDecoder {
  byteWidth: 1 | 2;
  toUnicode?: Map<number, string>;
  /** Simple-font byte table used when there is no `/ToUnicode` map. */
  simpleTable: (code: number) => string;
}

// --- Low-level byte/string helpers -----------------------------------------

/**
 * Latin-1 decode round-trips every byte 1:1 to a char code, so string indices
 * equal byte offsets. That lets us scan structure with string ops while still
 * slicing exact binary stream ranges out of the original `Uint8Array`.
 *
 * `new TextDecoder("latin1")` does NOT do this: the WHATWG Encoding Standard
 * aliases "latin1" to windows-1252, which remaps the 0x80–0x9F range to typographic
 * characters (0x95 → U+2022 BULLET). Bytes in that window then no longer equal
 * their char codes, silently corrupting glyph ids in Identity-H content streams —
 * a Turkish "Ö" (glyph 0x0095) decoded as "e". Build the string from the raw
 * bytes instead so the 1:1 invariant above actually holds.
 */
function latin1(bytes: Uint8Array): string {
  let out = "";
  // Chunked to keep String.fromCharCode's argument list within engine limits
  // on large (multi-MB) content streams.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return out;
}

function isWhitespace(code: number): boolean {
  return (
    code === 0x00 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20
  );
}

function isDelimiter(code: number): boolean {
  return (
    code === 0x28 || // (
    code === 0x29 || // )
    code === 0x3c || // <
    code === 0x3e || // >
    code === 0x5b || // [
    code === 0x5d || // ]
    code === 0x7b || // {
    code === 0x7d || // }
    code === 0x2f || // /
    code === 0x25 // %
  );
}

/** UTF-16BE hex (e.g. "00e9") → JS string. Multiple units yield ligatures. */
function hexToUtf16(hex: string): string {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  // A trailing 2-digit remainder (rare, malformed) is treated as a byte.
  if (hex.length % 4 === 2) {
    out += String.fromCharCode(parseInt(hex.slice(hex.length - 2), 16));
  }
  return out;
}

// --- WinAnsi (CP1252) table for the 0x80–0x9F range ------------------------
// 0x00–0x7F is ASCII and 0xA0–0xFF matches Latin-1, so only the CP1252 window
// where WinAnsi diverges from Latin-1 needs an explicit table.
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„",
  0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ",
  0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ",
  0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“",
  0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›",
  0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function winAnsiChar(code: number): string {
  const mapped = WIN_ANSI_HIGH[code];
  if (mapped !== undefined) return mapped;
  return String.fromCharCode(code);
}

// --- Object scanning --------------------------------------------------------

/**
 * Linearly scan every `N G obj … endobj` rather than trusting the xref table —
 * more robust for extraction and tolerant of incremental updates / broken
 * offsets. Later definitions of the same object number win (mimicking an
 * updated xref).
 */
// --- Standard-security decryption (empty user password) --------------------
//
// Some issuers publish PDFs with owner-password protection: the document is
// encrypted, but the USER password is empty, so any reader opens it without
// prompting and the "protection" only restricts editing/printing. Australia's
// ASX announcement PDFs are all like this (verified live: AES-256, /R 5 /V 5,
// /P -540). Without decryption support the extractor inflates ciphertext,
// recovers nothing, and reports "no extractable text layer (likely scanned/
// image PDF)" — which is FALSE and the kind of confidently-wrong answer this
// library exists not to give. `pdftotext` opens the same files fine.
//
// So: when a document declares standard security AND the empty user password
// validates, the file key is derived and streams/strings are decrypted. If the
// empty password does NOT validate, the document is genuinely password-
// protected and that is reported as its own note — never as "no text layer".
//
// Scope is deliberately narrow: /Filter /Standard only, revisions 4 (AESV2,
// 128-bit) and 5/6 (AESV3, 256-bit), plus RC4 for older revisions 2-4. No
// public-key (/Filter /Adobe.PubSec) handling, and no password cracking — the
// only password tried is the empty one every reader tries first.

interface PdfDecryptor {
  /** Decrypt one object's stream or string bytes. */
  decrypt(data: Uint8Array, objNum: number, gen: number): Uint8Array;
}

/** Parse a PDF string value (`(literal)` or `<hex>`) following `key`. */
function readDictString(dict: string, key: string): Uint8Array | undefined {
  const index = dict.indexOf(key);
  if (index === -1) return undefined;
  let cursor = index + key.length;
  while (cursor < dict.length && isWhitespace(dict.charCodeAt(cursor))) cursor += 1;
  if (dict[cursor] === "<") {
    const end = dict.indexOf(">", cursor);
    if (end === -1) return undefined;
    const hex = dict.slice(cursor + 1, end).replace(/[^0-9a-fA-F]/g, "");
    const bytes = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }
  if (dict[cursor] === "(") {
    // readLiteralString starts INSIDE the string (its depth already counts the
    // opening paren), so skip past it.
    const { bytes } = readLiteralString(dict, cursor + 1);
    return Uint8Array.from(bytes);
  }
  return undefined;
}

function aesDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  // AES-CBC with the IV as the first 16 bytes, PKCS#7 padded.
  if (data.length <= 16) return new Uint8Array(0);
  const algorithm = key.length === 32 ? "aes-256-cbc" : "aes-128-cbc";
  const decipher = createDecipheriv(algorithm, key, data.subarray(0, 16));
  decipher.setAutoPadding(false);
  const out = Buffer.concat([
    decipher.update(Buffer.from(data.subarray(16))),
    decipher.final(),
  ]);
  const pad = out[out.length - 1] ?? 0;
  return new Uint8Array(pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out);
}

/** RC4, for pre-AES revisions. Small enough to inline; no dependency. */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) state[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (state[i] as number) + (key[i % key.length] as number)) & 0xff;
    const tmp = state[i] as number;
    state[i] = state[j] as number;
    state[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k += 1) {
    a = (a + 1) & 0xff;
    b = (b + (state[a] as number)) & 0xff;
    const tmp = state[a] as number;
    state[a] = state[b] as number;
    state[b] = tmp;
    out[k] = (data[k] as number) ^ (state[((state[a] as number) + (state[b] as number)) & 0xff] as number);
  }
  return out;
}

/** PDF standard security padding string (Algorithm 2, revisions 2-4). */
const PDF_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("md5");
  for (const part of parts) hash.update(Buffer.from(part));
  return new Uint8Array(hash.digest());
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(Buffer.from(part));
  return new Uint8Array(hash.digest());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function int32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

export interface PdfDecryptionSetup {
  decryptor?: PdfDecryptor;
  /** Set when the document is encrypted and the empty password did NOT open it. */
  passwordRequired?: boolean;
  note?: string;
}

/**
 * Build a decryptor for a document that declares `/Encrypt`, trying only the
 * empty user password. Returns `{}` for an unencrypted document.
 */
export function setUpPdfDecryption(
  text: string,
  objects: Map<number, PdfObject>,
): PdfDecryptionSetup {
  const trailerRef = text.match(/\/Encrypt\s+(\d+)\s+(\d+)\s*R/);
  if (!trailerRef) return {};
  const encrypt = objects.get(Number(trailerRef[1]));
  if (!encrypt) {
    return { note: "the PDF declares /Encrypt but its encryption dictionary could not be read" };
  }
  const dict = encrypt.dict;
  if (!/\/Filter\s*\/Standard/.test(dict)) {
    return {
      passwordRequired: true,
      note: "the PDF uses a non-standard security handler this extractor cannot open",
    };
  }
  const revision = Number(dict.match(/\/R\s+(\d+)/)?.[1] ?? 0);
  const version = Number(dict.match(/\/V\s+(\d+)/)?.[1] ?? 0);
  const permissions = Number(dict.match(/\/P\s+(-?\d+)/)?.[1] ?? 0);
  const ownerKey = readDictString(dict, "/O");
  const userKey = readDictString(dict, "/U");
  if (!ownerKey || !userKey) {
    return { passwordRequired: true, note: "the PDF's encryption dictionary is incomplete" };
  }
  // AESV3 (256-bit) uses /CFM /AESV3; AESV2 (128-bit) uses /CFM /AESV2.
  const usesAes = /\/AESV[23]/.test(dict);

  if (revision >= 5) {
    // Algorithm 2.A with an empty password: validate against /U's validation
    // salt, then unwrap the file key from /UE with /U's key salt.
    if (userKey.length < 48) {
      return { passwordRequired: true, note: "the PDF's /U entry is malformed" };
    }
    const validationSalt = userKey.subarray(32, 40);
    const keySalt = userKey.subarray(40, 48);
    const valid = bytesEqual(sha256(validationSalt), userKey.subarray(0, 32));
    const intermediate = sha256(keySalt);
    if (!valid && revision === 6) {
      // R6 hardens the hash (Algorithm 2.B). Not implemented; report honestly.
      return {
        passwordRequired: true,
        note: "the PDF uses PDF 2.0 (revision 6) encryption this extractor cannot open",
      };
    }
    if (!valid) {
      return {
        passwordRequired: true,
        note: "the PDF is password-protected (the empty user password did not open it)",
      };
    }
    const wrapped = readDictString(dict, "/UE");
    if (!wrapped || wrapped.length < 32) {
      return { passwordRequired: true, note: "the PDF's /UE entry is malformed" };
    }
    const decipher = createDecipheriv(
      "aes-256-cbc",
      Buffer.from(intermediate),
      Buffer.alloc(16),
    );
    decipher.setAutoPadding(false);
    const fileKey = new Uint8Array(
      Buffer.concat([decipher.update(Buffer.from(wrapped)), decipher.final()]),
    );
    // AESV3 uses the file key directly for every object — no per-object salt.
    return {
      decryptor: { decrypt: (data) => aesDecrypt(fileKey, data) },
      note: "the PDF was encrypted with an empty user password and was decrypted to read its text",
    };
  }

  // Revisions 2-4 (Algorithm 2): derive the key from the padded empty password.
  const lengthBits = Number(dict.match(/\/Length\s+(\d+)/)?.[1] ?? 40);
  const keyLength = revision === 2 ? 5 : Math.max(5, Math.floor(lengthBits / 8));
  const idMatch = text.match(/\/ID\s*\[\s*<([0-9a-fA-F\s]*)>/);
  const idHex = (idMatch?.[1] ?? "").replace(/[^0-9a-fA-F]/g, "");
  const idBytes = new Uint8Array(Math.floor(idHex.length / 2));
  for (let i = 0; i < idBytes.length; i += 1) {
    idBytes[i] = Number.parseInt(idHex.substr(i * 2, 2), 16);
  }
  const encryptMetadata = !/\/EncryptMetadata\s+false/.test(dict);
  const parts: Uint8Array[] = [
    PDF_PAD,
    ownerKey.subarray(0, 32),
    int32le(permissions),
    idBytes,
  ];
  if (revision >= 4 && !encryptMetadata) {
    parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
  }
  let key = md5(...parts).subarray(0, keyLength);
  if (revision >= 3) {
    for (let i = 0; i < 50; i += 1) key = md5(key.subarray(0, keyLength)).subarray(0, keyLength);
  }
  const fileKey = key.slice(0, keyLength);

  // Validate the empty user password (Algorithm 6 / 4).
  let opens: boolean;
  if (revision === 2) {
    opens = bytesEqual(rc4(fileKey, PDF_PAD), userKey.subarray(0, 32));
  } else {
    let check = md5(PDF_PAD, idBytes);
    let derived = rc4(fileKey, check);
    for (let i = 1; i <= 19; i += 1) {
      const rotated = Uint8Array.from(fileKey, (byte) => byte ^ i);
      derived = rc4(rotated, derived);
    }
    opens = bytesEqual(derived.subarray(0, 16), userKey.subarray(0, 16));
  }
  if (!opens) {
    return {
      passwordRequired: true,
      note: "the PDF is password-protected (the empty user password did not open it)",
    };
  }

  const perObjectKey = (objNum: number, gen: number): Uint8Array => {
    const salt: Uint8Array[] = [
      fileKey,
      Uint8Array.from([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff,
        gen & 0xff, (gen >> 8) & 0xff]),
    ];
    if (usesAes) salt.push(Uint8Array.from([0x73, 0x41, 0x6c, 0x54])); // "sAlT"
    return md5(...salt).subarray(0, Math.min(fileKey.length + 5, 16));
  };

  return {
    decryptor: {
      decrypt: (data, objNum, gen) => {
        const key = perObjectKey(objNum, gen);
        return usesAes ? aesDecrypt(key, data) : rc4(key, data);
      },
    },
    note: "the PDF was encrypted with an empty user password and was decrypted to read its text",
  };
}

/**
 * Decrypt every object stream in place. The encryption dictionary itself and
 * cross-reference streams are never encrypted, so both are skipped.
 */
function decryptObjects(
  objects: Map<number, PdfObject>,
  decryptor: PdfDecryptor,
  encryptObjNum: number | undefined,
): void {
  for (const obj of objects.values()) {
    if (!obj.stream) continue;
    if (obj.num === encryptObjNum) continue;
    if (/\/Type\s*\/XRef/.test(obj.dict)) continue;
    try {
      obj.stream = decryptor.decrypt(obj.stream, obj.num, obj.gen ?? 0);
    } catch {
      // A stream we cannot decrypt is left as-is; downstream inflation will
      // simply skip it, and the caller still gets whatever else decoded.
    }
  }
}

function parseObjects(bytes: Uint8Array, text: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = objRe.exec(text)) !== null) {
    const num = Number(match[1]);
    const gen = Number(match[2] ?? 0);
    const bodyStart = match.index + match[0].length;
    const endObj = text.indexOf("endobj", bodyStart);
    const bodyEnd = endObj === -1 ? text.length : endObj;
    const streamKw = text.indexOf("stream", bodyStart);

    if (streamKw !== -1 && streamKw < bodyEnd) {
      const dict = text.slice(bodyStart, streamKw);
      // Data begins after the EOL that must follow the `stream` keyword.
      let dataStart = streamKw + "stream".length;
      if (text[dataStart] === "\r") dataStart += 1;
      if (text[dataStart] === "\n") dataStart += 1;
      const dataEnd = findStreamEnd(text, dict, dataStart);
      objects.set(num, {
        num,
        gen,
        dict,
        stream: bytes.subarray(dataStart, dataEnd),
      });
    } else {
      objects.set(num, { num, gen, dict: text.slice(bodyStart, bodyEnd) });
    }
    objRe.lastIndex = bodyEnd;
  }
  return objects;
}

/**
 * Prefer the declared `/Length` (numeric — the common case) and validate it
 * lands on `endstream`; otherwise fall back to scanning for `endstream`. Indirect
 * `/Length N 0 R` refs are not resolved here (rare for content streams); the
 * scan covers them.
 */
function findStreamEnd(text: string, dict: string, dataStart: number): number {
  const lengthMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
  if (lengthMatch && lengthMatch[1] !== undefined) {
    const declared = Number(lengthMatch[1]);
    const end = dataStart + declared;
    const tail = text.slice(end, end + 20);
    if (/^\s*endstream/.test(tail)) return end;
  }
  const marker = text.indexOf("endstream", dataStart);
  if (marker === -1) return text.length;
  let end = marker;
  if (text[end - 1] === "\n") end -= 1;
  if (text[end - 1] === "\r") end -= 1;
  return end;
}

// --- Dictionary micro-parsing (small, targeted; not a full PDF parser) ------

/** Extract the inner text of the balanced `<<…>>` starting at `open`. */
function balancedDict(s: string, open: number): string | null {
  if (s[open] !== "<" || s[open + 1] !== "<") return null;
  let depth = 0;
  for (let i = open; i < s.length - 1; i += 1) {
    if (s[i] === "<" && s[i + 1] === "<") {
      depth += 1;
      i += 1;
    } else if (s[i] === ">" && s[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return s.slice(open + 2, i - 1);
    }
  }
  return null;
}

/**
 * Resolve the value that follows `/Key` in `dict` to either an inline `<<…>>`
 * dictionary body or the dictionary of the indirect object it points at.
 */
function resolveDictValue(
  dict: string,
  key: string,
  objects: Map<number, PdfObject>,
): string | null {
  const idx = dict.indexOf(key);
  if (idx === -1) return null;
  let i = idx + key.length;
  while (i < dict.length && isWhitespace(dict.charCodeAt(i))) i += 1;
  if (dict[i] === "<" && dict[i + 1] === "<") {
    return balancedDict(dict, i);
  }
  const ref = dict.slice(i).match(/^(\d+)\s+\d+\s+R/);
  if (ref && ref[1] !== undefined) {
    const target = objects.get(Number(ref[1]));
    return target ? target.dict : null;
  }
  return null;
}

/** Collect the object numbers a `/Contents` entry references (single or array). */
function contentRefs(dict: string): number[] {
  const single = dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
  if (single && single[1] !== undefined) return [Number(single[1])];
  const arrayMatch = dict.match(/\/Contents\s*\[([^\]]*)\]/);
  if (arrayMatch && arrayMatch[1] !== undefined) {
    const refs: number[] = [];
    const refRe = /(\d+)\s+\d+\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(arrayMatch[1])) !== null) {
      if (m[1] !== undefined) refs.push(Number(m[1]));
    }
    return refs;
  }
  return [];
}

// --- Font / ToUnicode handling ---------------------------------------------

/**
 * Parse a `/ToUnicode` CMap's `beginbfchar`/`beginbfrange` sections into a
 * code→string map, inferring the source-code byte width from the hex length.
 */
function parseToUnicode(cmap: string): { map: Map<number, string>; byteWidth: 1 | 2 } {
  const map = new Map<number, string>();
  let maxSrcBytes = 1;

  const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = charBlock.exec(cmap)) !== null) {
    const body = block[1] ?? "";
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairRe.exec(body)) !== null) {
      const src = pair[1] ?? "";
      const dst = pair[2] ?? "";
      maxSrcBytes = Math.max(maxSrcBytes, Math.ceil(src.length / 2));
      map.set(parseInt(src, 16), hexToUtf16(dst));
    }
  }

  const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeBlock.exec(cmap)) !== null) {
    const body = block[1] ?? "";
    // Form A: <lo> <hi> <dst>
    const scalarRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = scalarRe.exec(body)) !== null) {
      const lo = parseInt(m[1] ?? "0", 16);
      const hi = parseInt(m[2] ?? "0", 16);
      const dstHex = m[3] ?? "";
      maxSrcBytes = Math.max(maxSrcBytes, Math.ceil((m[1] ?? "").length / 2));
      const base = parseInt(dstHex.slice(-4).padStart(4, "0"), 16);
      const prefix = dstHex.length > 4 ? hexToUtf16(dstHex.slice(0, -4)) : "";
      for (let code = lo, i = 0; code <= hi && i <= 0xffff; code += 1, i += 1) {
        map.set(code, prefix + String.fromCharCode((base + i) & 0xffff));
      }
    }
    // Form B: <lo> <hi> [ <d0> <d1> … ]
    const arrayRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((m = arrayRe.exec(body)) !== null) {
      const lo = parseInt(m[1] ?? "0", 16);
      maxSrcBytes = Math.max(maxSrcBytes, Math.ceil((m[1] ?? "").length / 2));
      const items = (m[3] ?? "").match(/<([0-9A-Fa-f]+)>/g) ?? [];
      items.forEach((item, i) => {
        const hex = item.slice(1, -1);
        map.set(lo + i, hexToUtf16(hex));
      });
    }
  }

  return { map, byteWidth: maxSrcBytes >= 2 ? 2 : 1 };
}

/**
 * Build a decoder for one font object: `/ToUnicode` CMap when present (the
 * reliable path for embedded/CJK fonts), else a WinAnsi/Latin-1 simple table.
 */
function buildFontDecoder(
  fontDict: string,
  objects: Map<number, PdfObject>,
  fontName: string,
  notes: string[],
): FontDecoder {
  const subtype = fontDict.match(/\/Subtype\s*\/(\w+)/)?.[1] ?? "";
  const isType0 = subtype === "Type0";

  const toUnicodeRef = fontDict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
  if (toUnicodeRef && toUnicodeRef[1] !== undefined) {
    const stream = objects.get(Number(toUnicodeRef[1]))?.stream;
    if (stream) {
      try {
        const cmap = latin1(inflateMaybe(stream, objects.get(Number(toUnicodeRef[1]))!.dict));
        const parsed = parseToUnicode(cmap);
        if (parsed.map.size > 0) {
          return {
            byteWidth: parsed.byteWidth,
            toUnicode: parsed.map,
            simpleTable: winAnsiChar,
          };
        }
      } catch {
        // fall through to the simple-font path
      }
    }
  }

  const encoding = fontDict.match(/\/Encoding\s*\/(\w+)/)?.[1] ?? "";
  if (isType0) {
    notes.push(
      `no /ToUnicode map for composite font ${fontName}; its glyph codes could ` +
        "not be mapped to text (some characters may be missing or wrong).",
    );
    return { byteWidth: 2, simpleTable: () => "" };
  }
  if (encoding && !/WinAnsi|Standard|PDFDoc/.test(encoding)) {
    notes.push(
      `font ${fontName} uses ${encoding} without a /ToUnicode map; some ` +
        "characters may be mis-decoded.",
    );
  }
  // WinAnsi is a superset of ASCII + Latin-1 for our purposes, so it is the safe
  // default for a simple font whether it declared WinAnsi, Standard, or nothing.
  return { byteWidth: 1, simpleTable: winAnsiChar };
}

/**
 * Inflate a stream if its dict declares `/FlateDecode`, then reverse a
 * `/DecodeParms` predictor when one is declared. Content and `/ToUnicode`
 * streams carry no predictor, so the extra step is a no-op for them; it matters
 * for the object-stream / cross-reference-stream case that modern PDFs use.
 */
function inflateMaybe(stream: Uint8Array, dict: string): Uint8Array {
  let data = /\/FlateDecode/.test(dict)
    ? inflateZlib(stream, MAX_INFLATED_STREAM_BYTES)
    : stream;
  const parms = parseDecodeParms(dict);
  if (parms) data = applyPredictor(data, parms);
  return data;
}

interface PredictorParams {
  predictor: number;
  colors: number;
  bitsPerComponent: number;
  columns: number;
}

/**
 * Read a `/DecodeParms` (or `/DP`) predictor spec off a stream dict. Returns
 * null when there is no predictor (or `/Predictor 1`, the identity), so the
 * caller skips predictor handling entirely for the common case.
 */
function parseDecodeParms(dict: string): PredictorParams | null {
  const idx = (() => {
    const a = dict.indexOf("/DecodeParms");
    if (a !== -1) return a + "/DecodeParms".length;
    const b = dict.indexOf("/DP");
    return b === -1 ? -1 : b + "/DP".length;
  })();
  if (idx === -1) return null;
  let i = idx;
  while (i < dict.length && isWhitespace(dict.charCodeAt(i))) i += 1;
  const body = dict[i] === "<" && dict[i + 1] === "<" ? balancedDict(dict, i) : dict;
  if (body === null) return null;
  const predictor = Number(body.match(/\/Predictor\s+(\d+)/)?.[1] ?? "1");
  if (!Number.isInteger(predictor) || predictor <= 1) return null;
  return {
    predictor,
    colors: Number(body.match(/\/Colors\s+(\d+)/)?.[1] ?? "1"),
    bitsPerComponent: Number(body.match(/\/BitsPerComponent\s+(\d+)/)?.[1] ?? "8"),
    columns: Number(body.match(/\/Columns\s+(\d+)/)?.[1] ?? "1"),
  };
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Reverse a PDF stream predictor (TIFF Predictor 2, or the PNG family 10–15
 * where each row is prefixed with a filter-type byte). Used for xref streams —
 * which always predict — and the rare object stream that declares one. Operates
 * on whole bytes (BitsPerComponent 8, the only width these streams use here).
 */
function applyPredictor(data: Uint8Array, p: PredictorParams): Uint8Array {
  const bpp = Math.max(1, Math.ceil((p.colors * p.bitsPerComponent) / 8));
  const rowLen = Math.ceil((p.colors * p.bitsPerComponent * p.columns) / 8);
  if (rowLen <= 0) return data;

  if (p.predictor === 2) {
    // TIFF predictor 2: no per-row tag; each sample adds the one bpp to its left.
    const out = new Uint8Array(data);
    const rows = Math.floor(out.length / rowLen);
    for (let r = 0; r < rows; r += 1) {
      const base = r * rowLen;
      for (let i = bpp; i < rowLen; i += 1) {
        out[base + i] = ((out[base + i] ?? 0) + (out[base + i - bpp] ?? 0)) & 0xff;
      }
    }
    return out;
  }

  // PNG predictors: [filterType, ...rowLen bytes] per row.
  const stride = rowLen + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r += 1) {
    const filterType = data[r * stride] ?? 0;
    const rowStart = r * stride + 1;
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i += 1) {
      const raw = data[rowStart + i] ?? 0;
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      let value: number;
      switch (filterType) {
        case 1: value = raw + a; break;
        case 2: value = raw + b; break;
        case 3: value = raw + ((a + b) >> 1); break;
        case 4: value = raw + paethPredictor(a, b, c); break;
        default: value = raw; break; // 0 = None
      }
      cur[i] = value & 0xff;
    }
    out.set(cur, r * rowLen);
    prev = cur;
  }
  return out;
}

/**
 * PDF 1.5+ compressed object streams (`/Type /ObjStm`) pack many indirect
 * objects — page nodes and font/`ToUnicode`-referencing dictionaries, though
 * never stream objects themselves — into one FlateDecode stream that the linear
 * `N G obj` scan cannot see. A modern "glossy" filing can therefore hide its
 * consolidated statements inside them (the CK Hutchison case: 33 of 183 pages
 * reachable). Decode every ObjStm and surface its embedded objects into the
 * same map, filling only the gaps the linear scan left so linear (and
 * incrementally-updated) definitions stay authoritative.
 */
function mergeObjectStreams(objects: Map<number, PdfObject>): void {
  for (const container of [...objects.values()]) {
    if (!container.stream || !/\/Type\s*\/ObjStm/.test(container.dict)) continue;
    let decoded: Uint8Array;
    try {
      decoded = inflateMaybe(container.stream, container.dict);
    } catch {
      continue; // an undecodable ObjStm leaves its objects unreachable (detected later)
    }
    const count = Number(container.dict.match(/\/N\s+(\d+)/)?.[1] ?? "");
    const first = Number(container.dict.match(/\/First\s+(\d+)/)?.[1] ?? "");
    if (
      !Number.isInteger(count) || count <= 0 ||
      !Number.isInteger(first) || first < 0 || first > decoded.length
    ) {
      continue;
    }
    const ints = latin1(decoded.subarray(0, first)).match(/\d+/g);
    if (!ints || ints.length < count * 2) continue;
    const entries: Array<{ num: number; offset: number }> = [];
    for (let i = 0; i < count; i += 1) {
      entries.push({
        num: Number(ints[i * 2]),
        offset: Number(ints[i * 2 + 1]),
      });
    }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry) continue;
      const start = first + entry.offset;
      const nextEntry = entries[i + 1];
      const end = nextEntry ? first + nextEntry.offset : decoded.length;
      if (start < 0 || end > decoded.length || start > end) continue;
      if (objects.has(entry.num)) continue; // linear scan wins
      objects.set(entry.num, { num: entry.num, dict: latin1(decoded.subarray(start, end)) });
    }
  }
}

/**
 * The declared total page count from the page tree's root `/Pages` node (its
 * `/Count`). Comparing this against the number of page objects actually reached
 * is the honest guard for a document whose pages remain locked in an ObjStm /
 * xref stream this extractor still cannot decode.
 */
function readDeclaredPageCount(objects: Map<number, PdfObject>): number | undefined {
  let max: number | undefined;
  for (const obj of objects.values()) {
    if (!/\/Type\s*\/Pages(?![a-zA-Z])/.test(obj.dict)) continue;
    const count = Number(obj.dict.match(/\/Count\s+(\d+)/)?.[1] ?? "");
    if (Number.isInteger(count) && (max === undefined || count > max)) max = count;
  }
  return max;
}

/**
 * Map a page's `/Resources` `/Font` names (e.g. `/F1`) to decoders. Returns an
 * empty map on any structural surprise — the caller then falls back to a safe
 * default decoder rather than failing the whole extraction.
 */
function buildPageFonts(
  pageDict: string,
  objects: Map<number, PdfObject>,
  notes: string[],
  cache: Map<number, FontDecoder>,
): Map<string, FontDecoder> {
  const fonts = new Map<string, FontDecoder>();
  const resources = resolveDictValue(pageDict, "/Resources", objects);
  if (!resources) return fonts;
  const fontDict = resolveDictValue(resources, "/Font", objects);
  if (!fontDict) return fonts;

  const entryRe = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(fontDict)) !== null) {
    const name = m[1];
    const objNum = Number(m[2]);
    if (name === undefined) continue;
    let decoder = cache.get(objNum);
    if (!decoder) {
      const fontObj = objects.get(objNum);
      if (!fontObj) continue;
      decoder = buildFontDecoder(fontObj.dict, objects, `/${name}`, notes);
      cache.set(objNum, decoder);
    }
    fonts.set(name, decoder);
  }
  return fonts;
}

// --- Content-stream tokenizer ----------------------------------------------

type Token =
  | { kind: "str"; bytes: number[] }
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "array"; items: Token[] }
  | { kind: "op"; value: string };

/** Read a literal `(…)` string body starting just after the opening paren. */
function readLiteralString(s: string, start: number): { bytes: number[]; next: number } {
  const bytes: number[] = [];
  let depth = 1;
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const esc = s[i + 1];
      switch (esc) {
        case "n": bytes.push(0x0a); i += 2; break;
        case "r": bytes.push(0x0d); i += 2; break;
        case "t": bytes.push(0x09); i += 2; break;
        case "b": bytes.push(0x08); i += 2; break;
        case "f": bytes.push(0x0c); i += 2; break;
        case "(": bytes.push(0x28); i += 2; break;
        case ")": bytes.push(0x29); i += 2; break;
        case "\\": bytes.push(0x5c); i += 2; break;
        case "\r": i += s[i + 2] === "\n" ? 3 : 2; break; // line continuation
        case "\n": i += 2; break; // line continuation
        default:
          if (esc !== undefined && esc >= "0" && esc <= "7") {
            let oct = "";
            let j = i + 1;
            for (; j < s.length && oct.length < 3; j += 1) {
              const cj = s[j];
              if (cj === undefined || cj < "0" || cj > "7") break;
              oct += cj;
            }
            bytes.push(parseInt(oct, 8) & 0xff);
            i = j;
          } else {
            if (esc !== undefined) bytes.push(esc.charCodeAt(0));
            i += 2;
          }
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      bytes.push(0x28);
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { bytes, next: i + 1 };
      bytes.push(0x29);
      i += 1;
      continue;
    }
    bytes.push(s.charCodeAt(i) & 0xff);
    i += 1;
  }
  return { bytes, next: i };
}

function readHexString(s: string, start: number): { bytes: number[]; next: number } {
  let hex = "";
  let i = start;
  while (i < s.length && s[i] !== ">") {
    const c = s[i];
    if (c !== undefined && /[0-9A-Fa-f]/.test(c)) hex += c;
    i += 1;
  }
  if (hex.length % 2 === 1) hex += "0";
  const bytes: number[] = [];
  for (let j = 0; j < hex.length; j += 2) {
    bytes.push(parseInt(hex.slice(j, j + 2), 16));
  }
  return { bytes, next: i + 1 };
}

/** Tokenize a content stream. `depth` guards the single level of `[]` nesting. */
function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  const stack: Token[][] = [tokens];
  let i = 0;
  const push = (t: Token): void => {
    const top = stack[stack.length - 1];
    if (top) top.push(t);
  };

  while (i < s.length) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (isWhitespace(code)) {
      i += 1;
      continue;
    }
    if (ch === "%") {
      // comment to end of line
      while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i += 1;
      continue;
    }
    if (ch === "(") {
      const r = readLiteralString(s, i + 1);
      push({ kind: "str", bytes: r.bytes });
      i = r.next;
      continue;
    }
    if (ch === "<" && s[i + 1] === "<") {
      // Inline dict (marked-content properties etc.) — skip it wholesale.
      const inner = balancedDict(s, i);
      i = inner === null ? i + 2 : i + inner.length + 4;
      continue;
    }
    if (ch === "<") {
      const r = readHexString(s, i + 1);
      push({ kind: "str", bytes: r.bytes });
      i = r.next;
      continue;
    }
    if (ch === "[") {
      const arr: Token = { kind: "array", items: [] };
      push(arr);
      stack.push(arr.items);
      i += 1;
      continue;
    }
    if (ch === "]") {
      if (stack.length > 1) stack.pop();
      i += 1;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      while (j < s.length && !isWhitespace(s.charCodeAt(j)) && !isDelimiter(s.charCodeAt(j))) {
        j += 1;
      }
      push({ kind: "name", value: s.slice(i + 1, j) });
      i = j;
      continue;
    }
    if ((code >= 0x30 && code <= 0x39) || ch === "+" || ch === "-" || ch === ".") {
      let j = i + 1;
      while (j < s.length) {
        const cj = s[j];
        if (cj !== undefined && (/[0-9.\-+eE]/.test(cj))) j += 1;
        else break;
      }
      const value = Number(s.slice(i, j));
      push({ kind: "num", value: Number.isFinite(value) ? value : 0 });
      i = j;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === ">") {
      i += 1;
      continue;
    }
    // Operator keyword
    let j = i + 1;
    while (j < s.length && !isWhitespace(s.charCodeAt(j)) && !isDelimiter(s.charCodeAt(j))) {
      j += 1;
    }
    push({ kind: "op", value: s.slice(i, j) });
    i = j;
  }
  return tokens;
}

// --- Text assembly ----------------------------------------------------------

function decodeString(bytes: number[], font: FontDecoder): string {
  let out = "";
  if (font.byteWidth === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const b0 = bytes[i] ?? 0;
      const b1 = bytes[i + 1] ?? 0;
      const code = (b0 << 8) | b1;
      out += font.toUnicode?.get(code) ?? "";
    }
    // Odd trailing byte (malformed) is dropped.
    return out;
  }
  for (const b of bytes) {
    const code = b ?? 0;
    out += font.toUnicode?.get(code) ?? font.simpleTable(code);
  }
  return out;
}

const DEFAULT_FONT: FontDecoder = { byteWidth: 1, simpleTable: winAnsiChar };

/**
 * Walk a page's (concatenated) content-stream tokens, emitting text with
 * heuristic line breaks: vertical text moves (`Td`/`TD` with ty≠0, `T*`, `Tm`,
 * `'`, `"`) start a new line; large negative `TJ` kerning reads as a space.
 */
function renderContent(tokens: Token[], fonts: Map<string, FontDecoder>): string {
  let out = "";
  let current = DEFAULT_FONT;
  const operands: Token[] = [];
  const numAt = (n: number): number => {
    const t = operands[operands.length - n];
    return t && t.kind === "num" ? t.value : 0;
  };

  for (const token of tokens) {
    if (token.kind !== "op") {
      operands.push(token);
      continue;
    }
    switch (token.value) {
      case "Tf": {
        const nameTok = operands[operands.length - 2];
        if (nameTok && nameTok.kind === "name") {
          current = fonts.get(nameTok.value) ?? DEFAULT_FONT;
        }
        break;
      }
      case "Tj":
      case "TJ": {
        const last = operands[operands.length - 1];
        if (token.value === "Tj" && last && last.kind === "str") {
          out += decodeString(last.bytes, current);
        } else if (last && last.kind === "array") {
          for (const item of last.items) {
            if (item.kind === "str") out += decodeString(item.bytes, current);
            else if (item.kind === "num" && item.value <= -TJ_SPACE_THRESHOLD) {
              out += " ";
            }
          }
        }
        break;
      }
      case "'": {
        const last = operands[operands.length - 1];
        out += "\n";
        if (last && last.kind === "str") out += decodeString(last.bytes, current);
        break;
      }
      case '"': {
        const last = operands[operands.length - 1];
        out += "\n";
        if (last && last.kind === "str") out += decodeString(last.bytes, current);
        break;
      }
      case "Td":
      case "TD": {
        const ty = numAt(1);
        const tx = numAt(2);
        if (Math.abs(ty) > 0) out += "\n";
        else if (Math.abs(tx) > 0 && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
        break;
      }
      case "T*":
      case "Tm":
        out += "\n";
        break;
      default:
        break;
    }
    operands.length = 0;
  }
  return out;
}

// --- Page discovery + assembly ---------------------------------------------

function isPageObject(dict: string): boolean {
  return /\/Type\s*\/Page(?![a-zA-Z])/.test(dict);
}

function isImageOrOtherFilter(dict: string): boolean {
  return (
    /\/Subtype\s*\/Image/.test(dict) ||
    /\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(dict)
  );
}

function collectContentStreams(
  pageDict: string,
  objects: Map<number, PdfObject>,
): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (const ref of contentRefs(pageDict)) {
    const obj = objects.get(ref);
    if (!obj || !obj.stream || isImageOrOtherFilter(obj.dict)) continue;
    try {
      parts.push(inflateMaybe(obj.stream, obj.dict));
    } catch {
      // Skip a stream we cannot inflate; note-worthy but not fatal.
    }
  }
  return parts;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .trimEnd();
}

function visibleCharCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * Fraction of visible characters that are letters or digits. Genuine prose (any
 * script — CJK letters count) sits well above 0.5; a PDF decoded through the
 * wrong font encoding (a custom-encoded embedded subset with no `/ToUnicode`
 * map) collapses into punctuation/symbol soup near 0. Used to catch that
 * "looks like text but is garbage" case so we can be honest instead.
 */
function alnumRatio(text: string): number {
  const visible = visibleCharCount(text);
  if (visible === 0) return 0;
  const alnum = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return alnum / visible;
}

const MIN_GARBLE_SAMPLE = 200;
const MIN_ALNUM_RATIO = 0.35;

/**
 * Extract a best-effort text layer from a PDF's raw bytes.
 *
 * @returns `text` (may be empty), an optional `pages` count, and `notes` that
 *   honestly describe any degradation (missing `/ToUnicode`, scanned/image PDF,
 *   un-inflatable streams). Never throws for malformed input — it returns an
 *   empty result with a note instead.
 */
export function extractPdfText(bytes: Uint8Array): PdfTextResult {
  const notes: string[] = [];
  if (bytes.byteLength < 5 || latin1(bytes.subarray(0, 5)) !== "%PDF-") {
    return { text: "", notes: ["input does not start with %PDF- (not a PDF)"] };
  }

  const text = latin1(bytes);
  let objects: Map<number, PdfObject>;
  try {
    objects = parseObjects(bytes, text);
    // Decryption must run BEFORE object streams are merged: an /ObjStm's own
    // bytes are encrypted too, so merging first would inflate ciphertext.
    const encryption = setUpPdfDecryption(text, objects);
    if (encryption.note) notes.push(encryption.note);
    if (encryption.passwordRequired) {
      // Say the document is locked. Reporting "no text layer" here would be a
      // confidently wrong answer about a document that may be full of text.
      return { text: "", notes: [...new Set(notes)] };
    }
    if (encryption.decryptor) {
      const encryptObjNum = Number(text.match(/\/Encrypt\s+(\d+)\s+\d+\s*R/)?.[1]);
      decryptObjects(
        objects,
        encryption.decryptor,
        Number.isFinite(encryptObjNum) ? encryptObjNum : undefined,
      );
    }
    mergeObjectStreams(objects);
  } catch {
    return { text: "", notes: ["could not parse PDF object structure"] };
  }

  const fontCache = new Map<number, FontDecoder>();
  const declaredPages = readDeclaredPageCount(objects);
  const pageObjects = [...objects.values()].filter((o) => isPageObject(o.dict));
  const pieces: string[] = [];
  let total = 0;
  let pagesWithText = 0;

  const renderStreams = (streams: Uint8Array[], fonts: Map<string, FontDecoder>): void => {
    for (const stream of streams) {
      if (total > MAX_TOTAL_TEXT_CHARS) return;
      const rendered = renderContent(tokenize(latin1(stream)), fonts);
      total += rendered.length;
      pieces.push(rendered);
    }
  };

  if (pageObjects.length > 0) {
    for (const page of pageObjects) {
      const fonts = buildPageFonts(page.dict, objects, notes, fontCache);
      let pageText = "";
      for (const stream of collectContentStreams(page.dict, objects)) {
        if (total > MAX_TOTAL_TEXT_CHARS) break;
        const rendered = renderContent(tokenize(latin1(stream)), fonts);
        total += rendered.length;
        pageText += rendered;
      }
      if (visibleCharCount(pageText) > 0) pagesWithText += 1;
      pieces.push(pageText);
      pieces.push("\n");
    }
  } else {
    // No identifiable /Type /Page objects: fall back to every content-looking
    // stream in object order, with a default decoder.
    const fonts = new Map<string, FontDecoder>();
    for (const obj of objects.values()) {
      if (!obj.stream || isImageOrOtherFilter(obj.dict)) continue;
      if (/\/Type\s*\/(XObject|Metadata|XRef|ObjStm)/.test(obj.dict)) continue;
      if (/\/ToUnicode|\/FontFile/.test(obj.dict)) continue;
      try {
        renderStreams([inflateMaybe(obj.stream, obj.dict)], fonts);
      } catch {
        /* skip */
      }
    }
  }

  const assembled = normalizeWhitespace(pieces.join(""));
  const pages = pageObjects.length > 0 ? pageObjects.length : undefined;
  const visible = visibleCharCount(assembled);
  const pageMeta = {
    ...(pages !== undefined ? { pages } : {}),
    ...(declaredPages !== undefined ? { declaredPages } : {}),
    ...(pageObjects.length > 0 ? { pagesWithText } : {}),
  };

  // Honest degradation guard: fewer page objects reached than the page tree
  // declared means some pages stayed locked in an object/xref stream we could
  // not decode. Rare after ObjStm support, but it must never pass silently.
  if (declaredPages !== undefined && pages !== undefined && pages < declaredPages) {
    notes.push(
      `reached ${pages} of ${declaredPages} declared pages — the remainder are in ` +
        "compressed object streams this extractor could not decode",
    );
  }

  if (visible < MIN_MEANINGFUL_CHARS && bytes.byteLength > SCANNED_PDF_SIZE_HINT) {
    notes.push("no extractable text layer (likely scanned/image PDF)");
    return { text: "", ...pageMeta, notes: [...new Set(notes)] };
  }

  // Text came out, but if it is dominated by punctuation/symbols it was decoded
  // through the wrong font encoding — serving it would be emitting garbage. Be
  // honest and return no text with an explanatory note instead.
  if (visible >= MIN_GARBLE_SAMPLE && alnumRatio(assembled) < MIN_ALNUM_RATIO) {
    notes.push(
      "no reliable text layer — the PDF's fonts use custom encodings with no " +
        "/ToUnicode map, so glyph codes could not be mapped to characters " +
        "(the original PDF is readable via mode=\"pdf\")",
    );
    return { text: "", ...pageMeta, notes: [...new Set(notes)] };
  }

  // De-duplicate notes while preserving order.
  const uniqueNotes = [...new Set(notes)];
  return {
    text: assembled,
    ...pageMeta,
    notes: uniqueNotes,
  };
}
