# Contributing

[Russian version](docs/ru/how-to/contribute.md)

## Set up the checkout

1. Select the Node.js version in `.nvmrc`.
2. Select the npm version in `package.json`. You can install it with `npm install --global --ignore-scripts npm@12.2.3`.
3. Run `npm ci`.
4. Run `npm run hooks:install`. This sets the local Git hooks path.
5. Run `npm run check` and `npm run audit:deps`.

The pre-commit hook exports the staged files to a temporary directory. It installs the staged lockfile from the local npm cache and runs `npm run check` there. If the cache lacks a package, run `npm ci` for the lockfile you will stage. Git also checks the commit subject. CI runs the same local checks and checks the lockfile against the npm advisory service. [Quality reference](docs/reference/quality.md)

## Name commits

Use a short English imperative subject. The format is `<type>(optional-scope)[!]: <summary>`. The subject MUST fit in 72 characters. Use a lowercase scope, with hyphens between words.

| Type | Use |
| --- | --- |
| `feat`, `fix` | A user capability or a correction to behavior or compatibility |
| `docs`, `test` | Documentation-only or test-only changes |
| `refactor`, `perf` | Internal structure or measured performance |
| `build`, `ci`, `chore` | Tooling, automation, or maintenance |

```text
feat(core): read a saved snapshot
fix(html)!: reject unsupported link schemes
docs(contracts): explain diagnostic references
test(guards): cover a forbidden import
chore(release): prepare v0.1.0
```

Keep one change per commit. Mark a breaking change with `!` or a `BREAKING CHANGE:` footer. Use `chore(release): prepare vX.Y.Z ...` for a release, version bump, or release metadata.

## Review a release plan

Follow the [review procedure](docs/how-to/run-reviews.md) before plan freeze and when a periodic audit is due.
