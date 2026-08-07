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
