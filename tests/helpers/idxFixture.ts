import { makeStoredZipMulti } from "./zipFixture.js";

// A minimal IDX XBRL instance, structurally faithful to a real one recorded
// from www.idx.co.id (TLKM FY2024, taxonomy idx-cor 2020-01-01). It reproduces:
//   - the real namespace/prefix pair (idx-cor for facts, idx-dei for metadata);
//   - the four undimensioned period contexts IDX actually files —
//     CurrentYear{Duration,Instant} plus PriorYearDuration and
//     PriorEndYearInstant (IDX splits the comparative between two prefixes);
//   - a DIMENSIONED context whose facts must never be surfaced as company
//     totals (`CurrentYearInstant_3410000_NonControllingInterestsMember`);
//   - both monetary units the real instances declare: plain `IDR` and the
//     divide-based `IDRPerShares`, so unit filtering is exercised;
//   - the group/individual dei declaration the basis is read from.
//
// The FIGURES are the issuer's real as-filed FY2024/FY2023 totals, so a
// regression in scale or context selection is immediately visible.
export const IDX_XBRL_INSTANCE = `<?xml version="1.0"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:idx-cor="http://www.idx.co.id/xbrl/taxonomy/2020-01-01/cor"
  xmlns:idx-dei="http://www.idx.co.id/xbrl/taxonomy/2020-01-01/dei">
<link:schemaRef xlink:type="simple" xlink:href="Taxonomy.xsd"/>
<unit id="IDR"><measure>iso4217:IDR</measure></unit>
<unit id="IDRPerShares"><divide><unitNumerator><measure>iso4217:IDR</measure></unitNumerator><unitDenominator><measure>shares</measure></unitDenominator></divide></unit>
<context id="CurrentYearInstant"><entity><identifier scheme="http://www.idx.co.id/xbrl">tlkm_user</identifier></entity><period><instant>2024-12-31</instant></period></context>
<context id="PriorEndYearInstant"><entity><identifier scheme="http://www.idx.co.id/xbrl">tlkm_user</identifier></entity><period><instant>2023-12-31</instant></period></context>
<context id="CurrentYearDuration"><entity><identifier scheme="http://www.idx.co.id/xbrl">tlkm_user</identifier></entity><period><startDate>2024-01-01</startDate><endDate>2024-12-31</endDate></period></context>
<context id="PriorYearDuration"><entity><identifier scheme="http://www.idx.co.id/xbrl">tlkm_user</identifier></entity><period><startDate>2023-01-01</startDate><endDate>2023-12-31</endDate></period></context>
<context id="CurrentYearInstant_3410000_NonControllingInterestsMember"><entity><identifier scheme="http://www.idx.co.id/xbrl">tlkm_user</identifier></entity><period><instant>2024-12-31</instant></period><scenario><xbrldi:explicitMember dimension="idx-cor:ComponentsOfEquityAxis">idx-cor:NonControllingInterestsMember</xbrldi:explicitMember></scenario></context>
<idx-dei:WhetherTheFinancialStatementsAreOfAnIndividualEntityOrAGroupOfEntities contextRef="CurrentYearInstant">Entitas grup / Group entity</idx-dei:WhetherTheFinancialStatementsAreOfAnIndividualEntityOrAGroupOfEntities>
<idx-dei:DescriptionOfPresentationCurrency contextRef="CurrentYearInstant">Rupiah / IDR</idx-dei:DescriptionOfPresentationCurrency>
<idx-cor:SalesAndRevenue decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">149967000000000</idx-cor:SalesAndRevenue>
<idx-cor:SalesAndRevenue decimals="-6" contextRef="PriorYearDuration" unitRef="IDR">149215000000000</idx-cor:SalesAndRevenue>
<idx-cor:ProfitFromOperation decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">37786000000000</idx-cor:ProfitFromOperation>
<idx-cor:ProfitLossBeforeIncomeTax decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">39153000000000</idx-cor:ProfitLossBeforeIncomeTax>
<idx-cor:ProfitLoss decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">30743000000000</idx-cor:ProfitLoss>
<idx-cor:ProfitLossAttributableToParentEntity decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">23649000000000</idx-cor:ProfitLossAttributableToParentEntity>
<idx-cor:ProfitLossAttributableToParentEntity decimals="-6" contextRef="PriorYearDuration" unitRef="IDR">24560000000000</idx-cor:ProfitLossAttributableToParentEntity>
<idx-cor:Assets decimals="-6" contextRef="CurrentYearInstant" unitRef="IDR">299675000000000</idx-cor:Assets>
<idx-cor:Assets decimals="-6" contextRef="PriorEndYearInstant" unitRef="IDR">287042000000000</idx-cor:Assets>
<idx-cor:Equity decimals="-6" contextRef="CurrentYearInstant" unitRef="IDR">162490000000000</idx-cor:Equity>
<idx-cor:EquityAttributableToEquityOwnersOfParentEntity decimals="-6" contextRef="CurrentYearInstant" unitRef="IDR">142094000000000</idx-cor:EquityAttributableToEquityOwnersOfParentEntity>
<idx-cor:EquityAttributableToEquityOwnersOfParentEntity decimals="-6" contextRef="PriorEndYearInstant" unitRef="IDR">135744000000000</idx-cor:EquityAttributableToEquityOwnersOfParentEntity>
<idx-cor:Equity decimals="-6" contextRef="CurrentYearInstant_3410000_NonControllingInterestsMember" unitRef="IDR">20396000000000</idx-cor:Equity>
<idx-cor:BasicEarningsLossPerShareFromContinuingOperations decimals="INF" contextRef="CurrentYearDuration" unitRef="IDRPerShares">238.73</idx-cor:BasicEarningsLossPerShareFromContinuingOperations>
</xbrl>`;

