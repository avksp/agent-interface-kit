import { ASSET_LIMIT, JSON_LIMIT, TOTAL_ASSET_LIMIT, checkedPath, checkDistinctPaths, CompilerError, hash } from "../../compile-core/src/index.ts";
import type { AssetRef, BuildOptions, Diagnostic, JsonObject, OutputTarget, UiDocument, UiNode, VirtualFile } from "../../compile-core/src/contracts.ts";
import { DEPTH_LIMIT, NODE_LIMIT } from "../../compile-core/src/json.ts";
import { validatedRasterType } from "../../compile-core/src/raster.ts";
import { baseCss, dimension, layout, object } from "./styles.ts";

interface NodePlacement {
  page: string;
  className: string;
  anchor: string | undefined;
}

interface RenderContext {
  placements: ReadonlyMap<string, NodePlacement>;
  anchors: ReadonlyMap<string, string>;
  pages: ReadonlySet<string>;
  assets: ReadonlyMap<string, AssetRef>;
  bytes: ReadonlyMap<string, Uint8Array>;
  files: VirtualFile[];
  css: string[];
  diagnostics: Diagnostic[];
  emittedAssets: Set<string>;
  emittedAssetBytes: number;
}

const encoder = new TextEncoder();
const COLLECTION_ENTRY_LIMIT = 32_000;
const passiveTypes = new Map<string, RegExp>([
  ["image/png", /\.png$/iu],
  ["image/jpeg", /\.jpe?g$/iu],
  ["image/webp", /\.webp$/iu],
]);
const semantics = new Set(["main", "header", "footer", "article", "aside", "nav", "section", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "span"]);
const textTags = new Set(["p", "span", "h1", "h2", "h3", "h4", "h5", "h6"]);

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("\0", "\uFFFD");
}

function attribute(name: string, value: string): string {
  return " " + name + '="' + escapeHtml(value) + '"';
}

function pageName(index: number): string {
  return index === 0 ? "index.html" : "case-" + (index + 1) + ".html";
}

function anchorOf(node: UiNode): string | undefined {
  const value = object(node.intent["landmark"])?.["anchorId"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value)) {
    throw new CompilerError("UNSAFE_LINK", node.sourceRef);
  }
  return value;
}

function checkRasterPath(path: string, sourceRef: string | null = null): void {
  if (path.length > 512) throw new CompilerError("UNSUPPORTED_ASSET", sourceRef);
  checkedPath(path, "UNSUPPORTED_ASSET");
}

function indexAssets(references: readonly AssetRef[]): Map<string, AssetRef> {
  const assets = new Map<string, AssetRef>();
  for (let index = 0; index < references.length; index++) {
    const asset = checkedEntryAt(references, index);
    checkRasterPath(asset.path);
    if (asset.mediaType.length > "image/jpeg".length || !passiveTypes.has(asset.mediaType) ||
        asset.sha256.length !== 64 || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
      throw new CompilerError("UNSUPPORTED_ASSET");
    }
    const existing = assets.get(asset.path);
    if (!existing) assets.set(asset.path, asset);
    else if (existing.mediaType !== asset.mediaType || existing.sha256 !== asset.sha256) {
      throw new CompilerError("INVALID_UI_DOCUMENT");
    }
  }
  return assets;
}

function checkedEntryAt<T extends UiNode | AssetRef>(
  entries: readonly T[], index: number, sourceRef: string | null = null,
): T {
  const entry = Object.hasOwn(entries, index) ? entries[index] : undefined;
  if (!entry) throw new CompilerError("INVALID_UI_DOCUMENT", sourceRef);
  return entry;
}

