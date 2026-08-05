import type { Entity } from "./types.js";

export interface EntityRankingOptions {
  fallbackReason?: string;
}

function foldLatinDiacritics(value: string): string {
  let result = "";
  let followsLatinBase = false;
  for (const character of value.normalize("NFKD")) {
    if (/\p{M}/u.test(character)) {
      if (!followsLatinBase) result += character;
      continue;
    }
    result += character;
    followsLatinBase = /\p{Script=Latin}/u.test(character);
  }
  return result.normalize("NFC");
}

export function normalizeEntityName(value: string): string {
  return foldLatinDiacritics(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchScore(
  query: string,
  entity: Entity,
  fallbackReason: string,
): { score: number; reason: string } {
  const normalizedQuery = normalizeEntityName(query);
  const legalName = normalizeEntityName(entity.legalName);
  const aliases = (entity.aliases ?? []).map(normalizeEntityName).filter(Boolean);

  if (!normalizedQuery) return { score: 0, reason: fallbackReason };
  if (legalName === normalizedQuery) {
    return { score: 10_000, reason: "Exact normalized legal-name match" };
  }
  if (aliases.includes(normalizedQuery)) {
    return { score: 9_500, reason: "Exact normalized alias match" };
  }
  if (legalName.startsWith(normalizedQuery)) {
    return { score: 8_000, reason: "Legal name starts with query" };
  }
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) {
    return { score: 7_500, reason: "Alias starts with query" };
  }
  if (legalName.includes(normalizedQuery)) {
    return { score: 7_000, reason: "Legal name contains query" };
  }
  if (aliases.some((alias) => alias.includes(normalizedQuery))) {
    return { score: 6_500, reason: "Alias contains query" };
  }

  const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
  const candidateTokens = new Set(
    [legalName, ...aliases].flatMap((name) => name.split(" ").filter(Boolean)),
  );
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  const denominator = Math.max(queryTokens.size, candidateTokens.size, 1);
  return {
    score: Math.round((overlap / denominator) * 1_000),
    reason: overlap > 0 ? "Best normalized token match" : fallbackReason,
  };
}

export function rankEntities(
  query: string,
  entities: Entity[],
  options: EntityRankingOptions = {},
): Entity[] {
  const normalizedQuery = normalizeEntityName(query);
  const fallbackReason = options.fallbackReason ?? "Legal-name search result";
  return entities
    .map((entity, index) => {
      const match = matchScore(query, entity, fallbackReason);
      const lengthDistance = Math.abs(
        normalizeEntityName(entity.legalName).length - normalizedQuery.length,
      );
      return {
        entity: { ...entity, matchReason: match.reason },
        index,
        score: match.score,
        lengthDistance,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.lengthDistance - right.lengthDistance ||
        left.index - right.index,
    )
    .map(({ entity }) => entity);
}
