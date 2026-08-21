import { inflateRawSync } from "node:zlib";

/**
 * Inflate a zlib-wrapped DEFLATE stream — the container PDF `/FlateDecode` uses
 * (a 2-byte zlib header followed by raw DEFLATE and a trailing adler32). We skip
 * the 2-byte header and inflate the raw DEFLATE body; `inflateRawSync` stops at
 * the final block, so the trailing adler is harmlessly ignored. Kept here so the
 * one `node:zlib` dependency stays centralized in this module rather than
 * spreading a second import across the codebase — `pdfText.ts` inflates content
 * streams through this entry point. Falls back to a headerless raw-DEFLATE read
 * for the producers that emit one, matching the extractor's best-effort bar.
 */
export function inflateZlib(data: Uint8Array, maxOutputLength?: number): Uint8Array {
  const options =
    maxOutputLength && maxOutputLength > 0 ? { maxOutputLength } : {};
  try {
    return new Uint8Array(inflateRawSync(data.subarray(2), options));
  } catch {
    // No (or malformed) zlib header: retry as headerless raw DEFLATE.
    return new Uint8Array(inflateRawSync(data, options));
  }
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const MAX_EOCD_SEARCH = 65_557;

export interface ZipReaderOptions {
  maxEntries?: number;
  maxEntrySize?: number;
  maxCompressedSize?: number;
  maxTotalSize?: number;
  /**
   * Optional member filter, tested against each central-directory file name. A
   * non-matching entry is skipped before its data is decompressed, so callers
   * that need only a few members of a large multi-file archive (e.g. three
   * statement CSVs out of a ~130 MB Brazilian CVM DFP bundle) never pay to
   * inflate — or hold in memory — the members they will discard.
   */
  filter?: (name: string) => boolean;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: 0 | 8;
}

interface ResolvedZipReaderOptions {
  maxEntries: number;
  maxEntrySize: number;
  maxCompressedSize: number;
  maxTotalSize: number;
}

interface CentralEntry {
  name: string;
  flags: number;
  compressionMethod: 0 | 8;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  directory: boolean;
}

function resolvedOptions(options: ZipReaderOptions): ResolvedZipReaderOptions {
  const resolved = {
    maxEntries: options.maxEntries ?? 1_000,
    maxEntrySize: options.maxEntrySize ?? 64 * 1024 * 1024,
    maxCompressedSize: options.maxCompressedSize ?? 64 * 1024 * 1024,
    maxTotalSize: options.maxTotalSize ?? 128 * 1024 * 1024,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

function ensureRange(data: Uint8Array, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > data.byteLength
  ) {
    throw new Error(`Invalid ZIP: ${label} is out of bounds`);
  }
}

function viewFor(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function findEndOfCentralDirectory(data: Uint8Array, view: DataView): number {
  const minimum = Math.max(0, data.byteLength - MAX_EOCD_SEARCH);
  for (let offset = data.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === data.byteLength) return offset;
  }
  throw new Error("Invalid ZIP: end-of-central-directory record not found");
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Invalid ZIP: entry name is not valid UTF-8");
  }
}

function validatePath(name: string): { name: string; directory: boolean } {
  if (!name || name.includes("\0") || name.includes("\\")) {
    throw new Error(`Invalid ZIP entry path: ${JSON.stringify(name)}`);
  }
  if (name.startsWith("/") || /^[a-z]:/i.test(name)) {
    throw new Error(`Invalid ZIP entry path: ${JSON.stringify(name)}`);
  }
  const directory = name.endsWith("/");
  const path = directory ? name.slice(0, -1) : name;
  const segments = path.split("/");
  if (
    !path ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid ZIP entry path: ${JSON.stringify(name)}`);
  }
  return { name, directory };
}

function rejectZip64Extra(extra: Uint8Array): void {
  const view = viewFor(extra);
  let offset = 0;
  while (offset < extra.byteLength) {
    ensureRange(extra, offset, 4, "extra-field header");
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    ensureRange(extra, offset + 4, size, "extra field");
    if (id === ZIP64_EXTRA_FIELD) {
      throw new Error("Unsupported ZIP: ZIP64 entries are not accepted");
    }
    offset += 4 + size;
  }
}

function parseCentralEntries(
  data: Uint8Array,
  view: DataView,
  centralOffset: number,
  centralSize: number,
  entryCount: number,
  options: ResolvedZipReaderOptions,
): CentralEntry[] {
  if (entryCount > options.maxEntries) {
    throw new Error(`Unsafe ZIP: entry count exceeds ${options.maxEntries}`);
  }
  ensureRange(data, centralOffset, centralSize, "central directory");
  const centralEnd = centralOffset + centralSize;
  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(data, offset, 46, "central-directory entry");
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error("Invalid ZIP: bad central-directory entry signature");
    }
    const flags = view.getUint16(offset + 8, true);
    const rawMethod = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const variableLength = nameLength + extraLength + commentLength;
    ensureRange(data, offset + 46, variableLength, "central-directory fields");

    if (diskStart !== 0) throw new Error("Unsupported ZIP: multi-disk entry");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error("Unsupported ZIP: ZIP64 entries are not accepted");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw new Error("Unsupported ZIP: encrypted entries are not accepted");
    }
    if (rawMethod !== 0 && rawMethod !== 8) {
      throw new Error(`Unsupported ZIP compression method: ${rawMethod}`);
    }
    if (compressedSize > options.maxCompressedSize) {
      throw new Error(`Unsafe ZIP: compressed entry exceeds ${options.maxCompressedSize} bytes`);
    }
    if (uncompressedSize > options.maxEntrySize) {
      throw new Error(`Unsafe ZIP: entry exceeds ${options.maxEntrySize} bytes`);
    }

    const nameStart = offset + 46;
    const name = decodeName(data.subarray(nameStart, nameStart + nameLength));
    const validated = validatePath(name);
    if (names.has(validated.name)) {
      throw new Error(`Invalid ZIP: duplicate entry path ${JSON.stringify(validated.name)}`);
    }
    names.add(validated.name);
    rejectZip64Extra(
      data.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
    );
    entries.push({
      name: validated.name,
      flags,
      compressionMethod: rawMethod,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      directory: validated.directory,
    });
    offset += 46 + variableLength;
  }

  if (offset !== centralEnd) {
    throw new Error("Invalid ZIP: central-directory size does not match its entries");
  }
  return entries;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const tableValue = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readEntryData(
  archive: Uint8Array,
  view: DataView,
  entry: CentralEntry,
  centralOffset: number,
): Uint8Array {
  const offset = entry.localHeaderOffset;
  ensureRange(archive, offset, 30, "local-file header");
  if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER) {
    throw new Error(`Invalid ZIP: bad local-file header for ${JSON.stringify(entry.name)}`);
  }
  const localFlags = view.getUint16(offset + 6, true);
  const localMethod = view.getUint16(offset + 8, true);
  const localCrc = view.getUint32(offset + 14, true);
  const localCompressedSize = view.getUint32(offset + 18, true);
  const localUncompressedSize = view.getUint32(offset + 22, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const nameStart = offset + 30;
  ensureRange(archive, nameStart, nameLength + extraLength, "local-file fields");
  const localName = decodeName(archive.subarray(nameStart, nameStart + nameLength));
  if (
    localName !== entry.name ||
    localFlags !== entry.flags ||
    localMethod !== entry.compressionMethod ||
    ((entry.flags & 0x0008) === 0 && (
      localCrc !== entry.crc ||
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    ))
  ) {
    throw new Error(`Invalid ZIP: local and central metadata differ for ${JSON.stringify(entry.name)}`);
  }
  rejectZip64Extra(
    archive.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
  );

  const dataStart = nameStart + nameLength + extraLength;
  ensureRange(archive, dataStart, entry.compressedSize, "compressed entry data");
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralOffset) {
    throw new Error(`Invalid ZIP: entry overlaps central directory: ${JSON.stringify(entry.name)}`);
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  let uncompressed: Uint8Array;
  try {
    uncompressed = entry.compressionMethod === 0
      ? new Uint8Array(compressed)
      : new Uint8Array(inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, entry.uncompressedSize),
      }));
  } catch {
    throw new Error(`Invalid ZIP: could not inflate ${JSON.stringify(entry.name)}`);
  }
  if (uncompressed.byteLength !== entry.uncompressedSize) {
    throw new Error(`Invalid ZIP: size mismatch for ${JSON.stringify(entry.name)}`);
  }
  if (crc32(uncompressed) !== entry.crc) {
    throw new Error(`Invalid ZIP: CRC mismatch for ${JSON.stringify(entry.name)}`);
  }
  return uncompressed;
}

export function readZipEntries(
  archive: Uint8Array,
  options: ZipReaderOptions = {},
): ZipEntry[] {
  const limits = resolvedOptions(options);
  if (archive.byteLength < 22) throw new Error("Invalid ZIP: archive is too short");
  const view = viewFor(archive);
  const eocdOffset = findEndOfCentralDirectory(archive, view);
  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Unsupported ZIP: multi-disk archives are not accepted");
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("Unsupported ZIP: ZIP64 archives are not accepted");
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error("Invalid ZIP: central directory does not end at its footer");
  }

  const centralEntries = parseCentralEntries(
    archive,
    view,
    centralOffset,
    centralSize,
    entryCount,
    limits,
  );
  const entries: ZipEntry[] = [];
  let totalSize = 0;
  for (const entry of centralEntries) {
    if (options.filter && !entry.directory && !options.filter(entry.name)) {
      continue;
    }
    const data = readEntryData(archive, view, entry, centralOffset);
    if (entry.directory) {
      if (entry.uncompressedSize !== 0) {
        throw new Error(`Invalid ZIP: directory entry is not empty: ${JSON.stringify(entry.name)}`);
      }
      continue;
    }
    totalSize += data.byteLength;
    if (totalSize > limits.maxTotalSize) {
      throw new Error(`Unsafe ZIP: total output exceeds ${limits.maxTotalSize} bytes`);
    }
    entries.push({
      name: entry.name,
      data,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      compressionMethod: entry.compressionMethod,
    });
  }
  return entries;
}

export function readSingleZipEntry(
  archive: Uint8Array,
  options: ZipReaderOptions = {},
): ZipEntry {
  const entries = readZipEntries(archive, options);
  if (entries.length !== 1) {
    throw new Error(`Expected one ZIP file entry, found ${entries.length}`);
  }
  const entry = entries[0];
  if (!entry) throw new Error("Expected one ZIP file entry, found none");
  return entry;
}