function indexPages(document: UiDocument, naming: BuildOptions["naming"]) {
  let remainingEntries = COLLECTION_ENTRY_LIMIT - document.assets.length;
  if (remainingEntries < 0) throw new CompilerError("INPUT_LIMIT_EXCEEDED");
  const placements = new Map<string, NodePlacement>();
  const anchors = new Map<string, string>();
  const pages = new Set<string>();
  // The snapshot and overlay each have their own JSON input limit.
  let remainingStringBytes = JSON_LIMIT * 2;
  function checkNodeInput(node: UiNode): void {
    if (node.asset !== undefined) checkRasterPath(node.asset, node.sourceRef);
    const facts = node.facts;
    const segments = facts?.["styledSegments"];
    const style = object(Array.isArray(segments) ? segments[0] : undefined);
    for (const list of [facts?.["fills"], facts?.["strokes"], segments, facts?.["reactions"], style?.["fills"]]) {
      if (!Array.isArray(list)) continue;
      remainingEntries -= list.length;
      if (remainingEntries < 0) throw new CompilerError("INPUT_LIMIT_EXCEEDED", node.sourceRef);
    }
    const landmark = object(node.intent["landmark"]);
    const action = object(node.intent["navigation"]);
    const values = [
      node.id, node.sourceRef, node.text, node.asset, node.facts?.["name"], node.intent["title"],
      node.intent["language"], node.intent["image-alt"], node.intent["semantic"], landmark?.["anchorId"],
      landmark?.["accessibleName"], landmark?.["element"], action?.["href"],
      action?.["accessibleName"], action?.["targetNodeId"], action?.["kind"],
      object(style?.["fontName"])?.["family"], object(node.intent["backdrop"])?.["rgbHex"],
    ];
    for (const value of values) {
      if (typeof value !== "string") continue;
      if (value.length > remainingStringBytes) throw new CompilerError("INPUT_LIMIT_EXCEEDED", node.sourceRef);
      remainingStringBytes -= Buffer.byteLength(value, "utf8");
      if (remainingStringBytes < 0) throw new CompilerError("INPUT_LIMIT_EXCEEDED", node.sourceRef);
    }
  }
  for (let index = 0; index < document.roots.length; index++) {
    const root = checkedEntryAt(document.roots, index);
    const page = pageName(index);
    pages.add(page);
    anchors.set(page + "#", root.id);
    let ordinal = 0;
    function visit(node: UiNode, depth: number): void {
      if (depth > DEPTH_LIMIT || placements.size >= NODE_LIMIT) {
        throw new CompilerError("INPUT_LIMIT_EXCEEDED", node.sourceRef);
      }
      checkNodeInput(node);
      const anchor = anchorOf(node);
      const key = page + "#" + (anchor ?? "");
      if (placements.has(node.id) || (anchor && anchors.has(key))) {
        throw new CompilerError("INVALID_UI_DOCUMENT", node.sourceRef);
      }
      const block = "page-" + (index + 1);
      const className = ordinal === 0 ? block : block + (naming === "bem" ? "__node-" : "-node-") + ordinal;
      placements.set(node.id, { page, className, anchor });
      if (anchor) anchors.set(key, node.id);
      ordinal++;
      for (let childIndex = 0; childIndex < node.children.length; childIndex++) {
        visit(checkedEntryAt(node.children, childIndex, node.sourceRef), depth + 1);
      }
    }
    visit(root, 1);
  }
  return { placements, anchors, pages };
}

function requiresAction(node: UiNode): boolean {
  const reactions = node.facts?.["reactions"];
  const segments = node.facts?.["styledSegments"];
  return node.intent["action-required"] === true ||
    (Array.isArray(reactions) && reactions.length > 0) ||
    (Array.isArray(segments) && segments.some((entry) => {
      const hyperlink = object(entry)?.["hyperlink"];
      return hyperlink !== undefined && hyperlink !== null;
    }));
}