/**
 * A financial-sector instance: a bank files no `SalesAndRevenue` and no
 * `ProfitFromOperation` label of the general-industry kind, reporting interest
 * and sharia income instead. Modelled on BBCA FY2024 (real as-filed figures)
 * so the sector-variant element ordering is exercised.
 */
export const IDX_XBRL_INSTANCE_BANK = `<?xml version="1.0"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:idx-cor="http://www.idx.co.id/xbrl/taxonomy/2020-01-01/cor"
  xmlns:idx-dei="http://www.idx.co.id/xbrl/taxonomy/2020-01-01/dei">
<unit id="IDR"><measure>iso4217:IDR</measure></unit>
<context id="CurrentYearInstant"><entity><identifier scheme="http://www.idx.co.id/xbrl">bbca_user</identifier></entity><period><instant>2024-12-31</instant></period></context>
<context id="CurrentYearDuration"><entity><identifier scheme="http://www.idx.co.id/xbrl">bbca_user</identifier></entity><period><startDate>2024-01-01</startDate><endDate>2024-12-31</endDate></period></context>
<idx-dei:WhetherTheFinancialStatementsAreOfAnIndividualEntityOrAGroupOfEntities contextRef="CurrentYearInstant">Entitas grup / Group entity</idx-dei:WhetherTheFinancialStatementsAreOfAnIndividualEntityOrAGroupOfEntities>
<idx-cor:TotalInterestAndShariaIncome decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">94796454000000</idx-cor:TotalInterestAndShariaIncome>
<idx-cor:ProfitFromOperation decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">68217850000000</idx-cor:ProfitFromOperation>
<idx-cor:ProfitLossAttributableToParentEntity decimals="-6" contextRef="CurrentYearDuration" unitRef="IDR">54836305000000</idx-cor:ProfitLossAttributableToParentEntity>
<idx-cor:Assets decimals="-6" contextRef="CurrentYearInstant" unitRef="IDR">1449301328000000</idx-cor:Assets>
<idx-cor:EquityAttributableToEquityOwnersOfParentEntity decimals="-6" contextRef="CurrentYearInstant" unitRef="IDR">262640621000000</idx-cor:EquityAttributableToEquityOwnersOfParentEntity>
</xbrl>`;

/**
 * Build an `instance.zip` exactly as IDX packages one: a flat archive holding
 * `instance.xbrl` plus the `Taxonomy.xsd` the reader must skip.
 */
export function makeIdxInstanceZip(
  instance: string = IDX_XBRL_INSTANCE,
): Uint8Array {
  return makeStoredZipMulti([
    { name: "instance.xbrl", content: instance },
    {
      name: "Taxonomy.xsd",
      content:
        '<?xml version="1.0"?><xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"/>',
    },
  ]);
}
