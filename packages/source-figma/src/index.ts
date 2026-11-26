import { CompilerError } from "../../compile-core/src/contracts.ts";
import type { DesignNode, JsonValue, Snapshot, SourceAdapter } from "../../compile-core/src/contracts.ts";

function hasVisibleEffect(effects: JsonValue | undefined, sourceRef: string): boolean {
  if (effects === undefined) return false;
  if (!Array.isArray(effects)) throw new CompilerError("INVALID_SNAPSHOT", sourceRef);
  for (const effect of effects) {
    if (effect === null || typeof effect !== "object" || Array.isArray(effect) ||
        typeof effect["type"] !== "string" || typeof effect["visible"] !== "boolean") {
      throw new CompilerError("INVALID_SNAPSHOT", sourceRef);
    }
    if (effect["visible"]) return true;
  }
  return false;
}

function checkNode(node: DesignNode): void {
  if (hasVisibleEffect(node.facts?.["effects"], node.sourceRef)) {
    throw new CompilerError("UNSUPPORTED_EFFECT", node.sourceRef);
  }
  if (node.facts?.["isMask"] === true) {
    throw new CompilerError("UNSUPPORTED_MASK", node.sourceRef);
  }
  for (const child of node.children) checkNode(child);
}

export const figmaSource: SourceAdapter = {
  id: "figma",
  version: "0.1.0",
  normalize(snapshot: Snapshot): readonly DesignNode[] {
    if (snapshot.source.adapter !== this.id || snapshot.source.version !== this.version) {
      throw new CompilerError("INVALID_SNAPSHOT");
    }
    for (const root of snapshot.roots) checkNode(root);
    return snapshot.roots;
  },
};
