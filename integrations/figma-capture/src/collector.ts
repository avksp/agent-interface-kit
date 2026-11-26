import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CompilerError, hash, isOverlay, isSnapshot, jsonBytes, validateAssets, validateSnapshot,
} from "../../../packages/compile-core/src/index.ts";
import type { DesignNode, JsonObject, JsonValue, Overlay, Snapshot } from "../../../packages/compile-core/src/index.ts";

const PROBE_LIMIT = 65_536;
const ASSET_LIMIT = 2 * 1024 * 1024;
const ORIGIN = "https://www.figma.com";
const IMAGE_PATH = "assets/source.png";

type Group = "ab" | "n";
type Fields = Record<string, unknown>;
export type Asset = { nodeId: string; fillSlot: number; sourceImageId: string; sha256: string; bytes: number };

export type PaintSlot = readonly [nodeId: string, field: "fills" | "strokes", slot: number];

export interface CaptureConfig {
  group: Group;
  fileKey: string;
  anchorId: string;
  roots: Readonly<Record<string, string>>;
  asset?: Asset;
  paints: readonly PaintSlot[];
  backdropId?: string;
  link?: { nodeId: string; targetId: string };
  overlay: Overlay;
  captureRoot: string;
  stagingRoot: string;
}

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, sourceRef: string | null = null): Fields {
  if (!isObject(value)) throw new CompilerError("INVALID_SNAPSHOT", sourceRef);
  return value;
}

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 48) return false;
  if (Array.isArray(value)) return value.every((entry: unknown) => isJson(entry, depth + 1));
  if (isObject(value)) return Object.values(value).every((entry) => isJson(entry, depth + 1));
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function jsonObject(value: unknown, sourceRef: string): JsonObject {
  if (!isJson(value) || !isObject(value)) throw new CompilerError("INVALID_SNAPSHOT", sourceRef);
  return value;
}

function requiredString(value: unknown, sourceRef: string | null = null): string {
  if (typeof value !== "string" || value.length === 0) throw new CompilerError("INVALID_SNAPSHOT", sourceRef);
  return value;
}

function observation(raw: unknown, sourceRef: string): string {
  const value = requiredString(raw, sourceRef);
  if (Buffer.byteLength(value) > PROBE_LIMIT) throw new CompilerError("INPUT_LIMIT_EXCEEDED", sourceRef);
  return value;
}

function channel(value: unknown, sourceRef: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
  }
  return value;
}

function resolveColor(dependency: Fields, sourceRef: string): string {
  const resolved = object(dependency["resolved"], sourceRef);
  if (resolved["resolvedType"] !== "COLOR") throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
  const value = object(resolved["value"], sourceRef);
  channel(value["a"], sourceRef);
  return "#" + ["r", "g", "b"].map((key) =>
    Math.round(channel(value[key], sourceRef) * 255).toString(16).padStart(2, "0")).join("");
}

function paintDependencies(value: unknown, config: CaptureConfig, sourceRef: string | undefined): JsonObject[] {
  if (!Array.isArray(value) || value.length !== config.paints.length) {
    throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
  }
  return config.paints.map(([nodeId, field, slot], index) => {
    const dependency = jsonObject(value[index], nodeId);
    if (dependency["nodeId"] !== nodeId || dependency["field"] !== field || dependency["slot"] !== slot ||
        !["aliasId", "collectionId", "modeId"].every((key) =>
          typeof dependency[key] === "string" && dependency[key].length > 0)) {
      throw new CompilerError("MISSING_DEPENDENCY", nodeId);
    }
    const paint = object(dependency["paint"], nodeId);
    const alias = object(object(paint["boundVariables"], nodeId)["color"], nodeId);
    if (paint["type"] !== "SOLID" || alias["type"] !== "VARIABLE_ALIAS" || alias["id"] !== dependency["aliasId"]) {
      throw new CompilerError("MISSING_DEPENDENCY", nodeId);
    }
    resolveColor(dependency, nodeId);
    return dependency;
  });
}

