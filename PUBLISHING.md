# Publishing `disclosures`

Stable releases use a preparation branch and PR. A lightweight `v<version>` tag on a commit
merged into `main` then triggers npm trusted publishing followed by MCP Registry publication.
Never publish from a dirty working tree or push a release commit directly to `main`.

## 1. One-time npm trusted-publisher setup

The npm package is owned by the `carrotly-ai` project and publishes through GitHub OIDC:

1. Open the package on npmjs.com.
2. Go to **Settings → Trusted Publishers**.
3. Configure a GitHub Actions publisher:
   - Organization: `carrotly-ai`
   - Repository: `disclosures`
   - Workflow filename: `release.yml`
   - Environment: blank
   - Allowed actions: enable direct `npm publish`; this workflow does not use staged publication.
4. Do not add an `NPM_TOKEN`; [`.github/workflows/release.yml`](.github/workflows/release.yml)
   uses `id-token: write` and publishes with provenance.

Check the publisher's allowed actions when creating or replacing its configuration.
A stage-only publisher cannot run this workflow's direct publish command. See npm's
[trusted-publisher configuration](https://docs.npmjs.com/trusted-publishers/).

The `Release` workflow also requires these four repository secrets for its strict live gate:
`DISCLOSURES_USER_AGENT`, `COMPANIES_HOUSE_API_KEY`, `OPENDART_API_KEY`, and
`EDINET_API_KEY`. Missing credentials block publication. Configure them through GitHub's
secret settings; never include values in source, PRs, or logs.

## 2. Prepare a stable release

Create `feat/release-<version>` from current `main`, or continue the existing branch and PR
already preparing this release. Update these four authoritative version surfaces together—do
not use `npm version`, which updates only `package.json`:

- `package.json` → `version`
- `server.json` → root `version`
- `server.json` → `packages[0].version`
- `src/server.ts` → `SERVER_VERSION`

Promote `CHANGELOG.md`'s `Unreleased` section to the same version and release date. Run these
checks in a clean checkout containing no local environment files. Bun's package-manager
commands can load environment files even when `--no-env-file` is supplied.

```bash
bun install --frozen-lockfile
bun audit
bun --no-env-file run typecheck
bun --no-env-file run test
bun --no-env-file run build
bun --no-env-file run test:stdio
bun --no-env-file run pack:dry
for major in 18 20 22 24; do
  npm exec --yes --package="node@$major" -- node scripts/check-runtime.mjs
  npm exec --yes --package="node@$major" -- node scripts/check-package.mjs
done
node scripts/source-canary.mjs
LIVE_E2E_REQUIRE_ALL=1 bun --no-env-file test ./tests/live/e2e.live.ts --timeout 300000
```

The strict live command requires the four credentials in the process environment. Capture
the exact commit, Node versions, audit result, canary result, and strict live output in the PR.
A missing credential, failed source, or skipped tolerant transport is evidence to report;
offline success alone does not establish current upstream availability. The live suite's
documented BR/CN/IN transport skips remain possible even in strict credential mode.

For hosted evidence before merging, manually dispatch the `Release` workflow on the
preparation branch. It runs the same deterministic, compatibility, and source gates.
The source job checks for missing credentials immediately; other validation jobs can finish
independently. Publication jobs require a tag-push event and are skipped for every manual
dispatch, including dispatches against tags.

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
`package.json`. The standalone JavaScript bundle carries its runtime implementation; declared
MCP SDK and Zod dependencies supply the public declaration graph. The isolated consumer check
must compile without manually adding those dependencies or enabling `skipLibCheck`. It also runs
the installed bin through stdio startup, malformed JSON recovery, and exit-code-checked EOF
shutdown. The installed HTTP server must reject malformed input and remain usable after
deterministic upstream errors and 15-second fetch/body deadlines. These checks make no live
source requests. Every PR runs the full deterministic gate on Node 22. The tag-triggered
release workflow additionally repeats runtime and installed-package checks on Node 18, 20,
22, and 24 before publishing; local pre-release checks should cover the same versions.

## 3. Merge the release PR

Commit the release branch, push it, and open a PR titled `Release <version>`. Record:

- typecheck and exact offline-test result;
- full-lockfile dependency audit, build, and stdio integration result;
- runtime and installed-package results for Node 18, 20, 22, and 24;
- package-content inspection;
- fresh canary and strict live-suite results, including any transport skips;
- the runtime banner, including version and tool count.

Wait for the required `pr-check` and configured CodeQL analyses to pass. CodeQL is managed
through GitHub's default setup, independently of this repository's workflow files. Review
open dependency, code-scanning, and secret-scanning alerts before release. Bun's full-lockfile
audit is required even when GitHub reports no dependency alerts.

The maintainer reviews and merges the PR. Agents do not auto-merge. Sync local `main` with
`git pull --ff-only` and verify that the intended release commit and all version fields agree
before tagging. If the merged source differs from the validated source, repeat the gates.

## 4. Publish with the lightweight tag

Recent releases use lightweight tags. Create and push only the intended tag:

```bash
git tag v<version>
git push origin v<version>
```

Do not use `git push origin main --tags`; that can publish unrelated local tags.

The tag starts an ordered publication pipeline:

1. [`.github/workflows/release.yml`](.github/workflows/release.yml) requires the tag commit to
   be reachable from `main`, verifies all four version surfaces, audits the full lockfile,
   runs offline checks, verifies runtime and installed-package compatibility on Node
   18/20/22/24, and independently runs fresh source canaries and strict credentialed live E2E.
   Only after every gate succeeds does it publish to npm with OIDC provenance. Stable versions go to `latest`;
   prereleases go to `next`.
2. After npm publication succeeds, the release workflow calls
   [`.github/workflows/publish-mcp.yml`](.github/workflows/publish-mcp.yml) from the same commit.
   It checks the merged tag, manifest versions, and npm's published version, MCP name, and
   `gitHead`, then authenticates via GitHub OIDC and submits the manifest. Its publisher
   binary is pinned to a release and verified against a recorded SHA-256 checksum.

A failed audit, compatibility check, canary, or strict live suite blocks both publications.
A failed npm publication prevents the MCP job from starting.

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

If npm publishes but the MCP Registry job fails or times out, rerun
`publish-mcp.yml` with `workflow_dispatch` and set `release_tag` to the already-published
`v<version>`. This checks out the tag, verifies npm's `gitHead`, and retries only the registry
submission. Check the registry first: an already-present version does not need another
submission. Never rerun npm publication for a version that already exists.

Manual MCP Registry fallback:

```bash
mcp-publisher login github
mcp-publisher publish
```

Never reuse a published version. If a stable release is defective, deprecate it if needed and
publish a patch; deleting the Git tag does not undo npm publication.

## Dependency maintenance

[`.github/dependabot.yml`](.github/dependabot.yml) requests weekly Bun and GitHub Actions
version updates with bounded open PR counts. GitHub currently supports Bun version updates
but not Bun security updates; enabling repository security updates does not close that gap.
The unfiltered `bun audit` gate covers the complete lockfile, including transitive and
development dependencies. Do not replace it with a production-only audit or suppress findings
to make a release pass. See GitHub's [supported package managers](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories).
