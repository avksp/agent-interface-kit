import { CompilerError } from "../../compile-core/src/contracts.ts";
import type { JsonObject, JsonValue, UiNode } from "../../compile-core/src/contracts.ts";

export function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function decimal(value: number): string {
  return String(Math.round(value * 1_000_000) / 1_000_000);
}

export function dimension(value: JsonValue | undefined, node: UiNode): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new CompilerError("UNSUPPORTED_LAYOUT", node.sourceRef);
  }
  return value;
}

function px(value: number): string {
  return decimal(value) + "px";
}

function firstPaint(value: JsonValue | undefined, node: UiNode): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new CompilerError("UNSUPPORTED_PAINT", node.sourceRef);
  let visible: JsonObject | undefined;
  for (const entry of value) {
    const paint = object(entry);
    if (paint?.["visible"] === false) continue;
    if (!paint || visible) throw new CompilerError("UNSUPPORTED_PAINT", node.sourceRef);
    visible = paint;
  }
  return visible;
}

function channel(value: JsonValue | undefined, node: UiNode): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new CompilerError("UNSUPPORTED_PAINT", node.sourceRef);
  }
  return value;
}

function solid(paint: JsonObject, node: UiNode): string {
  const color = object(paint["color"]);
  if (paint["type"] !== "SOLID" || !color || (paint["blendMode"] ?? "NORMAL") !== "NORMAL") {
    throw new CompilerError("UNSUPPORTED_PAINT", node.sourceRef);
  }
  const rgb = ["r", "g", "b"].map((key) => Math.round(channel(color[key], node) * 255));
  const alpha = channel(paint["opacity"] ?? 1, node) * channel(color["a"] ?? 1, node);
  return "rgb(" + rgb.join(" ") + " / " + decimal(alpha) + ")";
}

function typography(node: UiNode): string[] {
  const facts = node.facts ?? {};
  const segments = facts["styledSegments"];
  if (segments === undefined) return [];
  if (!Array.isArray(segments) || segments.length !== 1 || facts["hasMissingFont"] === true) {
    throw new CompilerError("UNSUPPORTED_TYPOGRAPHY", node.sourceRef);
  }
  const style = object(segments[0]);
  const font = object(style?.["fontName"]);
  const family = font?.["family"];
  const fontSize = dimension(style?.["fontSize"], node);
  if (!style || typeof family !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(family) || !fontSize) {
    throw new CompilerError("UNSUPPORTED_TYPOGRAPHY", node.sourceRef);
  }
  const declarations = ['font-family:"' + family + '",sans-serif', "font-size:" + decimal(fontSize / 16) + "rem"];
  const weight = dimension(object(font?.["variationSettings"])?.["wght"], node);
  if (weight !== undefined) {
    if (weight < 1 || weight > 1000) throw new CompilerError("UNSUPPORTED_TYPOGRAPHY", node.sourceRef);
    declarations.push("font-weight:" + decimal(weight));
  }
  const height = object(style["lineHeight"]);
  const lineHeight = dimension(height?.["value"], node);
  if (lineHeight !== undefined) {
    if (height?.["unit"] === "PIXELS") declarations.push("line-height:" + String(lineHeight / fontSize));
    else if (height?.["unit"] === "PERCENT") declarations.push("line-height:" + decimal(lineHeight / 100));
    else throw new CompilerError("UNSUPPORTED_TYPOGRAPHY", node.sourceRef);
  }
  const spacing = object(style["letterSpacing"]);
  const letterSpacing = spacing?.["value"];
  if (letterSpacing !== undefined && letterSpacing !== 0) {
    if (typeof letterSpacing !== "number" || !Number.isFinite(letterSpacing) || Math.abs(letterSpacing) > 1000) {
      throw new CompilerError("UNSUPPORTED_TYPOGRAPHY", node.sourceRef);
    }
    if (spacing?.["unit"] === "PIXELS") declarations.push("letter-spacing:" + decimal(letterSpacing / fontSize) + "em");
    else if (spacing?.["unit"] === "PERCENT") declarations.push("letter-spacing:" + decimal(letterSpacing / 100) + "em");
    else throw new CompilerError("UNSUPPORTED_TYPOGRAPHY", node.sourceRef);
  }
  const paint = firstPaint(style["fills"] ?? facts["fills"], node);
  if (paint) declarations.push("color:" + solid(paint, node));
  const alignment = facts["textAlignHorizontal"];
  if (alignment === "CENTER") declarations.push("text-align:center");
  if (alignment === "RIGHT") declarations.push("text-align:right");
  if (alignment === "JUSTIFIED") declarations.push("text-align:justify");
  const text = node.text ?? "";
  declarations.push(/(?:[\t ]{2}|(?:^|\n)[\t ]|[\t ](?:\n|$)|\t)/u.test(text) ?
    "white-space:pre-wrap" : "white-space:pre-line");
  return declarations;
}

const alignments = new Map<JsonValue, string>([
  ["MIN", "flex-start"], ["CENTER", "center"], ["MAX", "flex-end"],
  ["SPACE_BETWEEN", "space-between"], ["BASELINE", "baseline"],
]);

