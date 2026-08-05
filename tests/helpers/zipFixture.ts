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
