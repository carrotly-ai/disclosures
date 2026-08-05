# Changelog

All notable changes to this project will be documented here.

## 0.1.0 - Unreleased

### Added

- Jurisdiction-agnostic corporate-disclosure TypeScript library and stdio MCP server.
- SEC EDGAR adapter for company resolution, filings, insiders, beneficial owners, annual financials, and Form D private raises.
- GLEIF adapter for LEI resolution and accounting-consolidation relationships.
- UK Companies House adapter (`jurisdiction: "GB"`): company resolution, filing history, officer register, and persons-with-significant-control records. Requires `COMPANIES_HOUSE_API_KEY`.
- South Korea DART / OpenDART adapter (`jurisdiction: "KR"`): company resolution, periodic reports, executive/major-shareholder ownership, 5% mass-holding reports, and annual major-account financials. Requires `OPENDART_API_KEY`.
- Japan EDINET adapter (`jurisdiction: "JP"`): company resolution via the public EDINET code list and date-indexed disclosure-document search. Document search requires `EDINET_API_KEY`; resolution does not.
- Seven intent-based MCP tools that dispatch across all jurisdictions, with offline tests and a bundled Node 18+ executable. Jurisdictions without a normalized equivalent to a given intent return an explicit unsupported-jurisdiction explanation rather than an empty result.