function boundOverlay(snapshot: Snapshot, config: CaptureConfig): Overlay {
  const overlay = { ...config.overlay, sourceClosureSha256: snapshot.source.closureSha256 };
  if (!isOverlay(overlay)) throw new CompilerError("INVALID_OVERLAY");
  if (config.group === "n") {
    if (overlay.rules.length !== 0) throw new CompilerError("INVALID_OVERLAY", config.roots["N"]);
    return overlay;
  }
  const root = snapshot.roots[1];
  const backdrop = object(root?.facts?.["backdropDependency"], config.backdropId);
  const rules = overlay.rules.filter((rule) => rule.property === "backdrop");
  const rule = rules[0];
  if (rules.length !== 1 || !rule || rule.nodeId !== root?.id || !config.backdropId) {
    throw new CompilerError("INVALID_OVERLAY", root?.sourceRef);
  }
  const value = object(rule.value, root.sourceRef);
  const color = resolveColor(backdrop, config.backdropId);
  if (value["sourceNodeId"] !== config.backdropId || value["field"] !== backdrop["field"] ||
      value["slot"] !== backdrop["slot"] || value["rgbHex"] !== color ||
      object(object(backdrop["resolved"])["value"])["a"] !== 1) {
    throw new CompilerError("SOURCE_CHANGED", config.backdropId);
  }
  return overlay;
}

function directChild(root: DesignNode | undefined, id: string): DesignNode | undefined {
  return root?.children?.find((node) => node.id === id);
}

function observedSlot(value: unknown, slot: number, sourceRef: string): Fields {
  const entry: unknown = Array.isArray(value) ? value[slot] : undefined;
  if (!isObject(entry)) throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
  return entry;
}

function requireArchivedBinding(snapshot: Snapshot, expected: Asset, link: NonNullable<CaptureConfig["link"]>): void {
  const a = snapshot.roots[0];
  const bitmap = directChild(a, expected.nodeId);
  const fill = observedSlot(bitmap?.facts?.["fills"], expected.fillSlot, expected.nodeId);
  if (fill["type"] !== "IMAGE" || fill["imageHash"] !== expected.sourceImageId) {
    throw new CompilerError("MISSING_DEPENDENCY", expected.nodeId);
  }
  const text = directChild(a, link.nodeId);
  const target = directChild(a, link.targetId);
  const segment = observedSlot(text?.facts?.["styledSegments"], 0, link.nodeId);
  const href = segment["hyperlink"];
  if (text?.kind !== "text" || target?.kind !== "frame" || !isObject(href) || href["type"] !== "NODE" ||
      href["value"] !== target.id) {
    throw new CompilerError("MISSING_DEPENDENCY", link.nodeId);
  }
}

