# Clear zod and transitive dependency advisories without API breakage

## Acceptance criteria

- `bun audit` reports zero findings on a frozen install; Dependabot alert #2 (zod GHSA-mrhx-c7xc-m3w5) closes.
- No breaking change for published consumers: Zod 3 consumers of `defineTool`/`ToolDefinition` still compile; `tools/list` JSON Schema is semantically unchanged; Node 18–24 runtime/package checks pass.
- Supersedes Dependabot PR #85.

## Work

- [x] zod 3.25.76 → 4.6.7; drop only the vulnerable transitive lock records and re-resolve inside the SDK's existing ranges (body-parser 2.4.0, fast-uri 3.1.9, qs 6.17.1, @hono/node-server 2.1.6).
- [x] Packed-consumer probe on main vs branch with Zod 3 and Zod 4 consumers. Branch-as-bumped broke Zod 3 consumers; widened public types to the SDK's `ZodRawShapeCompat`/`SchemaOutput` with an optional-aware `ToolArgs`, and both now compile and run.
- [x] Diffed full `tools/list`/resources/error wire output main vs branch. Restored `additionalProperties: false` (Zod 4 input-mode JSON Schema omits it). Residual: inlined `$ref`s, an explicit safe-integer max on `text_offset`, and Zod 4 error wording.
- [x] Lock both contracts into existing gates (stdio test, packed strict consumer).
- [x] Full local gate plus Node 18/20 runtime and package checks.
- [ ] PR green, squash-merge, sync main.