function stack(node: UiNode, facts: JsonObject): string[] {
  const mode = facts["layoutMode"];
  if (mode === undefined || mode === "NONE") return [];
  if (mode !== "HORIZONTAL" && mode !== "VERTICAL") {
    throw new CompilerError("UNSUPPORTED_LAYOUT", node.sourceRef);
  }
  const primary = alignments.get(facts["primaryAxisAlignItems"] ?? "MIN");
  const cross = alignments.get(facts["counterAxisAlignItems"] ?? "MIN");
  if (!primary || !cross) throw new CompilerError("UNSUPPORTED_LAYOUT", node.sourceRef);
  // A single start-aligned text block can use the full line box without a flex wrapper.
  if (node.children.length === 1 && node.children[0]?.text !== undefined &&
      primary === "flex-start" && cross === "flex-start" &&
      facts["layoutWrap"] !== "WRAP" && node.intent["responsive-stack"] === undefined) return [];
  const result = ["display:flex", "flex-direction:" + (mode === "HORIZONTAL" ? "row" : "column")];
  const align = node.intent["responsive-stack"] === undefined ? cross : "stretch";
  result.push("justify-content:" + primary, "align-items:" + align);
  const gap = px(dimension(facts["itemSpacing"], node) ?? 0);
  if (facts["layoutWrap"] === "WRAP") {
    result.push("flex-wrap:wrap", "gap:" + px(dimension(facts["counterAxisSpacing"], node) ?? 0) + " " + gap);
  } else result.push("gap:" + gap);
  return result;
}

function strokeWidth(node: UiNode, facts: JsonObject): { property: string; width: number } {
  if (object(facts["strokeWeight"])?.["kind"] === "FIGMA_MIXED") {
    // A horizontal stack with flush children can expose the bottom inset in its captured bounds.
    const height = dimension(facts["height"], node);
    const childHeights = node.children.map((child) => dimension(child.facts?.["height"], child));
    if (facts["layoutMode"] !== "HORIZONTAL" || facts["strokeAlign"] !== "INSIDE" || height === undefined ||
        node.children.length === 0 || (facts["paddingBottom"] ?? 0) !== 0 ||
        node.children.some((child) => child.facts?.["y"] !== 0) ||
        !childHeights.every((childHeight) => childHeight === height - 1)) {
      throw new CompilerError("UNSUPPORTED_PAINT", node.sourceRef);
    }
    return { property: "border-bottom", width: 1 };
  }
  return { property: "border", width: dimension(facts["strokeWeight"], node) ?? 1 };
}

export function layout(node: UiNode, selector: string, root: boolean, raster: boolean): string[] {
  const facts = node.facts ?? {};
  if (facts["layoutPositioning"] === "ABSOLUTE" || (facts["rotation"] ?? 0) !== 0) {
    throw new CompilerError("UNSUPPORTED_LAYOUT", node.sourceRef);
  }
  const declarations = stack(node, facts);
  if (node.text !== undefined) declarations.push(...typography(node));
  const width = dimension(facts["width"], node);
  const height = dimension(facts["height"], node);
  const horizontal = facts["layoutSizingHorizontal"];
  const vertical = facts["layoutSizingVertical"];
  if (width !== undefined && (root || raster || horizontal === "FIXED")) {
    declarations.push("width:min(" + px(width) + ",100%)");
  }
  if (horizontal === "FILL" || facts["layoutAlign"] === "STRETCH") declarations.push("align-self:stretch");
  if (horizontal === "FILL") declarations.push("width:100%");
  if (vertical === "FIXED" && height !== undefined && !raster) declarations.push("min-height:" + px(height));
  const grow = dimension(facts["layoutGrow"], node);
  if (grow) declarations.push("flex-grow:" + decimal(grow));
  const padding = ["Top", "Right", "Bottom", "Left"].map((edge) => dimension(facts["padding" + edge], node) ?? 0);
  if (padding.some(Boolean)) declarations.push("padding:" + padding.map(px).join(" "));
  if (raster) {
    declarations.push("display:block", "height:auto", "object-fit:cover");
    if (width && height) declarations.push("aspect-ratio:" + decimal(width) + " / " + decimal(height));
  } else if (node.text === undefined) {
    const fill = firstPaint(facts["fills"], node);
    if (fill) declarations.push("background:" + solid(fill, node));
  }
  const backdrop = node.intent["backdrop"];
  if (backdrop !== undefined) {
    const color = object(backdrop)?.["rgbHex"];
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/iu.test(color)) {
      throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
    }
    declarations.push("--aik-backdrop:" + color.toLowerCase(), "background:var(--aik-backdrop)");
  }
  const opacity = facts["opacity"];
  if (opacity !== undefined && opacity !== 1) declarations.push("opacity:" + decimal(channel(opacity, node)));
  const stroke = raster ? undefined : firstPaint(facts["strokes"], node);
  if (stroke) {
    const { property, width: weight } = strokeWidth(node, facts);
    declarations.push(property + ":" + px(weight) + " solid " + solid(stroke, node));
  }
  const radius = dimension(facts["cornerRadius"], node);
  if (radius) declarations.push("border-radius:" + px(radius));
  const rules = declarations.length ? [selector + "{" + declarations.join(";") + "}"] : [];
  const responsive = node.intent["responsive-stack"];
  if (responsive !== undefined) {
    const mode = object(responsive);
    const breakpoint = dimension(mode?.["belowCssPx"], node);
    if (!breakpoint || mode?.["direction"] !== "column" || facts["layoutMode"] !== "HORIZONTAL") {
      throw new CompilerError("INVALID_OVERLAY", node.sourceRef);
    }
    rules.push("@media (width < " + px(breakpoint) + "){" + selector + "{flex-direction:column}" +
      selector + ">[data-node]{width:100%}}");
  }
  return rules;
}

export const baseCss = [
  "*{box-sizing:border-box;min-width:0}",
  "body{margin:0;font-family:sans-serif;overflow-wrap:anywhere}",
  "h1,h2,h3,h4,h5,h6,p{margin:0;font:inherit}",
  "a{color:inherit;text-decoration:underline}",
  ":focus-visible{outline:2px solid currentColor;outline-offset:2px}",
];
