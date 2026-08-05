export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function asStringArray(value: unknown): string[] {
  return asArray(value).flatMap((item) => {
    const text = asString(item);
    return text ? [text] : [];
  });
}

export function asIndexedStringArray(value: unknown): string[] {
  return asArray(value).map((item) =>
    typeof item === "string" ? item.trim() : ""
  );
}

export function nestedRecord(value: unknown, key: string): JsonRecord | undefined {
  return asRecord(asRecord(value)?.[key]);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function codePoint(value: string, radix: number): string | undefined {
  const parsed = Number.parseInt(value, radix);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > 0x10ffff ||
    (parsed >= 0xd800 && parsed <= 0xdfff)
  ) {
    return undefined;
  }
  return String.fromCodePoint(parsed);
}

export function decodeXmlEntities(value: string): string {
  return value
    // Unrolled CDATA body (any non-`]`, or a `]` not starting the `]]>` close)
    // so it stays linear on untrusted input rather than backtracking a lazy `*?`.
    .replace(/<!\[CDATA\[((?:[^\]]|\](?!\]>))*)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) =>
      codePoint(hex, 16) ?? match
    )
    .replace(/&#(\d+);/g, (match, decimal: string) =>
      codePoint(decimal, 10) ?? match
    )
    .replace(/&([a-z]+);/gi, (match, name: string) =>
      XML_ENTITIES[name.toLowerCase()] ?? match
    );
}

export function plainXmlText(value: string): string {
  // `[^<>]` (not just `[^>]`) keeps tag-stripping linear: a stray `<` cannot
  // make the class re-scan the remainder from every prior `<`.
  return decodeXmlEntities(value.replace(/<[^<>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function xmlBlocks(xml: string, tag: string): string[] {
  const escaped = escapeRegExp(tag);
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    "gi",
  );
  return Array.from(xml.matchAll(pattern), (match) => match[1] ?? "");
}

export function xmlValues(xml: string, tag: string): string[] {
  return xmlBlocks(xml, tag).map(plainXmlText).filter(Boolean);
}

export function xmlValue(xml: string, ...tags: string[]): string | undefined {
  for (const tag of tags) {
    const value = xmlValues(xml, tag)[0];
    if (value) return value;
  }
  return undefined;
}

export function xmlBoolean(xml: string, ...tags: string[]): boolean {
  const value = xmlValue(xml, ...tags)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "y";
}
