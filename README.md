# Agent Interface Kit

Agent Interface Kit (AIK) is a design-to-UI compiler project. It turns a saved design and explicit project rules into reproducible source files for web and mobile UIs and UI kits. Source adapters and output plugins use the same compiler contract.

The first planned release converts a Figma selection into semantic HTML and CSS offline. This repository contains the development setup, draft contracts, and design documents.

## Development

Use the Node.js version in `.nvmrc` and the npm version in `package.json`.

```bash
nvm use
npm ci
npm run hooks:install
npm run check
```

The check runs TypeScript, typed lint, architecture and security guards, and tests. Add source packages under `packages/` and host integrations under `integrations/`.

- [Documentation](docs/README.md)
- [Agent instructions](AGENTS.md)
- [Contributing](CONTRIBUTING.md)
- [Russian version](docs/ru/overview.md)

Local research and release drafts are in `tasks/`. Git ignores this directory.
