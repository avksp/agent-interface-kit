import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { zipSync } from "fflate";
import type { JsonObject, JsonValue } from "../../../packages/compile-core/src/contracts.ts";
import {
  canonical, id, limits, record, requireValue, utf8Length, validString, validatePng,
} from "./contract.ts";
import type { Capture } from "./contract.ts";

type ReadState = { remaining: number; text: number; seen: Set<string>; imageTarget?: string; assetPath?: string };

function fact(value: unknown, depth: number): value is JsonValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return validString(value, limits.name);
  if (depth === 0) return false;
  if (Array.isArray(value)) return value.length === 1 && fact(value[0], depth - 1);
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= 20 && keys.every((key) => /^[a-zA-Z]{1,32}$/u.test(key) && fact(value[key], depth - 1));
}

function readNode(value: unknown, depth: number, state: ReadState): JsonObject {
  requireValue(depth <= limits.depth && --state.remaining >= 0, "LIMIT");
  requireValue(record(value), "CAPTURE");
  const { id: nodeId, sourceRef, kind, text, children, facts } = value;
  requireValue(id(nodeId) && sourceRef === nodeId && !state.seen.has(nodeId) &&
    (kind === "frame" || kind === "text" || kind === "rectangle") && (depth !== 1 || kind === "frame") &&
    Array.isArray(children) && (kind === "frame" || children.length === 0) &&
    record(facts) && fact(facts, 6), "CAPTURE");
  requireValue(children.length <= state.remaining, "LIMIT");
  state.seen.add(nodeId);
  if (kind === "text") {
    requireValue(validString(text, state.text) && text.length > 0, "CAPTURE");
    state.text -= text.length;
  } else {
    requireValue(text === undefined, "CAPTURE");
  }
  const isImage = state.imageTarget === nodeId;
  requireValue(!isImage || (kind === "rectangle" && state.assetPath !== undefined), "CAPTURE");
  return {
    id: nodeId, kind, sourceRef, facts,
    children: children.map((child: unknown) => readNode(child, depth + 1, state)),
    ...(text === undefined ? {} : { text }),
    ...(isImage && state.assetPath !== undefined ? { asset: state.assetPath } : {}),
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
    validatePng(image.png, image.width, image.height);
    const digest = bytesToHex(sha256(image.png));
    const path = "assets/" + digest + ".png";
    state.imageTarget = image.nodeId;
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
