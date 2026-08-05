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

export function formatNumber(value: number, unit: string): string {
  if (unit === "USD") {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function joinSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}
