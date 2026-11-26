# Publish an AIK plugin to Figma Community

[Russian translation](../ru/how-to/publish-figma-plugin.md)

The AIK pilot exporter is a private desktop capture tool. It binds a run to one document using `figma.fileKey` and uses `enablePrivatePluginApi`. Figma limits that API to private plugins. A public AIK exporter requires a separate build and a public plugin ID.

[Figma Plugin API](https://developers.figma.com/docs/plugins/api/figma/)

## Prepare the public build

1. Read explicitly selected Figma Design frames through the public Plugin API. The public build MUST use neither private APIs nor a fixed file key. Give the user control over which frames are exported.
2. Export a saved capture and its required assets. Verify it against the AIK snapshot contract and run `aik lock`, `aik compile`, and `aik verify` with a representative capture. Test empty selection, a supported frame and a required unsupported feature.
3. In Figma Desktop, create or import the development plugin. Use the stable plugin ID assigned by Figma. The manifest MUST declare its entrypoints, Design editor type and network access. An offline exporter uses `networkAccess.allowedDomains: ["none"]`. Test that the UI saves the intended file.

[Figma manifest reference](https://developers.figma.com/docs/plugins/manifest/)

## Submit the plugin

1. Open a Design file in Figma Desktop for macOS or Windows. In **Plugins → Manage plugins**, select **Publish** next to the development plugin. Starter accounts can submit classic plugins from Desktop.
2. Choose **Community** if Figma offers a destination selector. Add the name, tagline, description, category and support contact. Prepare a 128×128 icon and a 1920×1080 cover. Use a synthetic design for public images or an example file.
3. Review the displayed network access and complete relevant security disclosures. Select **Publish** to submit the first build for Figma review.
4. Wait for **Published**. Open the Community listing and run an installed copy in a separate test file. Confirm export and CLI import on that copy. For an update, use **Publish new version** with the same plugin ID.

[Figma Community publication](https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community) · [Publish an update](https://help.figma.com/hc/en-us/articles/360042293714-Manage-classic-plugins-as-a-developer)
