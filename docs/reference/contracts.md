# JSON contracts

[Russian version](../ru/reference/contracts.md)

These are draft formats for the compiler boundary. Their schemas and examples use JSON Schema Draft 2020-12. The URNs identify schemas in local files. For normative keywords, see the [writing reference](writing.md). [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)

| Format | Schema | Valid example |
| --- | --- | --- |
| Diagnostic v1 | [Schema](../../schemas/diagnostic.v1.schema.json) | [Missing action](../../schemas/examples/diagnostic.v1.json) |
| Artifact manifest v1 | [Schema](../../schemas/artifact-manifest.v1.schema.json) | [One HTML file](../../schemas/examples/artifact-manifest.v1.json) |

## Diagnostic v1

| Field | Requirement |
| --- | --- |
| `code` | MUST be a stable machine code. Start with an uppercase ASCII letter. Use uppercase ASCII letters, digits, and single underscores between groups. Example `MISSING_ACTION` |
| `severity` | MUST be `info`, `warning`, or `error` |
| `sourceRef` | MUST be a nonempty source reference or `null` when no source location applies |
| `feature` | MAY identify the relevant capability as a nonempty string |
| `fallback` | MAY identify an allowed fallback as a nonempty string |

A consumer MUST use `code` for program decisions. It SHOULD use `sourceRef` to show the user where to act. For example, when a Figma node has no action, the compiler reports `MISSING_ACTION` and the reference to that node.

## Artifact manifest v1

The writer MUST emit `schemaVersion` with value `aik-artifact-manifest.v1` and a `files` array. Each file record MUST have the following fields.

| Field | Requirement |
| --- | --- |
| `path` | A relative path with `/` separators. The schema rejects empty, absolute, drive-qualified, and dot-segment paths. It also rejects backslashes, control characters, and the root manifest's own path |
| `mediaType` | A lowercase media type such as `text/html`, without parameters |
| `sha256` | A lowercase hexadecimal SHA-256 digest of the file bytes, with 64 characters |

The example lists the SHA-256 of the UTF-8 bytes of `<main>Example</main>` followed by LF. The writer MUST also check path containment, collisions after normalization, deterministic order, and the digest of each actual file. These checks use the output directory and bytes. [Architecture](../architecture.md)

Run the [local contract checks](../how-to/check-contracts.md) after an edit.
