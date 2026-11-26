import { unzlibSync } from "fflate";
import { requireValue, validatePng } from "./contract.ts";

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb8_8320 : 0);
  return value >>> 0;
});

function crc(bytes: Uint8Array): number {
  let state = 0xffff_ffff;
  for (const byte of bytes) state = (state >>> 8) ^ (crcTable[(state ^ byte) & 255] ?? 0);
  return (state ^ 0xffff_ffff) >>> 0;
}

function adler(bytes: Uint8Array): number {
  let low = 1;
  let high = 0;
  for (const byte of bytes) {
    low = (low + byte) % 65521;
    high = (high + low) % 65521;
  }
  return high * 65536 + low;
}

// This subset keeps only pixels and standard fixed-size color, transparency, and density fields.
const allowed = new Map<number, number>([
  [0x7352_4742, 1], // sRGB
  [0x6741_4d41, 4], // gAMA
  [0x6348_524d, 32], // cHRM
  [0x7048_5973, 9], // pHYs
  [0x7452_4e53, 6], // tRNS for RGB
]);

export function validateAsset(png: Uint8Array, width: number, height: number): void {
  validatePng(png, width, height);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const color = view.getUint8(25);
  requireValue(view.getUint8(24) === 8 && (color === 2 || color === 6) &&
    view.getUint8(26) === 0 && view.getUint8(27) === 0 && view.getUint8(28) === 0, "IMAGE");
  const segments: Uint8Array[] = [];
  const seen = new Set<number>();
  let payloadLength = 0;
  let end = false;
  let offset = 8;
  for (let count = 0; offset + 12 <= png.byteLength && count < 1024; count += 1) {
    const byteCount = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    const start = offset + 8;
    const next = start + byteCount;
    requireValue(next + 4 <= png.byteLength && crc(png.subarray(offset + 4, next)) === view.getUint32(next), "IMAGE");
    offset = next + 4;
    if (count === 0) continue; // validatePng already checked the mandatory IHDR.
    if (type === 0x4945_4e44) { // IEND
      requireValue(byteCount === 0 && offset === png.byteLength && payloadLength > 0, "IMAGE");
      end = true;
      break;
    }
    if (type === 0x4944_4154) { // IDAT
      requireValue(byteCount > 0, "IMAGE");
      payloadLength += byteCount;
      segments.push(png.subarray(start, next));
      continue;
    }
    requireValue(segments.length === 0 && allowed.get(type) === byteCount && !seen.has(type) &&
      (type !== 0x7452_4e53 || color === 2), "IMAGE");
    seen.add(type);
  }
  requireValue(end && payloadLength > 6, "IMAGE");
  const compressed = new Uint8Array(payloadLength);
  let cursor = 0;
  for (const segment of segments) {
    compressed.set(segment, cursor);
    cursor += segment.byteLength;
  }
  const stride = width * (color === 2 ? 3 : 4) + 1;
  const expected = stride * height;
  // One additional byte lets a fixed-buffer decoder expose excessive output.
  const pixels = unzlibSync(compressed, { out: new Uint8Array(expected + 1) });
  const zlib = new DataView(compressed.buffer);
  requireValue(pixels.byteLength === expected && adler(pixels) === zlib.getUint32(payloadLength - 4), "IMAGE");
  for (let row = 0; row < height; row += 1) {
    requireValue((pixels[row * stride] ?? 255) <= 4, "IMAGE");
  }
}
