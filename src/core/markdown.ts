const escapeCell = (value: unknown): string =>
  String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .trim() || "—";

export function markdownTable(
  headers: string[],
  rows: Array<Array<unknown>>,
): string {
  const head = `| ${headers.map(escapeCell).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${row.map(escapeCell).join(" | ")} |`,
  );
  return [head, separator, ...body].join("\n");
}

export function link(label: string, url: string): string {
  return `[${label.replaceAll("]", "\\]")}](${url})`;
}

const CURRENCY_FORMATS: Record<
  string,
  { symbol: string; maximumFractionDigits: number }
> = {
  USD: { symbol: "$", maximumFractionDigits: 2 },
  GBP: { symbol: "£", maximumFractionDigits: 2 },
  EUR: { symbol: "€", maximumFractionDigits: 2 },
  KRW: { symbol: "₩", maximumFractionDigits: 0 },
  JPY: { symbol: "¥", maximumFractionDigits: 0 },
  CHF: { symbol: "CHF ", maximumFractionDigits: 2 },
  SEK: { symbol: "kr ", maximumFractionDigits: 2 },
  NOK: { symbol: "kr ", maximumFractionDigits: 2 },
  DKK: { symbol: "kr ", maximumFractionDigits: 2 },
  PLN: { symbol: "zł ", maximumFractionDigits: 2 },
  BRL: { symbol: "R$", maximumFractionDigits: 2 },
  TWD: { symbol: "NT$", maximumFractionDigits: 0 },
  HKD: { symbol: "HK$", maximumFractionDigits: 0 },
  CNY: { symbol: "RMB ", maximumFractionDigits: 0 },
};

export function formatNumber(value: number, unit: string): string {
  const currency = CURRENCY_FORMATS[unit];
  if (currency) {
    return `${currency.symbol}${value.toLocaleString("en-US", {
      maximumFractionDigits: currency.maximumFractionDigits,
    })}`;
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function joinSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}

export const UNTRUSTED_TEXT_BEGIN = "<<<BEGIN UNTRUSTED DOCUMENT TEXT>>>";
export const UNTRUSTED_TEXT_END = "<<<END UNTRUSTED DOCUMENT TEXT>>>";

/**
 * Fence third-party-authored document text between fixed sentinel lines (plus
 * a code fence) so a client can programmatically locate — and strip or
 * quarantine — the untrusted span instead of relying on the prose warning
 * alone. Any sentinel-lookalike inside the body is defanged first, so
 * filer-authored content cannot fake an early END marker and smuggle text
 * outside the fence.
 */
export function untrustedTextBlock(body: string): string {
  const defanged = body
    .replaceAll(UNTRUSTED_TEXT_BEGIN, "<<defanged BEGIN marker>>")
    .replaceAll(UNTRUSTED_TEXT_END, "<<defanged END marker>>");
  return `${UNTRUSTED_TEXT_BEGIN}\n\`\`\`\n${defanged}\n\`\`\`\n${UNTRUSTED_TEXT_END}`;
}
