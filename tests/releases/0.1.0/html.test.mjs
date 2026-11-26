import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { CompilerError, hash } from "@aik/compile-core";
import { htmlTarget } from "../../../packages/target-html/src/index.ts";
import { png } from "./support/core-harness.mjs";

/** @typedef {import("@aik/compile-core").UiNode} UiNode */
/** @typedef {import("@aik/compile-core").AssetRef} AssetRef */
/** @typedef {import("@aik/compile-core").BuildOptions} BuildOptions */

/**
 * @param {string} id
 * @param {Partial<UiNode>} [properties]
 * @returns {UiNode}
 */
function node(id, properties = {}) {
  return { id, sourceRef: "fixture:" + id, kind: "frame", children: [], intent: {}, ...properties };
}

/**
 * @param {UiNode[]} roots
 * @param {BuildOptions["naming"]} [naming]
 * @param {AssetRef[]} [assets]
 * @param {ReadonlyMap<string, Uint8Array>} [bytes]
 */
function render(roots, naming = "plain", assets = [], bytes = new Map()) {
  const output = htmlTarget.render({ schemaVersion: "aik.ui-document.v1", roots, assets }, bytes,
    { profile: "site-v1", naming });
  const files = new Map(output.files.map((file) => [file.path, Buffer.from(file.bytes)]));
  return { files, diagnostics: output.diagnostics ?? [] };
}

/** @param {Map<string, Buffer>} files @param {string} name */
function content(files, name) {
  const bytes = files.get(name);
  assert.ok(bytes, name);
  return bytes.toString("utf8");
}

/** @param {string} href @param {string} [kind] @param {string} [targetNodeId] */
function link(href, kind = "fragment", targetNodeId = "note") {
  return node("link", { kind: "text", text: "Read <&> this", intent: {
    navigation: { href, kind, targetNodeId, accessibleName: 'Read "this"' },
  } });
}

const note = node("note", { intent: { landmark: { element: "section", accessibleName: "Note", anchorId: "note" } } });

/** @param {() => unknown} action @param {string} code @param {string} source */
function refuses(action, code, source) {
  assert.throws(action, (error) => error instanceof CompilerError &&
    error.diagnostic.code === code && error.diagnostic.sourceRef === "fixture:" + source);
}

void test("site-v1 preserves input root order, local navigation and matching class selectors", () => {
  const malicious = "</title><script>alert(1)</script>";
  const root = node("root", {
    facts: { layoutMode: "HORIZONTAL", width: 640 },
    intent: { title: malicious, backdrop: { rgbHex: "#060615" }, "responsive-stack": { belowCssPx: 640, direction: "column" } },
    children: [link("#%6eote"), note, node("cell", { facts: { width: 320, layoutSizingHorizontal: "FIXED" } }),
      node("jump", { kind: "text", text: "Next", intent: { navigation: {
        kind: "page", href: "case-2.html", targetNodeId: "second",
      } } })],
  });
  const roots = [root, node("second")];
  for (const naming of /** @type {const} */ (["plain", "bem"])) {
    const { files, diagnostics } = render(roots, naming);
    assert.deepEqual([...files.keys()], ["index.html", "case-2.html", "styles.css"]);
    assert.deepEqual(diagnostics, []);
    const html = content(files, "index.html");
    const css = content(files, "styles.css");
    assert.match(html, /href="#note" aria-label="Read &quot;this&quot;">Read &lt;&amp;&gt; this/u);
    assert.match(html, /href="case-2\.html"/u);
    assert.match(html, /<section[^>]+id="note" aria-label="Note">/u);
    assert.ok(!html.includes(malicious) && !html.includes("<script"));
    const className = naming === "bem" ? "page-1__node-3" : "page-1-node-3";
    assert.ok(html.includes('class="' + className + '"') && css.includes("." + className + "{"));
    assert.ok(css.includes("--aik-backdrop:#060615") && css.includes("background:var(--aik-backdrop)"));
    assert.ok(css.includes("@media (width < 640px)"));
    assert.deepEqual(render(roots, naming).files, files);
  }
});

