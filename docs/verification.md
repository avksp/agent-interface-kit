# Verification

[Russian version](ru/verification.md)

## Test corpus

For 0.1, use at least two original Figma frames. The first is a responsive page with headings, text, a local image, and declared navigation. The second uses nested Auto Layout, long text, and an explicit reading order. For 0.2, add a component with variants and a slot, light and dark themes, and a separate UI-kit consumer.

Record design references independently of compiler output. Use available fonts and permitted assets. Each route MUST have a real input, an invalid input, and a case with known loss. For 0.1, cover a missing action, a missing asset, and an unsupported mask. Test reordered JSON keys, child order, normalized name collisions, invalid paths, interrupted writes, and an unsupported input version.

## Proposed 0.1 thresholds

| Check | Evidence and criterion |
| --- | --- |
| Reproducibility | Run the same lock in two empty directories on the pinned platform. Compare all relative paths and SHA-256 values, including assets and the manifest. Compare stable fields for invalid input. Test a retry in place and refusal after manual edits |
| Semantics and accessibility | Check valid markup, landmark roles, headings, link names, tab order, and visible focus. The corpus has zero serious or critical axe violations. Use manual keyboard checks for behavior that axe cannot verify. [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) |
| Responsive layout | Test 320, 768, and 1280 CSS px. Check unwanted horizontal overflow, overlap, and clipped long text. Check layout and reading order at 200% text size. Test right-to-left writing from 0.2 or when support is declared |
| Visual comparison | Compare with independent design references. The proposed geometry tolerance is 2 CSS px for selected containers. Pin the OS, browser, device pixel ratio, and fonts for screenshot tests. Disable animation. Save the reference and diff. Calibrate pixel tolerance on real exports. [Playwright snapshots](https://playwright.dev/docs/test-snapshots) |
| Size and dependencies | The static corpus has 0 JS bytes, 0 runtime packages, and 0 undeclared network requests. Proposed per-page HTML and CSS limit is 12 KiB gzip with fixed settings, excluding assets. Record total bytes and file count with assets separately. Limit DOM nodes to 120% of the manual equivalent |
| Speed and memory | Pin the runner. Run 3 warm-ups and 20 measurements on a snapshot with 1000 nodes and up to 5 MiB of assets. Time from input read to manifest write and exclude Figma capture. Proposed limits are p95 ≤ 1 s and peak RSS ≤ 256 MiB. Record the environment, raw results, failures, and successes |
| Refusal and write | Invalid input yields a stable code and `sourceRef`. Preserve prior output and publish no partial files. Confirm output media types, paths, size, and resource links |

Before freeze, pin the runner, fixture sizes, reference versions, asset access, method, tolerances, and exceptions. Record compiler time, SDK build time, and web runtime separately. Repeat measurements when the measured environment changes.

## Checks after 0.1

- **UI kit.** Build and run a local package in a clean consumer. Test a slot, light and dark themes, two variants, and an event. Round-trip token aliases and types. Refuse a missing state or binding. Measure the bundle increase over an empty consumer of the same version.
- **New sources.** Compare with the real editor and replay the saved snapshot. Compare normalized facts for shared primitives. Test format-specific features separately.
- **Coding tools.** Compare the CLI with two real MCP clients on one lock. Compare all files and stable diagnostic fields. Measure proposal quality, retries, failures, and cost separately. Record unavailable telemetry as null.
- **Native.** Build and run a clean host app with pinned SDKs. Test theme, safe areas, orientation, text scaling, role, name, and event on a simulator for each declared platform.
- **Editable export.** Apply the plan to an empty test document in the real editor. Recapture the result. Compare the supported tree, text, geometry, and bindings. Use the mapping table for editor-assigned IDs.

## Compare alternatives

Use the same primary corpus for a manual reference, FigmaToCode, a tool with a visual editor, and direct agent generation. Compare TeleportHQ at the code generation stage with the same UI intent. Record the work needed to prepare UIDL.

Record versions, settings, inputs, outputs, and check results before manual edits. For variable output, run each case at least three times. Record all results and use the same allowance for manual work. Measure time to an accepted result, manual decisions, semantic and layout coverage, size, dependencies, losses, and repeat-run digests. Publish only permitted fixtures and link to the method. If the first route matches a simple plugin on manual work and semantics, measure the value of offline replay and a second editor before expanding scope.