function navigation(node: UiNode, context: RenderContext, page: string): { href: string; name: string } | undefined {
  const value = node.intent["navigation"];
  if (value === undefined) {
    if (requiresAction(node)) throw new CompilerError("MISSING_ACTION", node.sourceRef);
    return undefined;
  }
  const action = object(value);
  const raw = action?.["href"];
  const name = action?.["accessibleName"] ?? node.text;
  if (!action || typeof raw !== "string" || typeof name !== "string" || name.trim() === "") {
    throw new CompilerError("MISSING_ACTION", node.sourceRef);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new CompilerError("UNSAFE_LINK", node.sourceRef);
  }
  const match = /^(?:([A-Za-z0-9][A-Za-z0-9_-]*\.html))?(?:#([A-Za-z][A-Za-z0-9_-]{0,79}))?$/u.exec(decoded);
  const destination = match?.[1];
  const anchor = match?.[2];
  const location = destination ?? page;
  const target = context.anchors.get(location + "#" + (anchor ?? ""));
  const targetNode = action["targetNodeId"];
  if ((!destination && !anchor) || !context.pages.has(location) ||
      (anchor !== undefined && target === undefined) || (targetNode !== undefined && targetNode !== target) ||
      action["kind"] !== (destination ? "page" : "fragment")) {
    throw new CompilerError("UNSAFE_LINK", node.sourceRef);
  }
  return { href: (destination ?? "") + (anchor ? "#" + anchor : ""), name };
}

function emitRaster(node: UiNode, context: RenderContext, attrs: string, fallback: boolean): string {
  const path = node.asset;
  const asset = path === undefined ? undefined : context.assets.get(path);
  const bytes = path === undefined ? undefined : context.bytes.get(path);
  if (path === undefined || !asset || !bytes) throw new CompilerError("MISSING_DEPENDENCY", node.sourceRef);
  const extension = passiveTypes.get(asset.mediaType);
  if (!extension || !extension.test(path)) throw new CompilerError("UNSUPPORTED_ASSET", node.sourceRef);
  if (!context.emittedAssets.has(path)) {
    const total = context.emittedAssetBytes + bytes.byteLength;
    if (bytes.byteLength > ASSET_LIMIT || total > TOTAL_ASSET_LIMIT) {
      throw new CompilerError("INPUT_LIMIT_EXCEEDED", node.sourceRef);
    }
    const contents = Buffer.from(bytes);
    if (validatedRasterType(contents) !== asset.mediaType) throw new CompilerError("ASSET_TYPE_MISMATCH", node.sourceRef);
    if (hash(contents) !== asset.sha256) throw new CompilerError("INPUT_DIGEST_MISMATCH", node.sourceRef);
    context.files.push({ path, mediaType: asset.mediaType, bytes: contents });
    context.emittedAssets.add(path);
    context.emittedAssetBytes = total;
  }
  const alt = node.intent["image-alt"];
  if (typeof alt !== "string" || (fallback && alt !== "")) throw new CompilerError("MISSING_IMAGE_ALT", node.sourceRef);
  if (fallback) {
    context.diagnostics.push({ code: "KNOWN_LOSS", severity: "warning", sourceRef: node.sourceRef,
      feature: "visual-fidelity", fallback: "passive-raster" });
  }
  const width = dimension(node.facts?.["width"], node);
  const height = dimension(node.facts?.["height"], node);
  const size = width && height ? attribute("width", String(Math.round(width))) + attribute("height", String(Math.round(height))) : "";
  return "<img" + attrs + attribute("src", path) + attribute("alt", alt) + size + ">";
}

function elementFor(node: UiNode, root: boolean): string {
  const semantic = node.intent["semantic"];
  const landmark = object(node.intent["landmark"]);
  if (node.intent["landmark"] !== undefined && !landmark) throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
  if (landmark && semantic !== undefined && landmark["element"] !== semantic) {
    throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
  }
  const tag = landmark?.["element"] ?? semantic ?? (root ? "main" : node.kind === "text" ? "p" : "div");
  if (typeof tag !== "string" || !semantics.has(tag) ||
      (textTags.has(tag) && node.children.length > 0) || (tag === "main" && !root)) {
    throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
  }
  return tag;
}

function anchorOnlyLandmark(landmark: JsonObject): boolean {
  let hasAnchor = false;
  for (const key in landmark) {
    if (!Object.hasOwn(landmark, key)) continue;
    if (key !== "anchorId") return false;
    hasAnchor = true;
  }
  return hasAnchor;
}

function renderNode(node: UiNode, context: RenderContext, root = false): string {
  const position = context.placements.get(node.id);
  if (!position) throw new CompilerError("INVALID_UI_DOCUMENT", node.sourceRef);
  if (node.facts?.["isMask"] === true) throw new CompilerError("UNSUPPORTED_MASK", node.sourceRef);
  const common = attribute("class", position.className) + attribute("data-node", node.id) +
    (position.anchor ? attribute("id", position.anchor) : "");
  const link = navigation(node, context, position.page);
  const fallback = node.intent["fallback"] === "passive-raster";
  const raster = node.asset !== undefined;
  if ((fallback && (!raster || requiresAction(node))) || (raster && (link || node.children.length || node.text !== undefined))) {
    throw new CompilerError("UNSUPPORTED_ASSET", node.sourceRef);
  }
  if (!fallback && !["frame", "text", "rectangle"].includes(node.kind)) {
    throw new CompilerError("UNSUPPORTED_NODE", node.sourceRef);
  }
  if (raster) {
    const value = node.intent["landmark"];
    const landmark = object(value);
    if (node.intent["semantic"] !== undefined ||
        (value !== undefined && (!landmark || position.anchor === undefined || !anchorOnlyLandmark(landmark)))) {
      throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
    }
  }
  context.css.push(...layout(node, "." + position.className, root, raster));
  if (raster) return emitRaster(node, context, common, fallback);
  const text = escapeHtml(node.text ?? "");
  if (link) {
    if (node.children.length) throw new CompilerError("UNSAFE_LINK", node.sourceRef);
    return "<a" + common + attribute("href", link.href) + attribute("aria-label", link.name) + ">" + text + "</a>";
  }
  const tag = elementFor(node, root);
  const label = object(node.intent["landmark"])?.["accessibleName"];
  if (label !== undefined && (typeof label !== "string" || label.trim() === "")) {
    throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
  }
  const name = typeof label === "string" ? attribute("aria-label", label) : "";
  const children = node.children.map((child) => renderNode(child, context)).join("");
  return "<" + tag + common + name + ">" + text + children + "</" + tag + ">";
}

function textFile(path: string, mediaType: string, text: string): VirtualFile {
  return { path, mediaType, bytes: encoder.encode(text + "\n") };
}

export const htmlTarget: OutputTarget = {
  id: "html",
  version: "0.1.0",
  profile: "site-v1",
  render(document, assets, options) {
    if (options.profile !== this.profile || (options.naming !== "plain" && options.naming !== "bem")) {
      throw new CompilerError("INVALID_ARGUMENTS");
    }
    const context: RenderContext = {
      ...indexPages(document, options.naming),
      assets: indexAssets(document.assets),
      bytes: assets,
      files: [],
      css: [...baseCss],
      diagnostics: [],
      emittedAssets: new Set(),
      emittedAssetBytes: 0,
    };
    for (const [index, root] of document.roots.entries()) {
      const body = renderNode(root, context, true);
      const title = root.intent["title"] ?? root.facts?.["name"];
      const language = root.intent["language"] ?? "und";
      if (typeof language !== "string" || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu.test(language)) {
        throw new CompilerError("INVALID_OVERLAY", root.sourceRef);
      }
      const page = "<!doctype html>\n<html" + attribute("lang", language) + "><head>\n" +
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
        "<title>" + escapeHtml(typeof title === "string" && title.trim() ? title : "Page " + (index + 1)) + "</title>\n" +
        '<link rel="stylesheet" href="styles.css">\n</head><body>\n' + body + "\n</body></html>";
      context.files.push(textFile(pageName(index), "text/html", page));
    }
    context.files.push(textFile("styles.css", "text/css", context.css.join("\n")));
    checkDistinctPaths(context.files.map((file) => file.path), "INVALID_OUTPUT");
    return { files: context.files, diagnostics: context.diagnostics };
  },
};
