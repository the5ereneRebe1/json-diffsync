# Release Plan

This checklist prepares `json-diffsync` for open-source release on GitHub and npm.

## 1. Confirm Project Identity

- Package name: `json-diffsync`
- License: MIT
- GitHub repository: `the5ereneRebe1/json-diffsync`
- npm package: `json-diffsync`

If the GitHub username or organization is different, update these fields in `package.json` before publishing:

- `homepage`
- `repository.url`
- `bugs.url`

## 2. Local Validation

Run:

```sh
npm test
npm run bench
npm --cache /private/tmp/json-diffsync-npm-cache pack --dry-run
```

Optional browser validation:

```sh
npm run test:e2e:browser
```

Expected npm tarball contents:

- `LICENSE`
- `README.md`
- `package.json`
- `src/index.js`
- `src/index.d.ts`
- `src/react.js`
- `src/react.d.ts`
- `src/server.js`
- `src/server.d.ts`

## 3. Create GitHub Repository

Create a public repository named:

```txt
json-diffsync
```

Recommended GitHub settings:

- Add description: `Differential synchronization primitives for JSON autosave.`
- Add topics: `json`, `diff`, `autosave`, `differential-sync`, `react`, `collaboration`
- Enable Issues.
- Enable Discussions. The issue template links questions and design ideas there.
- Disable Wikis unless you specifically want GitHub Wiki docs.
- Enable release immutability.
- Enable automatically delete head branches.
- Prefer squash merging for pull requests.
- Protect `main` once the first code push is complete.

Suggested `main` branch protection:

- Require a pull request before merging.
- Require status checks to pass.
- Require the `Test on Node 20`, `Test on Node 22`, and `Browser E2E` checks.
- Require branches to be up to date before merging.
- Do not allow force pushes.
- Do not allow deletions.

Repository secrets:

- Add `NPM_TOKEN` before using the release workflow.
- Create the token on npm with publish permission for `json-diffsync`.

## 4. Initialize Git And Push

From the package directory:

```sh
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin git@github.com:the5ereneRebe1/json-diffsync.git
git push -u origin main
```

Use the HTTPS remote instead if preferred:

```sh
git remote add origin https://github.com/the5ereneRebe1/json-diffsync.git
```

## 5. Publish To npm

Log in:

```sh
npm login
```

Confirm package name availability:

```sh
npm view json-diffsync
```

For the first release:

```sh
npm publish --access public
```

After publishing, verify:

```sh
npm view json-diffsync name version license
npm install json-diffsync
```

## 6. Create GitHub Release

Create tag:

```sh
git tag v0.0.1
git push origin v0.0.1
```

Create a GitHub release titled:

```txt
json-diffsync v0.0.1
```

Suggested release notes:

```txt
Initial public release.

- JSON differential synchronization core
- React autosave hook
- Node HTTP sync helper
- Keyed array item-level patches
- Lossy metadata for unkeyed arrays
- Destructive patch guardrails
- HTTP and browser E2E tests
- Performance benchmark script
```

## 7. Next Hardening Steps

Before `1.0.0`, consider:

- Add TypeScript source or generate stricter `.d.ts` files.
- Add persistent storage adapters.
- Add conflict policy hooks.
- Optimize hashing/stringifying/cloning hot paths.
- Document API stability guarantees.
