import { readFileSync } from "node:fs";

/**
 * Load a recorded upstream artefact from tests/fixtures/<source>/<name>.
 *
 * Recorded fixtures are for large verbatim payloads where fidelity to the real
 * response matters more than inline readability (see docs/TESTING.md). Small or
 * interpolated payloads should stay inline in the test file.
 */
export function loadFixture(source: string, name: string): string {
  return readFileSync(
    new URL(`../fixtures/${source}/${name}`, import.meta.url),
    "utf8",
  );
}

/**
 * Load a recorded fixture as raw bytes, for payloads whose encoding is part of
 * what is under test — the AFM substantial-holdings CSV is Windows-1252, and
 * reading it as UTF-8 would silently mangle the `Reëel` column that the
 * adapter's decoding path exists to handle.
 */
export function loadFixtureBytes(source: string, name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../fixtures/${source}/${name}`, import.meta.url)),
  );
}
