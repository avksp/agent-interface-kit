# Export a Figma Design selection

[Russian version](../ru/how-to/export-figma-selection.md)

Use Figma Desktop and the AIK source checkout to build the development plugin. Use AIK CLI 0.1.0 on macOS arm64 with Node.js 26.13.1 or a later 26.x version. Install the CLI with `npm install -g agent-interface-kit@0.1.0`.

## Build and import

1. In a Figma Design file, open **Plugins → Development → New plugin**. Create a Design plugin and copy the ID from its generated `manifest.json`.
2. From the AIK checkout, run the commands below. Replace `<figma-id>` with the ID. Use an empty output directory.
3. In Figma Desktop, open **Plugins → Development → Import plugin from manifest**. Select `dist/figma-exporter/manifest.json`.

```sh
npm ci
npm run build --workspace @aik/figma-exporter -- --plugin-id '<figma-id>' --out dist/figma-exporter
```

[Figma manifest reference](https://developers.figma.com/docs/plugins/manifest/)

## Capture and compile

1. Select one visible Auto Layout frame directly on the current page. Open **Plugins → Development → AIK Figma Exporter**.
2. If the frame contains an image, enter its alt text. Select **Capture selection**, then **Save ZIP**.
3. Extract the ZIP to a new local directory. Keep `snapshot.json`, `overlay.json`, and the optional `assets/` directory together.
4. From the parent of the extracted `capture` directory, run the commands below. The staging directory MUST be private, free of extended ACLs, and on the same volume as `capture`. Use a new path for `site`.

```sh
mkdir -m 700 staging
aik lock --input ./capture --overlay ./capture/overlay.json --out ./capture/build.lock.json --staging-root "$(pwd -P)/staging"
aik compile --lock ./capture/build.lock.json --out ./site
aik verify --manifest ./site/artifact-manifest.json
```

The exporter supports horizontal and vertical Auto Layout, nested frames, text in one regular style, and rectangles with a solid fill. A frame MAY contain one image rectangle up to 512 by 512 pixels. Enter fresh alt text for each image capture, up to 200 UTF-16 code units. Turn off wrapping and clipping. Use plain fills and remove linked styles, variables, masks, effects, and strokes from the visible layers. The plugin rejects unsupported visible layers and does not modify the design. Figma can allocate a layer list or text value before the exporter applies its limits. If the selection changes during capture, select the frame and try again.

[Lock a capture](lock-capture.md) · [Publish an AIK plugin](publish-figma-plugin.md)
