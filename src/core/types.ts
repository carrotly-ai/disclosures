import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DisclosuresCache } from "./cache.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type Env = Record<string, string | undefined>;

export const JURISDICTIONS = {
  US: "US",
  GB: "GB",
  EU: "EU",
  KR: "KR",
  JP: "JP",
  CN: "CN",
  IN: "IN",
  TW: "TW",
  BR: "BR",
  DE: "DE",
  FR: "FR",
  HK: "HK",
  SG: "SG",
  TH: "TH",
  NL: "NL",
  ID: "ID",
  MY: "MY",
  TR: "TR",
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
  SZSE: "SZSE",
  BSE: "BSE India",
  FCA_NSM: "FCA NSM",
  XBRL_FILINGS: "filings.xbrl.org",
  TWSE: "TWSE",
  CVM: "CVM",
  BAFIN: "BaFin",
  INFO_FINANCIERE: "info-financiere",
  RECHERCHE_ENTREPRISES: "recherche-entreprises",
  HKEX: "HKEXnews",
  ACRA: "ACRA",
  DBD: "DBD",
  AFM: "AFM",
  IDX: "IDX",
  BURSA: "Bursa Malaysia",
  KAP: "KAP",
} as const;

export type DataSource = (typeof DATA_SOURCES)[keyof typeof DATA_SOURCES];

export interface AdapterOptions {
  fetchFn?: FetchFn;
  env?: Env;
  /**
   * Optional cross-call cache for large, slow-changing reference downloads
   * (OpenDART corp-code archive, EDINET code list). When omitted, adapters fall
   * back to their per-process in-memory memoization only.
   */
  cache?: DisclosuresCache;
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
  /** Brazil CVM registration code (código CVM), e.g. 4170 (Vale). */
  cvmCode?: string;
  /** BaFin issuer id (Emittenten-BaFin-Id) used by the German AnteileInfo database, e.g. 40001244 (SAP SE). */
  bafinId?: string;
  /** French SIREN (9-digit legal-unit id) from recherche-entreprises, e.g. 542051180 (TotalEnergies SE). */
  siren?: string;
  /** HKEXnews internal stock id (not the public 5-digit code), e.g. 7609 (Tencent). */
  hkexStockId?: string;
  /** Singapore ACRA Unique Entity Number (UEN), e.g. 197200078R (Singapore Airlines). */
  uen?: string;
  /** Thailand DBD 13-digit juristic-person registration number, e.g. 0107544000108 (PTT PCL). */
  juristicId?: string;
  /** IDX (Indonesia) 4-letter issuer ticker / kode emiten, e.g. BBCA (Bank Central Asia). */
  kodeEmiten?: string;
  /** KAP (Turkey) numeric company id from the BIST directory, e.g. 1107 (Türk Hava Yolları). */
  kapCompanyId?: string;
  /** City/province of the registered office, where the register publishes one (KAP). */
  city?: string;
  /** Free-text sector/subsector label, where the register publishes one (IDX). */
  sector?: string;
  /** Exchange listing date (ISO), where the register publishes one (IDX). */
  listingDate?: string;
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
  identityVerification?: string;
  pct?: number;
  change?: number;
  /**
   * Free-text mandate term as filed (e.g. the BR FRE administrator register's
   * "Até a realização da AGO de 2027" or a "DD/MM/YYYY" end date). Only set where
   * the register carries a term rather than a dealings/transaction feed.
   */
  term?: string;
  accession?: string;
  sourceUrl: string;
}

export interface OwnerRecord extends SourceScopedRecord {
  holderName: string;
  holderType: string;
  pct?: number;
  /**
   * Per-share-class percentages, used by registers that report a holder's stake
   * split by voting class rather than a single figure (BR FRE posição acionária:
   * ordinárias/ON vs preferenciais/PN). `pct` carries the total. Both optional and
   * only set where the source breaks the position out by class.
   */
  pctOrdinary?: number;
  pctPreferred?: number;
  percentageBand?: string;
  change?: number;
  thresholdRegime: string;
  form: string;
  filedDate: string;
  notifiedDate?: string;
  ceasedDate?: string;
  identityVerification?: string;
  accession?: string;
  naturesOfControl?: string[];
  sourceUrl: string;
  /**
   * Best-effort structured fields parsed from a threshold-crossing notification's
   * PDF text layer (currently the FR OAM path). Every field is optional and only
   * set when parsed confidently; a notification whose PDF is scanned or phrased
   * non-standardly leaves them unset and stays a link-only row.
   */
  crossingDirection?: "up" | "down";
  crossingDate?: string;
  thresholdsCrossed?: string[];
  pctCapital?: number;
  pctVotingRights?: number;
  /** True when at least one structured field was extracted from the PDF text. */
  machineReadable?: boolean;
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
