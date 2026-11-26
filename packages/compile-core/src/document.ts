import { validatedRasterType } from "./raster.ts";
import { CompilerError } from "./contracts.ts";
import type { DesignNode, JsonObject, JsonValue, Overlay, OverlayRule, Snapshot, UiDocument, UiNode } from "./contracts.ts";
import { ASSET_LIMIT, DEPTH_LIMIT, NODE_LIMIT, TOTAL_ASSET_LIMIT, canonicalJson, checkDistinctPaths, compareText, hash, isUiDocument } from "./json.ts";

function indexNodes(roots: readonly DesignNode[]): Map<string, DesignNode> {
  const indexed = new Map<string, DesignNode>();
  function visit(node: DesignNode, depth: number): void {
    if (depth > DEPTH_LIMIT || indexed.size >= NODE_LIMIT) {
      throw new CompilerError("INPUT_LIMIT_EXCEEDED", node.sourceRef);
    }
    if (indexed.has(node.id)) throw new CompilerError("INVALID_SNAPSHOT", node.sourceRef);
    indexed.set(node.id, node);
    for (const child of node.children) visit(child, depth + 1);
  }
  for (const root of roots) visit(root, 1);
  return indexed;
}

export function validateSnapshot(snapshot: Snapshot): void {
  checkDistinctPaths(snapshot.assets.map(({ path }) => path), "INVALID_SNAPSHOT");
  const assets = new Set(snapshot.assets.map(({ path }) => path));
  for (const node of indexNodes(snapshot.roots).values()) {
    if (node.asset !== undefined && !assets.has(node.asset)) {
      throw new CompilerError("MISSING_DEPENDENCY", node.sourceRef);
    }
  }
}

function mapIntent(roots: readonly DesignNode[], overlay: Overlay): Map<string, JsonObject> {
  const nodes = indexNodes(roots);
  const groups = new Map<string, Map<string, OverlayRule[]>>();
  const ids = new Set<string>();
  for (const rule of overlay.rules.toSorted((a, b) => compareText(a.id, b.id))) {
    const node = nodes.get(rule.nodeId);
    if (!node || ids.has(rule.id)) throw new CompilerError("INVALID_OVERLAY", node?.sourceRef ?? rule.nodeId);
    ids.add(rule.id);
    const properties = groups.get(node.id) ?? new Map<string, OverlayRule[]>();
    groups.set(node.id, properties);
    const rules = properties.get(rule.property) ?? [];
    properties.set(rule.property, rules);
    rules.push(rule);
  }
  const resolved = new Map<string, JsonObject>();
  for (const [id, node] of nodes) {
    const intent: JsonObject = {};
    const properties = groups.get(id);
    if (properties) {
      for (const key of [...properties.keys()].toSorted(compareText)) {
        const rules = properties.get(key) ?? [];
        const top = rules.reduce<OverlayRule | undefined>(
          (best, rule) => !best || rule.precedence > best.precedence ? rule : best, undefined);
        if (!top) continue;
        const value = canonicalJson(top.value);
        if (rules.some((rule) => rule.precedence === top.precedence && canonicalJson(rule.value) !== value)) {
          throw new CompilerError("CONFLICTING_INTENT", node.sourceRef);
        }
        Object.defineProperty(intent, key, { value: top.value, enumerable: true });
      }
    }
    resolved.set(id, intent);
  }
  return resolved;
}

function orderedChildren(node: DesignNode, order: JsonValue | undefined): readonly DesignNode[] {
  if (order === undefined) return node.children;
  if (!Array.isArray(order) || order.length !== node.children.length) {
    throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
  }
  const remaining = new Map(node.children.map((child) => [child.id, child]));
  return order.map((id) => {
    if (typeof id !== "string") throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
    const next = remaining.get(id);
    if (!next) throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
    remaining.delete(id);
    return next;
  });
}

export function buildDocument(snapshot: Snapshot, roots: readonly DesignNode[], overlay: Overlay): UiDocument {
  if (overlay.sourceClosureSha256 !== undefined && overlay.sourceClosureSha256 !== snapshot.source.closureSha256) {
    throw new CompilerError("INVALID_OVERLAY");
  }
  const intent = mapIntent(roots, overlay);
  function buildNode(node: DesignNode): UiNode {
    const rules = intent.get(node.id) ?? {};
    return {
      ...node,
      intent: rules,
      children: orderedChildren(node, rules["reading-order"]).map(buildNode),
    };
  }
  const document: UiDocument = {
    schemaVersion: "aik.ui-document.v1",
    roots: roots.map(buildNode),
    assets: snapshot.assets.toSorted((a, b) => compareText(a.path, b.path)),
  };
  if (!isUiDocument(document)) throw new CompilerError("INVALID_UI_DOCUMENT");
  return document;
}

export function validateAssets(snapshot: Snapshot, data: ReadonlyMap<string, Uint8Array>): void {
  const references = new Map<string, string>();
  for (const node of indexNodes(snapshot.roots).values()) {
    if (node.asset !== undefined && !references.has(node.asset)) references.set(node.asset, node.sourceRef);
  }
  let total = 0;
  for (const asset of snapshot.assets) {
    const sourceRef = references.get(asset.path) ?? null;
    const bytes = data.get(asset.path);
    if (!bytes) throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
    total += bytes.byteLength;
    if (bytes.byteLength > ASSET_LIMIT || total > TOTAL_ASSET_LIMIT) {
      throw new CompilerError("INPUT_LIMIT_EXCEEDED", sourceRef);
    }
    if (hash(bytes) !== asset.sha256) throw new CompilerError("INPUT_DIGEST_MISMATCH", sourceRef);
    if (validatedRasterType(bytes) !== asset.mediaType) throw new CompilerError("ASSET_TYPE_MISMATCH", sourceRef);
  }
}
