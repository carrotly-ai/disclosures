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
- China cninfo adapter (`jurisdiction: "CN"`): keyless company resolution across the Shanghai and Shenzhen exchanges (and HKEX mirror) plus a date-filterable announcement feed with direct PDF links, including latest annual/quarterly periodic-report lookup. Insiders, owners, financials, and private raises return an honest unsupported explanation because that data lives inside Chinese-language report PDFs this release does not parse.
- India BSE adapter (`jurisdiction: "IN"`): keyless company resolution and a corporate-announcement feed with attachment PDF links ("BSE-lite"). Promoter and 1%+ shareholding data is not surfaced; BSE's `api.bseindia.com` host is anti-bot protected, so unreliable calls can be made reliable by injecting a browser-backed `fetchFn` via `AdapterOptions`.
- UK FCA National Storage Mechanism adapter (`jurisdiction: "GB"`), surfaced inside `CompanyOwners`: parses DTR5/TR-1 "notification of major holdings" artefacts (issuer name/ISIN, person subject to the obligation, resulting % of voting rights, threshold-crossing date, and the controlled-undertaking chain) — the ~3%+ equity/voting-rights signal the Companies House PSC register does not carry. The NSM has no public read API, so the adapter is **inject-only**: with no supplied `fetchFn` it renders an honest access note and never contacts `data.fca.org.uk`; the TR-1 HTML parser is exercised offline against a recorded artefact fixture. The TR-1 section is supplementary — any failure there degrades to a note and never displaces the Companies House PSC result.
- Seven intent-based MCP tools that dispatch across all jurisdictions, with offline tests and a bundled Node 18+ executable. Jurisdictions without a normalized equivalent to a given intent return an explicit unsupported-jurisdiction explanation rather than an empty result.