void test("site-v1 refuses unresolved, malformed and cross-scope destinations", () => {
  const invalid = [
    "https://example.com/", "javascript:alert(1)", "//example.com/a.html", "%2f%2fexample.com",
    "../index.html", "%2e%2e%5cindex.html", "%252findex.html", "#note%0a", "#absent", "#%",
    "case-2.html#note", "INDEX.html", "index.html?query=value", "",
  ];
  for (const href of invalid) {
    refuses(() => render([node("root", { children: [link(href), note] }), node("second")]), "UNSAFE_LINK", "link");
  }
  refuses(() => render([node("root", { children: [link("#note", "fragment", "wrong"), note] })]), "UNSAFE_LINK", "link");
  refuses(() => render([node("root", { children: [note, node("dupe", { intent: note.intent })] })]),
    "INVALID_UI_DOCUMENT", "dupe");
});

void test("site-v1 requires actions and preserves the allowed raster loss diagnostic", () => {
  const actionable = node("action", { kind: "text", text: "Continue", facts: { reactions: [{ action: {} }] } });
  refuses(() => render([node("root", { children: [actionable] })]), "MISSING_ACTION", "action");
  const masked = node("masked", { facts: { isMask: true } });
  refuses(() => render([node("root", { children: [masked] })]), "UNSUPPORTED_MASK", "masked");
  const path = "assets/decor.png";
  const raster = node("decor", { kind: "vector", asset: path, facts: { width: 2, height: 2 },
    intent: { fallback: "passive-raster", "image-alt": "" } });
  const roots = [node("root", { children: [raster] })];
  const assets = /** @type {AssetRef[]} */ ([{ path, sha256: hash(png), mediaType: "image/png" }]);
  const { files, diagnostics } = render(roots, "plain", assets, new Map([[path, png]]));
  assert.deepEqual(files.get(path), png);
  assert.match(content(files, "index.html"), /<img[^>]+src="assets\/decor.png" alt=""/u);
  assert.deepEqual(diagnostics, [{ code: "KNOWN_LOSS", severity: "warning", sourceRef: "fixture:decor",
    feature: "visual-fidelity", fallback: "passive-raster" }]);
  refuses(() => render(roots, "plain", assets, new Map([[path, Buffer.from("<svg/>")]])), "ASSET_TYPE_MISMATCH", "decor");
  refuses(() => render([node("root", { children: [{ ...raster, intent: {} }] })], "plain", assets,
    new Map([[path, png]])), "UNSUPPORTED_NODE", "decor");
});

void test("site-v1 rejects unsupported semantic and style input at the source", () => {
  refuses(() => render([node("root", { intent: { semantic: "script" } })]), "INVALID_OVERLAY", "root");
  refuses(() => render([node("root", { intent: { backdrop: { rgbHex: "#112233;url(//example.com)" } } })]),
    "INVALID_OVERLAY", "root");
  refuses(() => render([node("root", { facts: { width: "1px;background:url(//example.com)" } })]),
    "UNSUPPORTED_LAYOUT", "root");
});

void test("site-v1 retains raster anchors and rejects unsupported raster semantics", () => {
  const path = "assets/image.png";
  const assets = /** @type {AssetRef[]} */ ([{ path, sha256: hash(png), mediaType: "image/png" }]);
  const bytes = new Map([[path, png]]);
  /** @param {UiNode["intent"]} intent */
  const withRaster = (intent) => render([node("root", { children: [
    node("image", { kind: "rectangle", asset: path, intent: { "image-alt": "Winter", ...intent } }),
  ] })], "plain", assets, bytes);
  const { files } = withRaster({ landmark: { anchorId: "winter" } });
  assert.match(content(files, "index.html"), /<img[^>]+id="winter"[^>]+alt="Winter"/u);
  refuses(() => withRaster({ semantic: "section" }), "INVALID_OVERLAY", "image");
  refuses(() => withRaster({ semantic: "script" }), "INVALID_OVERLAY", "image");
  refuses(() => withRaster({ landmark: { anchorId: "winter", accessibleName: "Photo" } }), "INVALID_OVERLAY", "image");
  refuses(() => withRaster({ landmark: "section" }), "INVALID_OVERLAY", "image");
});

/** @param {number} levels */
function nested(levels) {
  let current = node("d" + levels);
  for (let depth = levels - 1; depth > 0; depth--) {
    current = node("d" + depth, { children: [current] });
  }
  return current;
}

void test("site-v1 enforces the shared depth limit through the direct render entry point", () => {
  assert.match(content(render([nested(32)]).files, "index.html"), /data-node="d32"/u);
  refuses(() => render([nested(33)]), "INPUT_LIMIT_EXCEEDED", "d33");
});

