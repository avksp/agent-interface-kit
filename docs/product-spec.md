# Product specification

[Russian version](ru/product-spec.md)

This specification describes planned support.

## Users and outcomes

- A developer compiles a design into source files and builds the result in a clean project. A second import makes file changes easy to inspect.
- A design system team matches tokens and components to its catalog. The team gets a UI kit with declared variants and reports for missing bindings.
- A coding agent uses the same contract through CLI or MCP. It reads stable diagnostic IDs and proposes decisions for approval. Install the agent integration separately from the core.

Compare AIK with existing tools on the same designs. Measure output quality, manual work, and reproducibility.

## Profiles and targets

| Profile | Output | First planned release |
| --- | --- | --- |
| `site` | Semantic pages, CSS, local assets, and declared links | 0.1 · HTML/CSS |
| `ui` | A screen or component with declared properties, slots, and event IDs. The host binds data and effects | 0.2 · React and TypeScript |
| `kit` | Tokens, themes, component contracts, variants, and examples. A target binding adds component source files | 0.2 · React, TypeScript, and DTCG |

Select a target, profile, and configuration separately. HTML/CSS is a target. BEM is a CSS naming convention. JavaScript or TypeScript applies to behavior and integrations when required. The support matrix lists valid combinations.

| Input or output | Planned support |
| --- | --- |
| Designs with a layer tree | Figma selection snapshot in 0.1. Sketch and Penpot in 0.3 |
| Unstructured input | User story and PNG in 0.4. A model proposes rules for approval |
| Web output | HTML/CSS and BEM in 0.1. React and TypeScript in 0.2. Vue, Angular, Web Components, and target-specific JS/TS in 0.6 |
| Native output | React Native in 0.5. SwiftUI and Jetpack Compose in 0.7 |
| Design exchange | DTCG tokens in 0.2. Editable Figma export and an SVG route in 0.8 |
| Agent interfaces | Versioned JSON CLI in 0.1. MCP and installable coding tool adapters in 0.4 |

Test compatibility before adding another format. The order depends on confirmed editor and SDK capabilities.

## Behavior

- The same supported snapshot, resolved bindings, profile, and lock MUST produce the same files and machine-readable diagnostics for the same request.
- When intent is ambiguous, the user supplies a rule or accepts a proposal. A shape labeled **Buy** can link to a page or submit a form. Strict compilation MUST report the missing action at that node.
- The default `strict` policy MUST stop on an unsupported required feature. A user MAY enable `best-effort` and allow specific diagnostic codes. A decorative illustration can become a local asset if the compiler reports the loss of editability. Both policies MUST stop when required semantics, interaction, or accessibility would be lost.
- Responsive output MUST use observed layout, declared variants, breakpoints, and supported constraints. The tree sets the reading order. Test long text and real text scaling.
- The initial product uses a local CLI and plugins. Host apps bind events and data. Business logic inference, backend generation, cloud publishing, editing hand-maintained files, and bidirectional sync are outside the current drafts.

## Feasibility checks

| Decision | Evidence before freeze |
| --- | --- |
| Figma capture through the Plugin API | Export two linked test frames. Record scope, Auto Layout, assets, and source links. Report inaccessible library items |
| Figma-to-HTML rules | Set reading order and navigation without repeating geometry. Run responsive and accessibility checks against two independent design references |
| One offline compiler for coding tools | Send the same locked request through CLI and MCP clients. Compare files, diagnostics, and retry behavior |
| Sketch, Penpot, and editable export | Record the actual format version and access scope. Test an unsupported structure |
| UI kit and native output | Build the package in a clean app. Check behavior. Run native output on the announced SDK and simulator |

Before freeze, confirm the pilot corpus, asset and font rights, target consumers, SDK versions, and execution budget.
