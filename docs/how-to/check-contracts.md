# Check a JSON contract

[Russian version](../ru/how-to/check-contracts.md)

1. Open the repository root. Use the Node.js version in `.nvmrc`.
2. Install locked dependencies with `npm ci`.
3. Edit the schema and its example under `schemas/`. Use the [contract reference](../reference/contracts.md) for field meanings.
4. If you change a structural rule, update or add a test in [contracts.test.mjs](../../tests/contracts.test.mjs). Include a value that passes and one that fails for the affected rule.
5. Run `npm run check:contracts`. Expect the examples to pass and invalid records to be rejected.
6. Run `npm run check` to check types, lint, guards, contracts, and documentation links.

If a schema rejects a previously supported input, decide how to preserve compatibility. When a breaking change is required, use a new schema version and state the migration path.
