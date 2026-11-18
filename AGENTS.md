# Agent Interface Kit

Read the [architecture](docs/architecture.md) and [product specification](docs/product-spec.md) before changing a public format or the support matrix. Use the [release checks](docs/verification.md) for the affected target. When local release plans are present, find them under `tasks/plans/`.

## Compiler boundaries

- A source adapter MUST convert a saved snapshot into source facts. The core MUST validate those facts and apply explicit rules. An output plugin MUST return a virtual file tree. The shared writer owns local file writes.
- With the same locked inputs, effective configuration, and toolchain, strict compilation MUST return the same file bytes and stable diagnostic fields. Preserve child order. Sort sets and file inventories. Keep clocks and model usage outside reproducible artifacts.
- Strict compilation MUST operate offline. Report a required unsupported feature or missing UI intent with a diagnostic and a source reference. Apply model proposals only after approval.
- Keep dependencies in the workspace that uses them. Prefer semantic elements and CSS for web output. List support only for verified source, profile, and target combinations.

## Code quality

Follow the [code quality and security rules](docs/reference/quality.md). Use the declared import direction. Validate untrusted JSON and resources before use. Preserve the runtime checks when you optimize.

## Development

- Install dependencies with `npm ci`. Activate local hooks with `npm run hooks:install`. Use the [commit convention](CONTRIBUTING.md).
- Run `npm run check` for types, typed lint, guards, and tests. Run `npm run audit:deps` for dependency advisories.
- When you change a contract, test a previous supported input and a relevant invalid input. Use two clean runs to verify byte equality. Use the real editor, browser, or SDK to verify that route.
- Write agent instructions, skills, and execution packets in English. Update both human-facing language versions when their meaning changes. Keep schema identifiers, commands, and code samples identical. [Writing reference](docs/reference/writing.md)

## Local plans and skills

An independent solution review MUST finish before plan freeze. Use the [review procedure](docs/how-to/run-reviews.md) for model selection and the periodic ARS audit.

For work that uses ALK, follow the active revision, write scope, and evidence requirements. A `DRAFT` plan can guide discussion. Execution requires the authorization for the selected workflow. Keep local plans and research under the Git-ignored `tasks/` directory.

- [aik-source-adapter](.agents/skills/aik-source-adapter/SKILL.md) for input sources and snapshots.
- [aik-target-emitter](.agents/skills/aik-target-emitter/SKILL.md) for output plugins and profiles.
- [aik-conformance](.agents/skills/aik-conformance/SKILL.md) for contract tests and evidence.
