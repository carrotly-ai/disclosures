# Publishing `disclosures`

Stable releases use a release branch and PR. A lightweight `v<version>` tag on merged `main`
then triggers npm trusted publishing and MCP Registry publication. Never publish from a dirty
working tree or push a release commit directly to `main`.

## 1. One-time npm trusted-publisher setup

The npm package is owned by the `carrotly-ai` project and publishes through GitHub OIDC:

1. Open the package on npmjs.com.
2. Go to **Settings → Trusted Publishers**.
3. Configure a GitHub Actions publisher:
   - Organization: `carrotly-ai`
   - Repository: `disclosures`
   - Workflow filename: `release.yml`
   - Environment: blank
4. Do not add an `NPM_TOKEN`; [`.github/workflows/release.yml`](.github/workflows/release.yml)
   uses `id-token: write` and publishes with provenance.

## 2. Prepare a stable release

Create `release-<version>` from current `main`. Update these four authoritative version
surfaces together—do not use `npm version`, which updates only `package.json`:

- `package.json` → `version`
- `server.json` → root `version`
- `server.json` → `packages[0].version`
- `src/server.ts` → `SERVER_VERSION`

Promote `CHANGELOG.md`'s `Unreleased` section to the same version and release date, then run:

```bash
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
bun run build
bun run test:stdio
bun run pack:dry
bun run test:live:all
```

Validate the MCP manifest when `server.json` changes:

```bash
uv run --with jsonschema python - <<'PY'
import json
import urllib.request

schema = json.load(urllib.request.urlopen(
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
))
manifest = json.load(open("server.json"))
import jsonschema
jsonschema.validate(manifest, schema)
print("server.json valid")
PY
```

`npm pack --dry-run --json` must contain only `dist/`, `README.md`, `LICENSE`, `NOTICE`, and
`package.json`; the published package must have zero runtime dependencies.

## 3. Merge the release PR

Commit the release branch, push it, and open a PR titled `Release <version>`. Record:

- typecheck and exact offline-test result;
- build and stdio integration result;
- package-content inspection;
- strict live-suite result;
- the runtime banner, including version and tool count.

Wait for the Node 18/20/22 CI matrix and both CodeQL analyses to pass, then squash-merge.
Sync local `main` with `git pull --ff-only` and rerun the deterministic release gate before
tagging.

## 4. Publish with the lightweight tag

Recent releases use lightweight tags. Create and push only the intended tag:

```bash
git tag v<version>
git push origin v<version>
```

Do not use `git push origin main --tags`; that can publish unrelated local tags.

The tag starts two workflows:

1. [`.github/workflows/release.yml`](.github/workflows/release.yml) verifies, builds, checks the
   tag against `package.json`, and publishes to npm with OIDC provenance. Stable versions go
   to `latest`; prereleases go to `next`.
2. [`.github/workflows/publish-mcp.yml`](.github/workflows/publish-mcp.yml) verifies the
   `package.json`/`server.json` versions, waits for npm, authenticates to the MCP Registry via
   GitHub OIDC, and publishes the manifest.

The repository uses tags plus registry publication; it does not create GitHub Release objects.

## 5. Verify publication

```bash
npm view disclosures version
npm view disclosures dist-tags --json
npm view disclosures@<version> dist.integrity
npm view disclosures@<version> --json | jq '.dist.attestations'
npx -y disclosures@<version>
```

Also verify the MCP Registry reports the same version and that the runtime banner agrees with
`package.json` and both `server.json` version fields.

If npm publishes but the MCP Registry workflow fails or times out, rerun
`publish-mcp.yml` with `workflow_dispatch`; it is idempotent for an already-published npm
version.

Manual MCP Registry fallback:

```bash
mcp-publisher login github
mcp-publisher publish
```

Never reuse a published version. If a stable release is defective, deprecate it if needed and
publish a patch; deleting the Git tag does not undo npm publication.
