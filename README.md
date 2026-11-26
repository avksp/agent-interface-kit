# Agent Interface Kit

[![GitHub CI](https://github.com/avksp/agent-interface-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/avksp/agent-interface-kit/actions/workflows/ci.yml)
[![License Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)
![Pilot 0.1.0](https://img.shields.io/badge/pilot-0.1.0-blue.svg)
![Node.js 26](https://img.shields.io/badge/Node.js-26.13.1-green.svg)
![npm 12.2.3](https://img.shields.io/badge/npm-12.2.3-red.svg)

Agent Interface Kit (AIK) turns saved designs and explicit project rules into reproducible UI source files. Source adapters and output plugins use the same compiler contract.

The 0.1.0 pilot compiles a supported Figma snapshot into semantic HTML and CSS offline. The CLI has been verified on macOS 15 or later with Apple silicon and Node.js 26.13.1. The supported Node.js range is `>=26.13.1 <27`. Development and release CI use npm 12.2.3.

- [Build and release the npm package](docs/how-to/release-npm.md)
- [Prepare and publish a Figma Community plugin](docs/how-to/publish-figma-plugin.md)

## Development

Use the Node.js version in `.nvmrc` and the npm version in `package.json`.

```bash
nvm use
npm ci
npm run hooks:install
npm run build:secure-fs
npm run check
```

The check runs TypeScript, typed lint, architecture and security guards, and tests. Add source packages under `packages/` and host integrations under `integrations/`.

- [Documentation](docs/README.md)
- [Agent instructions](AGENTS.md)
- [Contributing](CONTRIBUTING.md)
- [Russian version](docs/ru/overview.md)

Local research and release drafts are in `tasks/`. Git ignores this directory.
