import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { zipSync } from "fflate";
import type { JsonObject, JsonValue } from "../../../packages/compile-core/src/contracts.ts";
import {
  canonical, id, limits, record, requireValue, utf8Length, validString,
} from "./contract.ts";
import type { Capture } from "./contract.ts";
import { validateAsset } from "./png.ts";

type ReadState = { remaining: number; text: number; seen: Set<string>; image?: NonNullable<Capture["image"]>; assetPath?: string };

function between(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key));
}

function solidFills(value: unknown): value is JsonValue {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const paint: unknown = value[0];
  if (!record(paint) || !hasKeys(paint, ["type", "color"]) || paint["type"] !== "SOLID") return false;
  const color = paint["color"];
  return record(color) && hasKeys(color, ["r", "g", "b"]) && ["r", "g", "b"].every((key) => between(color[key], 0, 1));
}

const spacing = ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
const sizing = ["layoutSizingHorizontal", "layoutSizingVertical"] as const;
const alignment = ["primaryAxisAlignItems", "counterAxisAlignItems"] as const;

function frameFacts(facts: Record<string, unknown>): boolean {
  const keys = ["width", "height", "name", "layoutMode", ...sizing, ...alignment, ...spacing];
  if (facts["fills"] !== undefined) {
    if (!solidFills(facts["fills"])) return false;
    keys.push("fills");
  }
  return hasKeys(facts, keys) && validString(facts["name"], limits.name) &&
    (facts["layoutMode"] === "HORIZONTAL" || facts["layoutMode"] === "VERTICAL") &&
    sizing.every((key) => facts[key] === "FIXED" || facts[key] === "HUG") &&
    alignment.every((key) => facts[key] === "MIN" || facts[key] === "CENTER" || facts[key] === "MAX") &&
    spacing.every((key) => between(facts[key], 0, 4096));
}

function textFacts(facts: Record<string, unknown>): boolean {
  const segments = facts["styledSegments"];
  if (!hasKeys(facts, ["styledSegments"]) || !Array.isArray(segments) || segments.length !== 1) return false;
  const segment: unknown = segments[0];
  if (!record(segment) || !hasKeys(segment, ["fontName", "fontSize", "fills"])) return false;
  const font = segment["fontName"];
  return record(font) && hasKeys(font, ["family"]) && typeof font["family"] === "string" &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(font["family"]) &&
    between(segment["fontSize"], 1, 128) && solidFills(segment["fills"]);
}

function permittedFacts(facts: Record<string, unknown>, kind: string, image?: Capture["image"]): facts is JsonObject {
  if (kind === "text") return textFacts(facts);
  const { width, height } = facts;
  if (!between(width, Number.MIN_VALUE, 4096) || !between(height, Number.MIN_VALUE, 4096)) return false;
  if (kind === "frame") return frameFacts(facts);
  if (image) return hasKeys(facts, ["width", "height"]) && width === image.width && height === image.height;
  return hasKeys(facts, ["width", "height", ...sizing, "fills"]) &&
    sizing.every((axis) => facts[axis] === "FIXED") && solidFills(facts["fills"]);
}

function readNode(value: unknown, depth: number, state: ReadState): JsonObject {
  requireValue(depth <= limits.depth && --state.remaining >= 0, "LIMIT");
  requireValue(record(value), "CAPTURE");
  const { id: nodeId, sourceRef, kind, text, children, facts } = value;
  requireValue(id(nodeId) && sourceRef === nodeId && !state.seen.has(nodeId) &&
    (kind === "frame" || kind === "text" || kind === "rectangle") && (depth !== 1 || kind === "frame") &&
    Array.isArray(children) && (kind === "frame" || children.length === 0) &&
    record(facts), "CAPTURE");
  requireValue(children.length <= state.remaining, "LIMIT");
  state.seen.add(nodeId);
  if (kind === "text") {
    requireValue(validString(text, state.text) && text.length > 0, "CAPTURE");
    state.text -= text.length;
  } else {
    requireValue(text === undefined, "CAPTURE");
  }
  const image = state.image?.nodeId === nodeId ? state.image : undefined;
  requireValue((!image || kind === "rectangle") && permittedFacts(facts, kind, image), "CAPTURE");
  return {
    id: nodeId, kind, sourceRef, facts,
    children: children.map((child: unknown) => readNode(child, depth + 1, state)),
    ...(text === undefined ? {} : { text }),
    ...(image && state.assetPath !== undefined ? { asset: state.assetPath } : {}),
  };
}

function jsonFile(value: JsonObject): Uint8Array {
  const text = canonical(value) + "\n";
  requireValue(utf8Length(text) <= limits.metadata, "LIMIT");
  return new TextEncoder().encode(text);
}

export function makeArchive(capture: Capture, alt: string): Uint8Array {
  const { image, document } = capture;
  requireValue(validString(document, limits.metadata) && utf8Length(document) <= limits.metadata, "LIMIT");
  const value: unknown = JSON.parse(document);
  const state: ReadState = { remaining: limits.nodes, text: limits.text, seen: new Set() };
  const files: Record<string, Uint8Array> = {};
  const assets: JsonObject[] = [];
  const rules: JsonObject[] = [];
  if (image) {
    requireValue(validString(alt, limits.alt) && alt.trim() === alt && alt.length > 0, "ALT");
    validateAsset(image.png, image.width, image.height);
    const digest = bytesToHex(sha256(image.png));
    const path = "assets/" + digest + ".png";
    state.image = image;
    state.assetPath = path;
    assets.push({ path, sha256: digest, mediaType: "image/png" });
    rules.push({ id: "image-alt", nodeId: image.nodeId, property: "image-alt", value: alt, precedence: 100 });
    files[path] = image.png;
  }
  const root = readNode(value, 1, state);
  requireValue(!image || state.seen.has(image.nodeId), "CAPTURE");
  // Keys are inserted in ASCII order. All paths use ASCII and STORE has no data expansion.
  files["overlay.json"] = jsonFile({ schemaVersion: "aik.overlay.v1", rules });
  files["snapshot.json"] = jsonFile({
    schemaVersion: "aik.snapshot.v1", source: { adapter: "figma", version: "0.1.0" }, roots: [root], assets,
  });
  const size = Object.entries(files).reduce((sum, [path, data]) => sum + 76 + path.length * 2 + data.byteLength, 22);
  requireValue(size <= limits.archive, "LIMIT");
  // The ZIP library writes local calendar fields. Use the same fields in every timezone.
  const archive = zipSync(files, { level: 0, mtime: new Date(1980, 0, 2) });
  requireValue(archive.byteLength === size, "CAPTURE");
  return archive;
}