function makeSnapshot(raw: string, config: CaptureConfig): Snapshot {
  const rootCode = config.roots[config.group === "n" ? "N" : "A"];
  const data = object(JSON.parse(raw) as unknown);
  if (data["probe"] !== "aik.figma-closure.v1" || data["fileKey"] !== config.fileKey ||
      data["anchorId"] !== config.anchorId || typeof data["apiVersion"] !== "string") {
    throw new CompilerError("SOURCE_CHANGED", rootCode);
  }
  const dependencies = paintDependencies(data["dependencies"], config, rootCode);

  const cases = object(data["cases"]);
  let count = 0;
  const identifiers = new Set<string>();
  function normalize(value: unknown, depth: number): DesignNode {
    const { id, type, children, characters, ...rawFacts } = object(value);
    const sourceRef = requiredString(id);
    if (++count > 32 || depth > 12) throw new CompilerError("INPUT_LIMIT_EXCEEDED", sourceRef);
    if (identifiers.has(sourceRef) || !Array.isArray(children)) throw new CompilerError("INVALID_SNAPSHOT", sourceRef);
    identifiers.add(sourceRef);
    const kind = requiredString(type, sourceRef).toLowerCase().replaceAll("_", "-");
    const facts: JsonObject = {
      ...jsonObject(rawFacts, sourceRef),
      paintDependencies: dependencies.filter((entry) => entry["nodeId"] === sourceRef),
    };
    return {
      id: sourceRef, sourceRef, kind, facts,
      ...(typeof characters === "string" ? { text: characters } : {}),
      ...(config.asset?.nodeId === sourceRef ? { asset: IMAGE_PATH } : {}),
      children: children.map((entry: unknown) => normalize(entry, depth + 1)),
    };
  }
  const keys = config.group === "ab" ? ["A", "B"] : ["N"];
  if (Object.keys(cases).length !== keys.length) throw new CompilerError("SOURCE_CHANGED", rootCode);
  const roots = keys.map((key) => {
    const node = normalize(object(cases[key])["root"], 0);
    if (node.id !== config.roots[key]) throw new CompilerError("SOURCE_CHANGED", node.sourceRef);
    return node;
  });
  const expected = config.asset;
  if (expected) {
    const b = roots[1];
    const backdrop = dependencies.filter((entry) => entry["nodeId"] === config.backdropId);
    if (!b?.facts || b.facts["parentId"] !== config.backdropId || backdrop.length !== 1 ||
        !backdrop[0] || dependencies.some((item) =>
          typeof item["nodeId"] !== "string" || (!identifiers.has(item["nodeId"]) && item !== backdrop[0]))) {
      throw new CompilerError("MISSING_DEPENDENCY", config.backdropId);
    }
    b.facts["backdropDependency"] = backdrop[0];
    const asset = object(data["asset"], expected.nodeId);
    if (!identifiers.has(expected.nodeId) || asset["nodeId"] !== expected.nodeId ||
        asset["fillSlot"] !== expected.fillSlot || asset["sourceImageId"] !== expected.sourceImageId) {
      throw new CompilerError("MISSING_DEPENDENCY", expected.nodeId);
    }
  } else if (data["asset"] !== null || count !== 1 || dependencies.length !== 0) {
    throw new CompilerError("SOURCE_CHANGED", rootCode);
  }
  const snapshot = {
    schemaVersion: "aik.snapshot.v1",
    source: { adapter: "figma", version: "0.1.0", closureSha256: hash(Buffer.from(raw)) },
    assets: expected ? [{ path: IMAGE_PATH, mediaType: "image/png", sha256: expected.sha256 }] : [],
    roots,
  };
  if (!isSnapshot(snapshot)) throw new CompilerError("INVALID_SNAPSHOT", rootCode);
  validateSnapshot(snapshot);
  return snapshot;
}

function assetUrls(value: unknown, truncated: unknown, sourceRef: string): URL[] {
  if (truncated !== false || !Array.isArray(value) || value.length === 0) {
    throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
  }
  if (value.length > 2) throw new CompilerError("INPUT_LIMIT_EXCEEDED", sourceRef);
  return value.map((item: unknown) => {
    if (typeof item !== "string" || item.length > 4096 || !item.startsWith(ORIGIN + "/")) {
      throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
    }
    const url = URL.parse(item);
    if (!url || url.origin !== ORIGIN || url.username || url.password || url.hash) {
      throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
    }
    return url;
  });
}

async function receive(url: URL, budget: number, signal: AbortSignal, sourceRef: string): Promise<Buffer> {
  if (budget <= 0) throw new CompilerError("INPUT_LIMIT_EXCEEDED", sourceRef);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetch(url, { redirect: "error", signal: requestSignal });
    if (response.status !== 200 || !response.body) throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > budget) throw new CompilerError("INPUT_LIMIT_EXCEEDED", sourceRef);
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("MISSING_DEPENDENCY", sourceRef);
  }
}

async function image(urls: URL[], expected: Asset, signal: AbortSignal): Promise<Buffer> {
  let remaining = ASSET_LIMIT;
  let match: Buffer | undefined;
  for (const url of urls) {
    const candidate = await receive(url, remaining, signal, expected.nodeId);
    remaining -= candidate.length;
    if (createHash("sha1").update(candidate).digest("hex") !== expected.sourceImageId) continue;
    if (match || candidate.length !== expected.bytes || hash(candidate) !== expected.sha256) {
      throw new CompilerError("MISSING_DEPENDENCY", expected.nodeId);
    }
    match = candidate;
  }
  if (!match) throw new CompilerError("MISSING_DEPENDENCY", expected.nodeId);
  return match;
}

