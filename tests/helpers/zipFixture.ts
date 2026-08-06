import { crc32 } from "../../src/core/zip.js";

/**
 * Build a valid single-entry (stored/uncompressed) ZIP archive so the strict
 * reader in src/core/zip.ts accepts it. Used to fake the OpenDART corpCode.xml
 * ZIP-of-XML download in offline tests.
 */
export function makeStoredZip(
  name: string,
  content: string | Uint8Array,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const data =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const crc = crc32(data);
  const central = 46 + nameBytes.length;
  const total = 30 + nameBytes.length + data.length + central + 22;
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  // Local file header
  view.setUint32(offset, 0x04034b50, true);
  view.setUint16(offset + 4, 20, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, 0, true); // stored
  view.setUint16(offset + 10, 0, true);
  view.setUint16(offset + 12, 0, true);
  view.setUint32(offset + 14, crc, true);
  view.setUint32(offset + 18, data.length, true);
  view.setUint32(offset + 22, data.length, true);
  view.setUint16(offset + 26, nameBytes.length, true);
  view.setUint16(offset + 28, 0, true);
  buffer.set(nameBytes, offset + 30);
  offset += 30 + nameBytes.length;
  buffer.set(data, offset);
  offset += data.length;

  // Central directory header
  const centralStart = offset;
  view.setUint32(offset, 0x02014b50, true);
  view.setUint16(offset + 4, 20, true);
  view.setUint16(offset + 6, 20, true);
  view.setUint16(offset + 8, 0, true);
  view.setUint16(offset + 10, 0, true);
  view.setUint16(offset + 12, 0, true);
  view.setUint16(offset + 14, 0, true);
  view.setUint32(offset + 16, crc, true);
  view.setUint32(offset + 20, data.length, true);
  view.setUint32(offset + 24, data.length, true);
  view.setUint16(offset + 28, nameBytes.length, true);
  view.setUint16(offset + 30, 0, true);
  view.setUint16(offset + 32, 0, true);
  view.setUint16(offset + 34, 0, true);
  view.setUint16(offset + 36, 0, true);
  view.setUint32(offset + 38, 0, true);
  view.setUint32(offset + 42, 0, true); // local header offset
  buffer.set(nameBytes, offset + 46);
  offset += 46 + nameBytes.length;

  // End of central directory
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, 1, true);
  view.setUint16(offset + 10, 1, true);
  view.setUint32(offset + 12, central, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);
  return buffer;
}

/**
 * Build a valid multi-entry stored/uncompressed ZIP. Used to fake the CVM DFP
 * year bundle, whose reader selectively inflates only the BPA/BPP/DRE members.
 */
export function makeStoredZipMulti(
  entries: Array<{ name: string; content: string | Uint8Array }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const data =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : entry.content;
    return { nameBytes, data, crc: crc32(data) };
  });

  const localSize = prepared.reduce(
    (sum, entry) => sum + 30 + entry.nameBytes.length + entry.data.length,
    0,
  );
  const centralSize = prepared.reduce(
    (sum, entry) => sum + 46 + entry.nameBytes.length,
    0,
  );
  const buffer = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  const localOffsets: number[] = [];

  for (const entry of prepared) {
    localOffsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, 0, true); // stored
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    buffer.set(entry.nameBytes, offset + 30);
    offset += 30 + entry.nameBytes.length;
    buffer.set(entry.data, offset);
    offset += entry.data.length;
  }

  const centralStart = offset;
  prepared.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 0, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, localOffsets[index] ?? 0, true);
    buffer.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.length;
  });

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);
  return buffer;
}

/**
 * Encode a string as Latin-1 (ISO-8859-1) bytes. The CVM feeds are Latin-1, so
 * fixtures must be byte-encoded that way to exercise the adapter's decoder
 * rather than assuming UTF-8.
 */
export function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}
