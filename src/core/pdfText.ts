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
  pages?: number;
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
 */
function latin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
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
function parseObjects(bytes: Uint8Array, text: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = objRe.exec(text)) !== null) {
    const num = Number(match[1]);
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
        dict,
        stream: bytes.subarray(dataStart, dataEnd),
      });
    } else {
      objects.set(num, { num, dict: text.slice(bodyStart, bodyEnd) });
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

/** Inflate a stream if its dict declares `/FlateDecode`, else return as-is. */
function inflateMaybe(stream: Uint8Array, dict: string): Uint8Array {
  if (/\/FlateDecode/.test(dict)) {
    return inflateZlib(stream, MAX_INFLATED_STREAM_BYTES);
  }
  return stream;
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
  } catch {
    return { text: "", notes: ["could not parse PDF object structure"] };
  }

  const fontCache = new Map<number, FontDecoder>();
  const pageObjects = [...objects.values()].filter((o) => isPageObject(o.dict));
  const pieces: string[] = [];
  let total = 0;

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
      renderStreams(collectContentStreams(page.dict, objects), fonts);
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

  if (
    visibleCharCount(assembled) < MIN_MEANINGFUL_CHARS &&
    bytes.byteLength > SCANNED_PDF_SIZE_HINT
  ) {
    notes.push("no extractable text layer (likely scanned/image PDF)");
    return { text: "", ...(pages !== undefined ? { pages } : {}), notes };
  }

  // De-duplicate notes while preserving order.
  const uniqueNotes = [...new Set(notes)];
  return {
    text: assembled,
    ...(pages !== undefined ? { pages } : {}),
    notes: uniqueNotes,
  };
}
