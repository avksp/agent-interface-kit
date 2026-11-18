# Writing reference

[Russian version](../ru/reference/writing.md)

## Language

English is the reference language. Each human-facing guide MUST have a Russian translation. Use English for `README.md`, `AGENTS.md`, skills, and files that agents use to execute or review work. Put Russian human-facing translations under `ru/`. Update both language versions in the same change. Keep commands, paths, identifiers, code samples, units, thresholds, and the force of each requirement the same.

## Short technical English

Use these rules from Simplified Technical English (STE) as guidance. Write short sentences in the active voice. Name the actor and use one term per concept. For procedures, write one action per step. Put the condition before the action. Keep exceptions and refusal conditions explicit. [ASD-STE100 overview](https://asd-ste100.org/about.html)

Use the Feynman technique to test an explanation. Explain the term in simple words. Give a concrete example. If the example needs an unexplained term, define it or use a simpler example. For example, a snapshot is a saved copy of the input. Opening the same snapshot gives the compiler the same design bytes.

## Requirement keywords

Use uppercase requirement terms in normative clauses. Interpret them according to BCP 14. Use lowercase words for ordinary prose. [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) · [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)

| Term | Meaning |
| --- | --- |
| MUST, MUST NOT | Required behavior or a prohibition |
| SHOULD, SHOULD NOT | Default advice. Understand and weigh the effects before you make an exception |
| MAY | A permitted option |

Name the actor, the condition, the action, and an observable check. For example, if JSON has no `sourceRef` field, the diagnostic validator MUST reject it. The test omits the field and checks that validation fails. [Diagnostic schema](../../schemas/diagnostic.v1.schema.json)

## Document types

Use the document type that matches the reader's goal. Keep each type focused. [Diátaxis](https://diataxis.fr/)

| Type | Use | AIK location |
| --- | --- | --- |
| Explanation | Explain why the design works this way | `docs/architecture.md` |
| Reference | Look up a field, rule, or interface | `docs/reference/` |
| How-to guide | Complete a task with an observable result | `docs/how-to/` |
| Tutorial | Learn by completing an example from start to finish | Add when a runnable example is available |

## Machine-readable contracts

For a versioned JSON format, document the schema, field meanings, and rules that need a runtime check. Define structural requirements in JSON Schema Draft 2020-12. Test a valid example and a relevant invalid case. Keep ALK files on the schemas provided by ALK. [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12) · [AIK contracts](contracts.md)
