import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { addAbortSignal } from "node:stream";
import { CompilerError, isOverlay } from "../../../packages/compile-core/src/index.ts";
import { collect } from "./collector.ts";
import type { Asset, CaptureConfig, PaintSlot } from "./collector.ts";

const limit = 160 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function parse(bytes: Uint8Array, diagnostic: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new CompilerError(diagnostic);
  }
}

function isFields(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: unknown): Record<string, unknown> {
  if (!isFields(value)) {
    throw new CompilerError("INVALID_CAPTURE_CONFIG");
  }
  return value;
}

function matched(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new CompilerError("INVALID_CAPTURE_CONFIG");
  return value;
}

function nodeId(value: unknown): string {
  return matched(value, /^\d+:\d+$/u);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CompilerError("INVALID_CAPTURE_CONFIG");
  }
  return value;
}

function assetFields(value: unknown): Asset {
  const asset = fields(value);
  return {
    nodeId: nodeId(asset["nodeId"]),
    fillSlot: integer(asset["fillSlot"], 0, 32),
    sourceImageId: matched(asset["sourceImageId"], /^[0-9a-f]{40}$/u),
    sha256: matched(asset["sha256"], /^[0-9a-f]{64}$/u),
    bytes: integer(asset["bytes"], 1, 2 * 1024 * 1024),
  };
}

function paintSlot(value: unknown): PaintSlot {
  if (!Array.isArray(value) || value.length !== 3) throw new CompilerError("INVALID_CAPTURE_CONFIG");
  const parts: unknown[] = value;
  const [id, field, slot] = parts;
  if (field !== "fills" && field !== "strokes") throw new CompilerError("INVALID_CAPTURE_CONFIG");
  return [nodeId(id), field, integer(slot, 0, 32)];
}

function absolute(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new CompilerError("INVALID_CAPTURE_CONFIG");
  return value;
}

async function readConfig(name: string): Promise<CaptureConfig> {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(16 * 1024 + 1);
  try {
    const record = await handle.stat({ bigint: true });
    if (!record.isFile() || record.nlink !== 1n || record.uid !== BigInt(process.getuid?.() ?? -1) ||
        (record.mode & 0o077n) !== 0n || record.size >= BigInt(bytes.length)) {
      throw new CompilerError("INVALID_CAPTURE_CONFIG");
    }
    const { bytesRead } = await handle.read(bytes);
    const final = await handle.stat({ bigint: true });
    const stable = ["dev", "ino", "nlink", "uid", "mode", "size", "mtimeNs", "ctimeNs"] as const;
    if (BigInt(bytesRead) !== record.size || stable.some((key) => record[key] !== final[key])) {
      throw new CompilerError("INVALID_CAPTURE_CONFIG");
    }
    const config = fields(parse(bytes.subarray(0, bytesRead), "INVALID_CAPTURE_CONFIG"));
    const { group, overlay, paints } = config;
    if ((group !== "ab" && group !== "n") || !isOverlay(overlay) || !Array.isArray(paints) ||
        paints.length !== (group === "ab" ? 5 : 0)) throw new CompilerError("INVALID_CAPTURE_CONFIG");
    const roots = fields(config["roots"]);
    const common: Omit<CaptureConfig, "roots"> = {
      group,
      fileKey: matched(config["fileKey"], /^[A-Za-z0-9]{16,64}$/u),
      anchorId: nodeId(config["anchorId"]),
      overlay,
      paints: paints.map(paintSlot),
      captureRoot: absolute(config["captureRoot"]),
      stagingRoot: absolute(config["stagingRoot"]),
    };
    if (group === "n") return { ...common, roots: { N: nodeId(roots["N"]) } };
    const link = config["link"] === undefined ? undefined : fields(config["link"]);
    return {
      ...common,
      roots: { A: nodeId(roots["A"]), B: nodeId(roots["B"]) },
      backdropId: nodeId(config["backdropId"]),
      asset: assetFields(config["asset"]),
      ...(link && { link: { nodeId: nodeId(link["nodeId"]), targetId: nodeId(link["targetId"]) } }),
    };
  } finally {
    await handle.close();
  }
}

async function readMessage(signal: AbortSignal): Promise<unknown> {
  const stream = addAbortSignal(signal, process.stdin);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const input of stream as AsyncIterable<Buffer>) {
    const newline = input.indexOf(10);
    size += newline >= 0 ? newline : input.length;
    if (size > limit) throw new CompilerError("INPUT_LIMIT_EXCEEDED");
    chunks.push(newline >= 0 ? input.subarray(0, newline) : input);
    if (newline >= 0) {
      if (newline !== input.length - 1) throw new CompilerError("INVALID_SNAPSHOT");
      return parse(Buffer.concat(chunks, size), "INVALID_SNAPSHOT");
    }
  }
  throw new CompilerError("INVALID_SNAPSHOT");
}

try {
  const [, , name, timing, mode, descriptor] = process.argv;
  const fromArchive = mode === "--archived-original-fd" && process.argv.length === 6;
  if (!fromArchive && process.argv.length !== 4) throw new CompilerError("INVALID_CAPTURE_CONFIG");
  const deadline = fromArchive ? integer(Number(timing), 1, Number.MAX_SAFE_INTEGER) : Date.now() +
    integer(Number(timing), 1, 90_000);
  const millis = deadline - Date.now();
  if (millis <= 0) throw new CompilerError("CAPTURE_FAILED");
  const monotonicEnd = performance.now() + integer(millis, 1, 90_000);
  const signal = AbortSignal.timeout(millis);
  const archived = fromArchive ? {
    fd: integer(Number(descriptor), 3, 2 ** 31 - 1),
    checkDeadline: () => {
      if (signal.aborted || Date.now() >= deadline || performance.now() >= monotonicEnd) {
        throw new CompilerError("CAPTURE_FAILED");
      }
    },
  } : undefined;
  const config = await readConfig(absolute(name));
  process.stdout.write("READY\n");
  const result = await collect(await readMessage(signal), config, signal, archived);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const diagnostic = error instanceof CompilerError ? error.diagnostic : new CompilerError("CAPTURE_FAILED").diagnostic;
  process.stdout.write(JSON.stringify({ status: "REFUSED", diagnostic }) + "\n");
  process.exitCode = 1;
}
