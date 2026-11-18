# Code quality and guards

[Russian version](../ru/reference/quality.md)

## Design rules

- Apply SOLID at real boundaries. Keep code that changes for one reason in one module. Put interfaces at real replacement points. An implementation of an interface MUST preserve its stated behavior. A consumer SHOULD depend only on the operations it uses. Connect implementations at the host boundary.
- Apply DRY when rules and reasons to change are the same. Follow KISS with direct control flow and existing APIs. Apply YAGNI and add abstractions when a current requirement needs them.
- Use strict TypeScript and ESM. Use `node:` for Node.js built-ins. At an untrusted boundary, treat incoming values as unknown. Validate them before use. Avoid unsafe assertions, floating promises, and hidden process state. Use explicit errors and release resources when a step fails.
- Measure performance in a fixed environment. An optimization MUST preserve the architecture, security controls, and observable behavior.

## Import boundaries

| Source layer | Allowed project dependencies |
| --- | --- |
| `design-tokens` | Its own modules and shared contracts |
| `compile-core` | Its own modules, shared contracts, and token logic. Its writer uses the dedicated `src/writer/` subtree |
| Source plugins | The core API, token logic, and shared contracts. The editor and network live at the capture boundary |
| Web mapping | The core API, token logic, and shared contracts |
| Output plugins | The core API, token logic, shared contracts, and applicable shared mapping rules |
| CLI, MCP, AI integration, editor hosts | Compose lower layers through public interfaces |

The dependency guard checks statically resolved imports, type imports, and re-exports. It rejects cycles, unresolved edges, reverse dependencies, cross-plugin imports, and product imports from tools or tests. Use workspace package exports for cross-package APIs.

## Security rules

- Pure stages MUST stay offline. Keep file writes in the writer. Keep editor, network, and process access in host layers. Use explicit inputs for values that affect reproducibility.
- Treat designs, archives, model proposals, and plugin metadata as data. Validate schema, size and depth limits, and asset digests. Escape output for its context. Apply URL and asset format policy before output. The writer MUST check resolved paths, symlinks, collisions, and prior output before publication.
- Keep credentials out of tracked files, diagnostics, and evidence. Use explicit arguments for a reviewed host process. Avoid a shell for untrusted input. Dependency installation skips lifecycle scripts by default. Audit the locked dependency tree.
- Explain any scoped lint exception with its reason and review evidence. When a guard fails, fix the violation or review the rule change.

| Check | Command | Observable result |
| --- | --- | --- |
| TypeScript and typed lint | `npm run typecheck`, `npm run lint` | Fail on invalid code, unsafe type use, or selected dangerous APIs |
| Architecture | `npm run guard:architecture` | Fail on a forbidden or unresolved dependency |
| Security | `npm run guard:security` | Fail on a forbidden dependency or a private path in the Git index |
| Dependencies | `npm run audit:deps` | Fail on high or critical advisories reported for the locked dependency tree |
| Local quality checks | `npm run check` | Run type, lint, import, index, and test checks |

Static guards cover the configured patterns. Editor behavior, filesystem containment, active content, and concurrency need the corresponding negative and integration tests. [Verification](../verification.md)
