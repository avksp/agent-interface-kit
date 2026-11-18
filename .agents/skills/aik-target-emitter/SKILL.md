---
name: aik-target-emitter
description: Develop or review Agent Interface Kit output plugins. Use when adding an HTML, framework, native, design, or UI-kit target, or changing a profile or target capability.
---

# AIK output plugin

Select a target, profile, and configuration. Check which tokens, roles, events, layout rules, and assets the target can preserve. [Product specification](../../../docs/product-spec.md)

- Read a valid `UiDocument`, resolved assets, and effective configuration. Report an unsupported feature as a blocking error or an allowed fallback. Include the source reference.
- Return relative paths and file bytes. The shared writer checks paths, collisions, and limits before it writes. Preserve child order. Keep file names and formatting stable.
- On the web, prefer native semantics and CSS custom properties. Add JavaScript for declared behavior when CSS cannot provide it. For native output, use the target SDK for safe areas, text scaling, roles, and actions.
- Build the output in a clean consumer. For a new profile, test one supported case and one unsupported case. For a current target, also run its existing corpus. [Verification](../../../docs/verification.md)