void test("site-v1 checks raster integrity even when both images have the same media type", () => {
  const path = "assets/image.png";
  const marker = Buffer.from("tEXtAIK\0second", "utf8");
  const chunk = Buffer.alloc(8 + marker.length);
  chunk.writeUInt32BE(marker.length - 4);
  marker.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(marker), 4 + marker.length);
  const second = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  /** @type {AssetRef} */
  const asset = { path, sha256: hash(png), mediaType: "image/png" };
  const secondAsset = { ...asset, sha256: hash(second) };
  assert.notEqual(asset.sha256, secondAsset.sha256);
  const image = node("image", { kind: "rectangle", asset: path, intent: { "image-alt": "Winter" } });
  const roots = [node("root", { children: [image] })];
  const secondBytes = new Map([[path, second]]);
  assert.deepEqual(render(roots, "plain", [asset], new Map([[path, png]])).files.get(path), png);
  assert.deepEqual(render(roots, "plain", [secondAsset], secondBytes).files.get(path), second);
  refuses(() => render(roots, "plain", [asset], secondBytes), "INPUT_DIGEST_MISMATCH", "image");
});

void test("site-v1 bounds the total number of nodes across the direct render", () => {
  const children = Array.from({ length: 1999 }, (_, index) => node("cap-" + index));
  assert.match(content(render([node("root", { children })]).files, "index.html"), /data-node="cap-1998"/u);
  refuses(() => render([node("root", { children }), node("extra")]), "INPUT_LIMIT_EXCEEDED", "extra");
});

