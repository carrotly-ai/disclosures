# Publishing `disclosures`

npm does not offer a separate name-reservation operation: the name is reserved by the first successful publish. Use a prerelease under the `next` tag to claim the name without presenting an unstable build as `latest`.

## 1. One-time npm account setup

1. Sign in at <https://www.npmjs.com/> and enable two-factor authentication.
2. Join or create the npm account that should own the unscoped `disclosures` package.
3. Locally authenticate and verify the account:

   ```bash
   npm login
   npm whoami
   npm view disclosures
   ```

   Before the first publish, `npm view disclosures` should return a 404. Re-check immediately before publishing because package-name availability can change.

## 2. Reserve the package name with a release candidate

From a clean checkout:

```bash
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
bun run build
npm pack --dry-run
npm version 0.1.0-rc.1 --no-git-tag-version
npm publish --access public --tag next
```

This creates `disclosures` and points only the `next` distribution tag at the release candidate. Confirm:

```bash
npm view disclosures versions --json
npm view disclosures dist-tags --json
npx -y disclosures@next
```

Restore the repository version to `0.1.0` after this manual reservation if the RC version change was only local:

```bash
git restore package.json bun.lock
```

## 3. Configure npm trusted publishing

After the package exists:

1. Open the package on npmjs.com.
2. Go to **Settings → Trusted Publishers**.
3. Add a GitHub Actions publisher with:
   - Organization: `carrotly-ai`
   - Repository: `disclosures`
   - Workflow filename: `release.yml`
   - Environment: leave blank unless the workflow is later changed to use one.
4. Do not add an `NPM_TOKEN` secret to GitHub; the workflow uses OIDC and `id-token: write`.

## 4. Test trusted publishing with another prerelease

Change the package version to a new prerelease, commit it, and push a matching tag:

```bash
npm version 0.1.0-rc.2 --no-git-tag-version
git add package.json bun.lock
git commit -m "Prepare 0.1.0-rc.2"
git tag v0.1.0-rc.2
git push origin main --tags
```

The release workflow publishes prerelease versions under `next`. Verify provenance and installation:

```bash
npm view disclosures@next version
npm view disclosures@next dist.integrity
npm view disclosures@next --json | jq '.dist.attestations'
npx -y disclosures@next
```

## 5. Publish the stable release

Set and commit the stable version, then push its matching tag:

```bash
npm version 0.1.0 --no-git-tag-version
git add package.json bun.lock CHANGELOG.md
git commit -m "Release 0.1.0"
git tag v0.1.0
git push origin main --tags
```

Stable versions publish to npm's default `latest` tag. Verify:

```bash
npm view disclosures version
npm view disclosures dist-tags --json
npx -y disclosures
```

Never reuse a published version. If an RC is bad, publish a higher RC; if a stable release is bad, deprecate it and publish a patch rather than unpublishing unless npm's narrow unpublish policy clearly applies.
