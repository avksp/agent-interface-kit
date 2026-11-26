import type { PaintSlot } from "./collector.ts";

interface ScopedFile {
  fileKey: string;
  anchorId: string;
}

type ProbeScope = ScopedFile & (
  | { group: "n"; roots: { N: string } }
  | { group: "ab"; roots: { A: string; B: string }; backdropId: string; paints: readonly PaintSlot[];
      asset: { nodeId: string; fillSlot: number; sourceImageId: string }; link: { nodeId: string; targetId: string } }
);

export function prepareProbe(scope: ProbeScope, body: string): string {
  const { group, fileKey, anchorId, roots } = scope;
  if (!fileKey || !anchorId) throw new TypeError("Probe scope requires a file key and anchor");
  const base = { group, fileKey, anchorId, roots };
  const request = scope.group === "ab" ? {
    ...base,
    asset: {
      nodeId: scope.asset.nodeId, fillSlot: scope.asset.fillSlot, sourceImageId: scope.asset.sourceImageId,
    },
    link: { nodeId: scope.link.nodeId, targetId: scope.link.targetId },
    paints: scope.paints,
    backdropId: scope.backdropId,
  } : base;
  return "const request = " + JSON.stringify(request) + ";\n" + body;
}
