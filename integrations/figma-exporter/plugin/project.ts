import type { JsonObject } from "../../../packages/compile-core/src/contracts.ts";
import { canonical, id, limits, pngSide, requireValue, utf8Length, validString } from "../src/contract.ts";
import type { IssueCode } from "../src/contract.ts";

type Supported = FrameNode | TextNode | RectangleNode;
type ImageRect = { node: RectangleNode; width: number; height: number; paint: JsonObject };
type Walk = { remaining: number; text: number; seen: Set<string>; image?: ImageRect };
type Projection = { pageId: string; document: string; image?: ImageRect };
type Host = Pick<PluginAPI, "currentPage">;

function quantity(value: number, minimum = 0, maximum = 4096): number {
  requireValue(Number.isFinite(value) && value >= minimum && value <= maximum, "LIMIT");
  return value;
}

function noBindings(value: object | undefined): boolean {
  return value === undefined || Object.keys(value).length === 0;
}

function bounds(node: Supported): JsonObject {
  requireValue(node.width > 0 && node.height > 0, "UNSUPPORTED");
  return { width: quantity(node.width), height: quantity(node.height) };
}

function common(node: Supported, depth: number): void {
  requireValue(node.opacity === 1 && node.rotation === 0 && !node.isMask &&
    (node.blendMode === "NORMAL" || (node.type === "FRAME" && node.blendMode === "PASS_THROUGH")) &&
    node.effects.length === 0 && node.strokes.length === 0 && node.reactions.length === 0 &&
    node.effectStyleId === "" && node.fillStyleId === "" && node.strokeStyleId === "" &&
    noBindings(node.boundVariables) && node.minWidth === null && node.minHeight === null &&
    node.maxWidth === null && node.maxHeight === null, "UNSUPPORTED");
  if (depth > 1) {
    requireValue(node.layoutPositioning === "AUTO" && node.layoutAlign === "INHERIT" && node.layoutGrow === 0, "UNSUPPORTED");
  }
}

function paintFor(node: Supported, emptyAllowed: boolean): SolidPaint | ImagePaint | undefined {
  const paints = node.fills;
  requireValue(typeof paints !== "symbol" && paints.length <= 1, "UNSUPPORTED");
  const paint = paints[0];
  if (paint === undefined && emptyAllowed) return undefined;
  requireValue(paint && (paint.type === "SOLID" || paint.type === "IMAGE") && (paint.visible ?? true) &&
    (paint.blendMode ?? "NORMAL") === "NORMAL" && (paint.opacity ?? 1) === 1, "UNSUPPORTED");
  return paint;
}

function solid(paint: SolidPaint): JsonObject {
  requireValue(noBindings(paint.boundVariables) && paint.color.sourceColor === undefined, "UNSUPPORTED");
  const { r, g, b } = paint.color;
  return { type: "SOLID", color: { r: quantity(r, 0, 1), g: quantity(g, 0, 1), b: quantity(b, 0, 1) } };
}

