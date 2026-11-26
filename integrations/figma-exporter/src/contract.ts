import type { JsonValue } from "../../../packages/compile-core/src/contracts.ts";

export const limits = {
  nodes: 100,
  depth: 8,
  name: 128,
  text: 65_536,
  alt: 200,
  imageHash: 128,
  imageSide: 512,
  png: 2 * 1024 * 1024,
  metadata: 512 * 1024,
  archive: 3 * 1024 * 1024,
} as const;

export const messages = {
  SELECTION: "Select one visible frame on the current page.",
  UNSUPPORTED: "The selection has unsupported layout, paint, text, or behavior.",
  LIMIT: "The selection exceeds an export limit.",
  ALT: "Enter alt text for the image.",
  CHANGED: "The selection changed. Select the frame and capture again.",
  IMAGE: "Figma did not return a supported PNG.",
  CAPTURE: "The capture could not be completed.",
  TIMEOUT: "Capture timed out. Close and reopen the plugin if the editor is still busy.",
} as const;

export type IssueCode = keyof typeof messages;

function issueCode(value: unknown): value is IssueCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(messages, value);
}

export class ExportIssue extends Error {
  readonly code: IssueCode;

  constructor(code: IssueCode) {
    super(messages[code]);
    this.code = code;
  }
}

export function requireValue(condition: unknown, code: IssueCode): asserts condition {
  if (!condition) throw new ExportIssue(code);
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function id(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,16}:[0-9]{1,16}$/u.test(value);
}

export function validString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\uD800-\uDFFF]/u.test(value);
}

function requestId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0x7fff_ffff;
}

export type CaptureRequest = { kind: "capture"; requestId: number; alt: "present" | "" };

export function captureRequest(value: unknown): CaptureRequest | undefined {
  if (!record(value) || value["kind"] !== "capture" ||
      !requestId(value["requestId"]) || (value["alt"] !== "present" && value["alt"] !== "")) return undefined;
  let fields = 0;
  for (const key in value) {
    if (key !== "kind" && key !== "requestId" && key !== "alt") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    fields += 1;
  }
  return fields === 3 ? { kind: "capture", requestId: value["requestId"], alt: value["alt"] } : undefined;
}

export type Image = { nodeId: string; width: number; height: number; png: Uint8Array };
export type Capture = { document: string; image?: Image };

export function pngSide(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= limits.imageSide;
}

export function validatePng(png: Uint8Array, width: number, height: number): void {
  requireValue(png.byteLength <= limits.png, "LIMIT");
  requireValue(png.byteLength >= 33 && pngSide(width) && pngSide(height), "IMAGE");
  const header = new DataView(png.buffer, png.byteOffset, 24);
  requireValue(header.getUint32(0) === 0x89504e47 && header.getUint32(4) === 0x0d0a1a0a &&
    header.getUint32(8) === 13 && header.getUint32(12) === 0x49484452 &&
    header.getUint32(16) === width && header.getUint32(20) === height, "IMAGE");
}

export function result(value: unknown, pending: number): Capture | IssueCode | undefined {
  if (!record(value) || value["requestId"] !== pending) return undefined;
  if (value["kind"] === "failed") {
    const code = value["code"];
    return issueCode(code) ? code : "CAPTURE";
  }
  if (value["kind"] !== "captured") return undefined;
  const document = value["document"];
  if (!validString(document, limits.metadata)) return "LIMIT";
  if (value["image"] === undefined) return { document };
  const image = value["image"];
  if (!record(image) || !id(image["nodeId"]) || !pngSide(image["width"]) || !pngSide(image["height"]) ||
      !(image["png"] instanceof Uint8Array)) return "IMAGE";
  const png = image["png"];
  if (png.byteLength > limits.png) return "LIMIT";
  if (!(png.buffer instanceof ArrayBuffer) || png.byteOffset !== 0 || png.buffer.byteLength !== png.byteLength) return "IMAGE";
  return { document, image: { nodeId: image["nodeId"], width: image["width"], height: image["height"], png } };
}

export function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  // This array is new. The Figma main runtime does not require ES2023 array methods.
  // oxlint-disable-next-line unicorn/no-array-sort
  return "{" + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry)).join(",") + "}";
}

// Call after bounding the projected facts. JSON escapes are already present.
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
