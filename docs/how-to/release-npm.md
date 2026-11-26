# Release the AIK CLI on npm

[Russian translation](../ru/how-to/release-npm.md)

The pilot package is `agent-interface-kit`. It installs the `aik` command on macOS 15 or later with Apple silicon. Use Node.js `>=26.13.1 <27`. Release CI uses Node.js 26.13.1 and npm 12.2.3.

## Verify the package

1. Open **Actions → npm release → Run workflow** on `main`. Keep **publish** unchecked.
2. Wait for the build to pass. Download the `aik-npm` artifact. It contains the tarball and its manifest with the source commit, package version, file list and SHA-256.
3. For a local check, use an empty output path and a Mac with Xcode command line tools.

```sh
npm ci --ignore-scripts
node tools/pack-npm.mjs dist/npm
node tools/smoke-npm.mjs dist/npm/agent-interface-kit-0.1.0.tgz
```

The tarball includes the five production dependency packages from the source lock. The smoke test installs it offline with an empty npm cache. It runs `lock`, `compile`, and `verify` with network access blocked and compares the lock and output bytes with those from the source CLI.

## Register the first package

The npm maintainer MUST sign in to npm and complete the account's authentication checks. Use the tarball from the approved GitHub build. To submit it for an interactive approval, run `npm stage publish <tarball> --access public`, then approve it in the npm web interface. Staging a new package can make a placeholder public. Start this step only after approval to release.

[npm package publication](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

## Configure Trusted Publishing

In the npm package's **Settings → Trusted publishing**, add a GitHub Actions publisher. Select permission for `npm publish` and use the values below. Keep the GitHub `npm` environment restricted to `main`.

| Field | Value |
| --- | --- |
| Organization or user | `avksp` |
| Repository | `agent-interface-kit` |
| Workflow filename | `npm-release.yml` |
| Environment | `npm` |

For a subsequent release, the version tag MUST resolve to the exact `main` commit used by the run. Dispatch **npm release** from that commit with **publish** checked. The workflow publishes the same tarball that passed the smoke test. Verify the registry version with `npm view agent-interface-kit version` and install that exact version on a fresh supported machine.

[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
