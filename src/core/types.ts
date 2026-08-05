import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type Env = Record<string, string | undefined>;

export interface AdapterOptions {
  fetchFn?: FetchFn;
  env?: Env;
}

export interface IdentifierSet {
  cik?: string;
  ticker?: string;
  lei?: string;
  jurisdiction?: string;
}

export interface Entity extends IdentifierSet {
  legalName: string;
  aliases?: string[];
  status?: string;
  source: "SEC" | "GLEIF" | "SEC+GLEIF";
  sourceUrl?: string;
  matchReason?: string;
}

export interface Filing {
  filedDate: string;
  form: string;
  description: string;
  accession?: string;
  sourceUrl: string;
  source: "SEC";
}

export interface LatestReportMetadata extends Filing {
  reportKind: "annual" | "quarterly";
  sectionLinks: Array<{ section: string; description: string; url: string }>;
}

export interface Insider {
  name: string;
  ownerCik?: string;
  roles: string[];
  form: string;
  filedDate: string;
  sourceUrl: string;
  source: "SEC";
}

export interface OwnerRecord {
  holderName: string;
  holderType: string;
  pct?: number;
  thresholdRegime: string;
  form: string;
  filedDate: string;
  sourceUrl: string;
  source: "SEC" | "GLEIF";
}

export interface FinancialFact {
  concept: string;
  label: string;
  periodEnd: string;
  value: number;
  unit: string;
  filedDate: string;
  form: string;
  sourceUrl?: string;
  source: "SEC";
}

export interface RelatedPerson {
  name: string;
  relationships: string[];
}

export interface PrivateRaise {
  form: string;
  filedDate: string;
  issuerName?: string;
  entityType?: string;
  industry?: string;
  totalOfferingAmount?: string;
  totalAmountSold?: string;
  investorCount?: string;
  dateOfFirstSale?: string;
  relatedPersons: RelatedPerson[];
  sourceUrl: string;
  source: "SEC";
}

export interface OwnershipParent {
  kind: "direct" | "ultimate";
  entity?: Entity;
  exceptionReason?: string;
  exceptionCategory?: string;
  sourceUrl: string;
}

export interface OwnershipChainResult {
  entity: Entity;
  directParent?: OwnershipParent;
  ultimateParent?: OwnershipParent;
  children: Entity[];
  goldenCopyPublishedAt?: string;
}

export type ToolResult = CallToolResult;