function archivedImage(fd: number, expected: Asset): Buffer {
  const missing = () => new CompilerError("MISSING_DEPENDENCY", expected.nodeId);
  try {
    const initial = fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n || initial.uid !== BigInt(process.getuid?.() ?? -1) ||
        (initial.mode & 0o7777n) !== 0o600n || initial.size !== BigInt(expected.bytes) ||
        initial.size <= 0n || initial.size > BigInt(ASSET_LIMIT)) throw missing();
    const bytes = Buffer.alloc(expected.bytes);
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(fd, bytes, position, bytes.length - position, position);
      if (count === 0) throw missing();
      position += count;
    }
    const final = fstatSync(fd, { bigint: true });
    const stable = ["dev", "ino", "nlink", "uid", "mode", "size", "mtimeNs", "ctimeNs"] as const;
    if (stable.some((key) => initial[key] !== final[key]) || hash(bytes) !== expected.sha256 ||
        createHash("sha1").update(bytes).digest("hex") !== expected.sourceImageId) throw missing();
    return bytes;
  } catch {
    throw missing();
  }
}

async function trusted(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
      await realpath(path) !== path) throw new CompilerError("UNTRUSTED_CAPTURE_ROOT");
  return info;
}

async function commit(config: CaptureConfig, snapshot: Snapshot, overlay: Overlay, bytes: Buffer | undefined,
  checkDeadline: () => void): Promise<void> {
  const [capture, staging] = await Promise.all([trusted(config.captureRoot), trusted(config.stagingRoot)]);
  if (capture.dev !== staging.dev || capture.ino === staging.ino) throw new CompilerError("UNTRUSTED_CAPTURE_ROOT");
  const destination = join(config.captureRoot, config.group);
  const reservation = join(config.captureRoot, "." + config.group + ".reservation");
  checkDeadline();
  await mkdir(reservation, { mode: 0o700 });
  try {
    const existing = await lstat(destination).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) throw new CompilerError("CAPTURE_EXISTS");
    const scratch = await mkdtemp(join(config.stagingRoot, "figma-"));
    try {
      if (bytes) {
        await mkdir(join(scratch, "assets"), { mode: 0o700 });
        await writeFile(join(scratch, IMAGE_PATH), bytes, { mode: 0o600, flag: "wx" });
      }
      await writeFile(join(scratch, "snapshot.json"), jsonBytes(snapshot), { mode: 0o600, flag: "wx" });
      await writeFile(join(scratch, "overlay.json"), jsonBytes(overlay), { mode: 0o600, flag: "wx" });
      checkDeadline();
      await rename(scratch, destination);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } finally {
    await rm(reservation, { recursive: true, force: true });
  }
}

type ArchivedOriginal = { fd: number; checkDeadline: () => void };

export async function collect(payload: unknown, config: CaptureConfig, signal: AbortSignal, archived?: ArchivedOriginal) {
  if ((config.group === "ab" && !config.asset) || (config.group === "n" && config.asset)) {
    throw new CompilerError("INVALID_CAPTURE_CONFIG");
  }
  const sourceRef = config.asset?.nodeId ?? requiredString(config.roots["N"]);
  const checkDeadline = archived?.checkDeadline ?? (() => { signal.throwIfAborted(); });
  checkDeadline();
  const message = object(payload, sourceRef);
  const before = observation(message["before"], sourceRef);
  if (config.group === "ab" && before !== observation(message["after"], sourceRef)) {
    throw new CompilerError("SOURCE_CHANGED", sourceRef);
  }
  const snapshot = makeSnapshot(before, config);
  const overlay = boundOverlay(snapshot, config);
  const expected = config.asset;
  if (archived && (!expected || !config.link || Object.keys(message).length !== 2)) {
    throw new CompilerError("INVALID_CAPTURE_CONFIG", sourceRef);
  }
  if (archived && expected && config.link) requireArchivedBinding(snapshot, expected, config.link);
  const [capture, staging] = await Promise.all([trusted(config.captureRoot), trusted(config.stagingRoot)]);
  if (capture.dev !== staging.dev || capture.ino === staging.ino) throw new CompilerError("UNTRUSTED_CAPTURE_ROOT");
  const bytes = expected && (archived ? archivedImage(archived.fd, expected) :
    await image(assetUrls(message["urls"], message["rawImagesTruncated"], sourceRef), expected, signal));
  checkDeadline();
  validateAssets(snapshot, new Map(bytes ? [[IMAGE_PATH, bytes]] : []));
  await commit(config, snapshot, overlay, bytes, checkDeadline);
  return { status: "PASS", group: config.group, closureSha256: snapshot.source.closureSha256, assetBytes: bytes?.length ?? 0 };
}
