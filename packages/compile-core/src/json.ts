import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import artifact from "../../../schemas/artifact-manifest.v1.schema.json" with { type: "json" };
import buildLock from "../../../schemas/build-lock.v1.schema.json" with { type: "json" };
import diagnostic from "../../../schemas/diagnostic.v1.schema.json" with { type: "json" };
import overlay from "../../../schemas/overlay.v1.schema.json" with { type: "json" };
import snapshot from "../../../schemas/snapshot.v1.schema.json" with { type: "json" };
import uiDocument from "../../../schemas/ui-document.v1.schema.json" with { type: "json" };
import { CompilerError } from "./contracts.ts";
import { checkJsonStructure } from "./json-structure.ts";
import type { ArtifactManifest, BuildLock, Diagnostic, Overlay, Snapshot, UiDocument } from "./contracts.ts";

export const JSON_LIMIT = 4 * 1024 * 1024;
export const ASSET_LIMIT = 8 * 1024 * 1024;
export const TOTAL_ASSET_LIMIT = 32 * 1024 * 1024;
export const NODE_LIMIT = 2_000;
export const DEPTH_LIMIT = 32;
const JSON_DEPTH_LIMIT = 112;

const ajv = new Ajv2020({ strict: true });
export const isArtifactManifest = ajv.compile<ArtifactManifest>(artifact);
export const isBuildLock = ajv.compile<BuildLock>(buildLock);
export const isDiagnostic = ajv.compile<Diagnostic>(diagnostic);
export const isOverlay = ajv.compile<Overlay>(overlay);
export const isSnapshot = ajv.compile<Snapshot>(snapshot);
export const isUiDocument = ajv.compile<UiDocument>(uiDocument);

export function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left === right ? 0 : 1;
}

function values(record: unknown): record is Record<string, unknown> {
  return typeof record === "object" && record !== null && !Array.isArray(record);
}

function encode(value: unknown, depth: number): string {
  if (depth > JSON_DEPTH_LIMIT) throw new CompilerError("INPUT_LIMIT_EXCEEDED");
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string" && value.isWellFormed()) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((entry: unknown) => encode(entry, depth + 1)).join(",") + "]";
  if (values(value) && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype)) {
    return "{" + Object.keys(value).toSorted(compareText).map((key) =>
      encode(key, depth + 1) + ":" + encode(value[key], depth + 1)).join(",") + "}";
  }
  throw new CompilerError("INVALID_JSON");
}

export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

export function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value) + "\n", "utf8");
}

export function parseJson(bytes: Uint8Array, invalidCode: string): unknown {
  if (bytes.byteLength > JSON_LIMIT) throw new CompilerError("INPUT_LIMIT_EXCEEDED");
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    checkJsonStructure(text, JSON_DEPTH_LIMIT);
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof CompilerError && error.diagnostic.code === "INPUT_LIMIT_EXCEEDED") throw error;
    throw new CompilerError(invalidCode);
  }
  // The structural bound precedes recursive schema validation.
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof CompilerError && error.diagnostic.code === "INPUT_LIMIT_EXCEEDED") throw error;
    throw new CompilerError(invalidCode);
  }
  return value;
}

export function checkedPath(path: string, code: string): string {
  const parts = path.split("/");
  if (path.length > 512 || parts.length > 32 ||
      parts.some((part) => !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(part))) {
    throw new CompilerError(code);
  }
  return path;
}

export function checkDistinctPaths(paths: readonly string[], code: string): void {
  const files = new Set<string>();
  const directories = new Map<string, string>();
  for (const path of paths) {
    const parts = checkedPath(path, code).split("/");
    const fileKey = path.toLowerCase();
    if (files.has(fileKey) || directories.has(fileKey)) throw new CompilerError(code);
    files.add(fileKey);
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join("/");
      const key = directory.toLowerCase();
      if (files.has(key) || (directories.has(key) && directories.get(key) !== directory)) {
        throw new CompilerError(code);
      }
      directories.set(key, directory);
    }
  }
}