void test("site-v1 checks the aggregate UTF-8 string budget before escaping", () => {
  const family = "Fónt";
  const rgbHex = "#123456";
  const first = node("first", { kind: "text", text: "é".repeat(4096),
    facts: { styledSegments: [{ fontName: { family }, fontSize: 16 }] } });
  const second = node("second");
  const root = node("root", { intent: { backdrop: { rgbHex } } });
  const ids = [root, first, second].reduce((sum, entry) =>
    sum + Buffer.byteLength(entry.id) + Buffer.byteLength(entry.sourceRef), 0);
  const limit = 8 * 1024 * 1024;
  const stringBytes = Buffer.byteLength((first.text ?? "") + family + rgbHex);
  const boundary = "x".repeat(limit - ids - stringBytes);
  /** @param {string} text */
  const tree = (text) => ({ ...root, children: [first, { ...second, text }] });
  const result = render([tree(boundary)]);
  assert.ok(result.files.get("index.html")?.includes(Buffer.from(boundary)));
  const css = content(result.files, "styles.css");
  assert.match(css, /font-family:"Fónt"/u);
  assert.match(css, /--aik-backdrop:#123456/u);
  refuses(() => render([tree(boundary + "x")]), "INPUT_LIMIT_EXCEEDED", "second");
});

void test("site-v1 shares the collection limit across assets and render facts", () => {
  /** @type {AssetRef} */
  const asset = { path: "assets/unused.png", sha256: hash(png), mediaType: "image/png" };
  const fills = Array.from({ length: 31_999 }, () => ({ visible: false }));
  const root = node("collection", { facts: { fills } });
  assert.match(content(render([root], "plain", [asset]).files, "index.html"), /data-node="collection"/u);
  root.facts = { fills, strokes: [{ visible: false }] };
  refuses(() => render([root], "plain", [asset]), "INPUT_LIMIT_EXCEEDED", "collection");
  const assets = Array.from({ length: 32_001 }, () => asset);
  assert.throws(() => render([node("root")], "plain", assets), (error) => error instanceof CompilerError &&
    error.diagnostic.code === "INPUT_LIMIT_EXCEEDED" && error.diagnostic.sourceRef === null);
});

void test("site-v1 owns the bytes of its validated raster output", () => {
  const path = "assets/image.png";
  /** @type {AssetRef} */
  const asset = { path, sha256: hash(png), mediaType: "image/png" };
  const image = node("image", { kind: "rectangle", asset: path, intent: { "image-alt": "Winter" } });
  const input = Buffer.from(png);
  const { files } = htmlTarget.render({ schemaVersion: "aik.ui-document.v1", roots: [node("root", { children: [image] })],
    assets: [asset] }, new Map([[path, input]]), { profile: "site-v1", naming: "plain" });
  const output = files.find((file) => file.path === path)?.bytes;
  assert.deepEqual(output, png);
  input.fill(0);
  assert.deepEqual(output, png);
  assert.equal(hash(output), asset.sha256);
});

void test("site-v1 validates raster paths before indexing declarations or node lookups", () => {
  const path = ["assets", "a".repeat(200), "b".repeat(200), "c".repeat(99) + ".png"].join("/");
  assert.equal(path.length, 512);
  /** @type {AssetRef} */
  const asset = { path, sha256: hash(png), mediaType: "image/png" };
  const image = node("image", { kind: "rectangle", asset: path, intent: { "image-alt": "Winter" } });
  assert.deepEqual(render([image], "plain", [asset], new Map([[path, png]])).files.get(path), png);
  const oversizedPath = path + "x";
  const oversizedAsset = { ...asset, path: oversizedPath };
  const oversizedImage = { ...image, asset: oversizedPath };
  assert.throws(() => render([node("root")], "plain", [oversizedAsset]), (error) => error instanceof CompilerError &&
    error.diagnostic.code === "UNSUPPORTED_ASSET" && error.diagnostic.sourceRef === null);
  refuses(() => render([oversizedImage], "plain", [oversizedAsset], new Map([[oversizedPath, png]])), "UNSUPPORTED_ASSET", "image");
  refuses(() => render([oversizedImage]), "UNSUPPORTED_ASSET", "image");
});

void test("site-v1 rejects conflicting asset declarations in either order", () => {
  const path = "assets/image.png";
  /** @type {AssetRef} */
  const asset = { path, sha256: hash(png), mediaType: "image/png" };
  /** @type {AssetRef[]} */
  const conflicts = [{ ...asset, sha256: "0".repeat(64) }, { ...asset, mediaType: "image/jpeg" }];
  const image = node("image", { kind: "rectangle", asset: path, intent: { "image-alt": "Winter" } });
  const bytes = new Map([[path, png]]);
  assert.deepEqual(render([image], "plain", [asset, { ...asset }], bytes).files.get(path), png);
  for (const conflict of conflicts) {
    for (const declarations of [[asset, conflict], [conflict, asset]]) {
      assert.throws(() => render([image], "plain", declarations, bytes), (error) => error instanceof CompilerError &&
        error.diagnostic.code === "INVALID_UI_DOCUMENT" && error.diagnostic.sourceRef === null);
    }
  }
});

void test("site-v1 accepts an anchor-only raster landmark and rejects an extra property", () => {
  const path = "assets/image.png";
  /** @type {AssetRef} */
  const asset = { path, sha256: hash(png), mediaType: "image/png" };
  const landmark = { anchorId: "winter" };
  const image = node("image", { kind: "rectangle", asset: path, intent: { "image-alt": "Winter", landmark } });
  const bytes = new Map([[path, png]]);
  assert.match(content(render([image], "plain", [asset], bytes).files, "index.html"), /id="winter"/u);
  const invalid = { ...image, intent: { ...image.intent, landmark: { ...landmark, unexpected: true } } };
  refuses(() => render([invalid], "plain", [asset], bytes), "INVALID_OVERLAY", "image");
});

void test("site-v1 rejects sparse root and child arrays at their first missing slot", () => {
  for (const missing of [0, 1]) {
    const siblings = [node("one"), node("two"), node("three")];
    assert.ok(Reflect.deleteProperty(siblings, missing));
    assert.throws(() => render(siblings), (error) => error instanceof CompilerError &&
      error.diagnostic.code === "INVALID_UI_DOCUMENT" && error.diagnostic.sourceRef === null);
    refuses(() => render([node("parent", { children: siblings })]), "INVALID_UI_DOCUMENT", "parent");
  }
});

void test("site-v1 rejects sparse asset reference arrays at their first missing slot", () => {
  /** @type {AssetRef} */
  const asset = { path: "assets/image.png", sha256: hash(png), mediaType: "image/png" };
  const image = node("image", { kind: "rectangle", asset: asset.path, intent: { "image-alt": "Winter" } });
  const bytes = new Map([[asset.path, png]]);
  const dense = [asset, { ...asset }, { ...asset }];
  assert.deepEqual(render([image], "plain", dense, bytes).files.get(asset.path), png);
  for (const missing of [0, 1]) {
    const sparse = [...dense];
    assert.ok(Reflect.deleteProperty(sparse, missing));
    assert.throws(() => render([image], "plain", sparse, bytes), (error) => error instanceof CompilerError &&
      error.diagnostic.code === "INVALID_UI_DOCUMENT" && error.diagnostic.sourceRef === null);
  }
});
