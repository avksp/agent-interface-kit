import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const args = parseArgs({ options: { "plugin-id": { type: "string" }, out: { type: "string" } } }).values;
const id = args["plugin-id"];
if (!id || !/^[0-9]{1,30}$/u.test(id) || !args.out) {
  throw new Error("Usage: npm run build --workspace @aik/figma-exporter -- --plugin-id <Figma ID> --out <empty directory>");
}
const destination = resolve(args.out);
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length !== 0) throw new Error("Use an empty output directory.");

const workspace = fileURLToPath(new URL("../", import.meta.url));
async function bundle(path: string): Promise<string> {
  const result = await build({
    absWorkingDir: workspace, entryPoints: [path], write: false, bundle: true, format: "iife",
    platform: "browser", target: "es2020", legalComments: "inline", charset: "ascii",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("Exporter bundle is empty.");
  return file.text;
}

const [main, ui] = await Promise.all([bundle("plugin/main.ts"), bundle("src/ui.ts")]);
if (/<\/script/iu.test(ui)) throw new Error("Unsafe inline script terminator.");
const digest = createHash("sha256").update(ui).digest("base64");
const html = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'; script-src \'sha256-' + digest + '\'">',
  "<title>AIK Figma Exporter</title></head><body>",
  '<label for="alt">Image alt text</label>',
  '<input id="alt" type="text" maxlength="200" autocomplete="off">',
  '<p><button id="capture" type="button">Capture selection</button></p>',
  '<p id="status" role="status">Select one frame. Enter alt text if it has an image.</p>',
  '<a id="save" download="aik-figma-capture.zip" hidden>Save ZIP</a>',
  "<script>" + ui + "</script></body></html>\n",
].join("\n");
const manifest = {
  name: "AIK Figma Exporter", id, api: "1.0.0", main: "main.js", ui: "ui.html",
  editorType: ["figma"], documentAccess: "dynamic-page", networkAccess: { allowedDomains: ["none"] },
};
await writeFile(join(destination, "main.js"), main, { flag: "wx" });
await writeFile(join(destination, "ui.html"), html, { flag: "wx" });
await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
