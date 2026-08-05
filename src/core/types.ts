import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type Env = Record<string, string | undefined>;

export const JURISDICTIONS = {
  US: "US",
  GB: "GB",
  KR: "KR",
  JP: "JP",
  CN: "CN",
  IN: "IN",
} as const;

export type Jurisdiction = (typeof JURISDICTIONS)[keyof typeof JURISDICTIONS];

export const DATA_SOURCES = {
  SEC: "SEC",
  GLEIF: "GLEIF",
  SEC_GLEIF: "SEC+GLEIF",
  COMPANIES_HOUSE: "Companies House",
  OPEN_DART: "OpenDART",
  EDINET: "EDINET",
  CNINFO: "cninfo",
  BSE: "BSE India",
} as const;

export type DataSource = (typeof DATA_SOURCES)[keyof typeof DATA_SOURCES];

export interface AdapterOptions {
  fetchFn?: FetchFn;
  env?: Env;
}

export interface IdentifierSet {
  cik?: string;
  ticker?: string;
  lei?: string;
  companyNumber?: string;
  corpCode?: string;
  stockCode?: string;
  edinetCode?: string;
  secCode?: string;
  jcn?: string;
  /** cninfo organisation id, e.g. gssh0600519 (SSE) / gssz0000001 (SZSE). */
  orgId?: string;
  /** BSE (India) numeric scrip code, e.g. 500325. */
  scripCode?: string;
  /** ISIN, e.g. INE002A01018 (used by the India/BSE adapter). */
  isin?: string;
  jurisdiction?: string;
}

export interface SourceScopedRecord {
  source: DataSource;
  sourceIdentifiers?: IdentifierSet;
}

export interface Entity extends IdentifierSet, SourceScopedRecord {
  legalName: string;
  aliases?: string[];
  status?: string;
  sourceUrl?: string;
  matchReason?: string;
}

export interface Filing extends SourceScopedRecord {
  filedDate: string;
  form: string;
  category?: string;
  description: string;
  accession?: string;
  sourceUrl: string;
}

export interface LatestReportMetadata extends Filing {
  reportKind: "annual" | "quarterly";
  sectionLinks: Array<{ section: string; description: string; url: string }>;
}

export interface Insider extends SourceScopedRecord {
  name: string;
  ownerCik?: string;
  roles: string[];
  officerRole?: string;
  occupation?: string;
  status?: string;
  form: string;
  filedDate: string;
  appointedDate?: string;
  ceasedDate?: string;
  notifiedDate?: string;
  pct?: number;
  change?: number;
  accession?: string;
  sourceUrl: string;
}

export interface OwnerRecord extends SourceScopedRecord {
  holderName: string;
  holderType: string;
  pct?: number;
  percentageBand?: string;
  change?: number;
  thresholdRegime: string;
  form: string;
  filedDate: string;
  notifiedDate?: string;
  ceasedDate?: string;
  accession?: string;
  naturesOfControl?: string[];
  sourceUrl: string;
}

export type FinancialBasis = "consolidated" | "separate";

export interface FinancialFact extends SourceScopedRecord {
  concept: string;
  label: string;
  periodEnd: string;
  value: number;
  unit: string;
  filedDate: string;
  form: string;
  basis?: FinancialBasis;
  sourceUrl?: string;
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