function frameFacts(node: FrameNode): JsonObject {
  const {
    layoutMode, layoutWrap, layoutSizingHorizontal, layoutSizingVertical, primaryAxisAlignItems, counterAxisAlignItems,
    paddingTop, paddingRight, paddingBottom, paddingLeft, itemSpacing,
  } = node;
  requireValue((layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL") && layoutWrap === "NO_WRAP" &&
    !node.clipsContent && !node.strokesIncludedInLayout && !node.itemReverseZIndex && node.cornerRadius === 0 &&
    (layoutSizingHorizontal === "FIXED" || layoutSizingHorizontal === "HUG") &&
    (layoutSizingVertical === "FIXED" || layoutSizingVertical === "HUG") &&
    (primaryAxisAlignItems === "MIN" || primaryAxisAlignItems === "CENTER" || primaryAxisAlignItems === "MAX") &&
    (counterAxisAlignItems === "MIN" || counterAxisAlignItems === "CENTER" || counterAxisAlignItems === "MAX"), "UNSUPPORTED");
  const fill = paintFor(node, true);
  requireValue(!fill || fill.type === "SOLID", "UNSUPPORTED");
  return {
    ...bounds(node), name: node.name, layoutMode, layoutSizingHorizontal, layoutSizingVertical,
    primaryAxisAlignItems, counterAxisAlignItems, itemSpacing: quantity(itemSpacing),
    paddingTop: quantity(paddingTop), paddingRight: quantity(paddingRight), paddingBottom: quantity(paddingBottom),
    paddingLeft: quantity(paddingLeft), ...(fill?.type === "SOLID" ? { fills: [solid(fill)] } : {}),
  };
}

const axisDefaults = new Map<string, number>([["wght", 400], ["wdth", 100], ["slnt", 0], ["ital", 0]]);
function textFacts(node: TextNode, text: string): JsonObject {
  const { fontName, fontSize, letterSpacing, lineHeight } = node;
  requireValue(typeof fontName !== "symbol" && fontName.style === "Regular" &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(fontName.family) &&
    Object.entries(fontName.variationSettings ?? {}).every(([axis, value]) => axisDefaults.get(axis) === value) &&
    typeof fontSize === "number" && typeof lineHeight !== "symbol" && lineHeight.unit === "AUTO" &&
    typeof letterSpacing !== "symbol" && letterSpacing.value === 0 &&
    !node.hasMissingFont && node.leadingTrim === "NONE" && node.textStyleId === "" &&
    node.textDecoration === "NONE" && node.textCase === "ORIGINAL" && node.hyperlink === null &&
    node.textAlignHorizontal === "LEFT" && node.textAlignVertical === "TOP" &&
    node.textAutoResize === "WIDTH_AND_HEIGHT" && node.textTruncation === "DISABLED" &&
    node.paragraphIndent === 0 && node.paragraphSpacing === 0, "UNSUPPORTED");
  const list = node.getRangeListOptions(0, text.length);
  requireValue(typeof list !== "symbol" && list.type === "NONE", "UNSUPPORTED");
  const paint = paintFor(node, false);
  requireValue(paint?.type === "SOLID", "UNSUPPORTED");
  return {
    styledSegments: [{
      fontName: { family: fontName.family }, fontSize: quantity(fontSize, 1, 128), fills: [solid(paint)],
    }],
  };
}

function fingerprint(paint: ImagePaint): JsonObject {
  const { imageHash, imageTransform, filters } = paint;
  requireValue(validString(imageHash, limits.imageHash) && imageHash.length > 0, "LIMIT");
  requireValue(paint.scaleMode === "FILL" && (paint.rotation ?? 0) === 0 && (paint.scalingFactor ?? 1) === 1 &&
    (imageTransform === undefined || (imageTransform[0][0] === 1 && imageTransform[0][1] === 0 &&
      imageTransform[0][2] === 0 && imageTransform[1][0] === 0 && imageTransform[1][1] === 1 &&
      imageTransform[1][2] === 0)) &&
    Object.values(filters ?? {}).every((value) => value === 0), "UNSUPPORTED");
  return {
    imageHash, scaleMode: paint.scaleMode, imageTransform: imageTransform?.map((row) => [...row]) ?? null,
    opacity: paint.opacity ?? null, blendMode: paint.blendMode ?? null, visible: paint.visible ?? null,
    rotation: paint.rotation ?? null, scalingFactor: paint.scalingFactor ?? null,
    filters: filters ? { ...filters } : null,
  };
}

function rectangleFacts(node: RectangleNode, walk: Walk): JsonObject {
  requireValue(node.cornerRadius === 0 &&
    node.layoutSizingHorizontal === "FIXED" && node.layoutSizingVertical === "FIXED", "UNSUPPORTED");
  const facts = bounds(node);
  const paint = paintFor(node, false);
  requireValue(paint !== undefined, "UNSUPPORTED");
  if (paint.type === "SOLID") {
    return { ...facts, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", fills: [solid(paint)] };
  }
  requireValue(walk.image === undefined, "UNSUPPORTED");
  const { width, height } = node;
  requireValue(pngSide(width) && pngSide(height), "LIMIT");
  walk.image = { node, width, height, paint: fingerprint(paint) };
  return facts;
}

function projectNode(node: SceneNode, depth: number, walk: Walk): JsonObject {
  requireValue(depth <= limits.depth, "LIMIT");
  requireValue(node.type === "FRAME" || node.type === "TEXT" || node.type === "RECTANGLE", "UNSUPPORTED");
  requireValue(id(node.id) && validString(node.name, limits.name), "LIMIT");
  requireValue(!walk.seen.has(node.id), "UNSUPPORTED");
  walk.seen.add(node.id);
  common(node, depth);
  const base = { id: node.id, sourceRef: node.id };
  if (node.type === "TEXT") {
    const text = node.characters;
    requireValue(text.length > 0 && validString(text, walk.text), "LIMIT");
    walk.text -= text.length;
    return { ...base, kind: "text", children: [], text, facts: textFacts(node, text) };
  }
  if (node.type === "RECTANGLE") {
    return { ...base, kind: "rectangle", children: [], facts: rectangleFacts(node, walk) };
  }
  const facts = frameFacts(node);
  const children = node.children;
  requireValue(children.length <= walk.remaining, "LIMIT");
  walk.remaining -= children.length;
  const included: JsonObject[] = [];
  for (const child of children) {
    if (child.visible) included.push(projectNode(child, depth + 1, walk));
  }
  return { ...base, kind: "frame", children: included, facts };
}

export function project(host: Host, issue: IssueCode = "SELECTION"): Projection {
  const page = host.currentPage;
  const selection = page.selection;
  requireValue(selection.length === 1, issue);
  const root = selection[0];
  requireValue(root?.type === "FRAME" && root.visible && root.parent?.id === page.id && id(page.id), issue);
  const walk: Walk = { remaining: limits.nodes - 1, text: limits.text, seen: new Set() };
  const document = canonical(projectNode(root, 1, walk));
  requireValue(utf8Length(document) <= limits.metadata, "LIMIT");
  return walk.image ? { pageId: page.id, document, image: walk.image } : { pageId: page.id, document };
}
