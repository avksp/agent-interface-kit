import { crc32 } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DEPTHS = new Map<number, readonly number[]>([
  [0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]],
]);

function dimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_777_216;
}

function png(data: Buffer): boolean {
  let color: number | undefined;
  let bitDepth = 0;
  let palette = false;
  let payloadSize = 0;
  let hasData = false;
  let dataEnded = false;
  for (let offset = 8; offset + 12 <= data.length;) {
    const size = data.readUInt32BE(offset);
    const start = offset + 8;
    const end = start + size;
    if (end + 4 > data.length) return false;
    const type = data.toString("latin1", offset + 4, start);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
        crc32(data.subarray(offset + 4, end)) !== data.readUInt32BE(end)) return false;
    if (offset === 8 && type !== "IHDR") return false;
    if (type !== "IDAT" && hasData) dataEnded = true;
    switch (type) {
      case "IHDR":
        if (offset !== 8 || size !== 13 || !dimensions(data.readUInt32BE(start), data.readUInt32BE(start + 4))) return false;
        color = data.readUInt8(start + 9);
        bitDepth = data.readUInt8(start + 8);
        if (!PNG_DEPTHS.get(color)?.includes(bitDepth) ||
            data[start + 10] !== 0 || data[start + 11] !== 0 || data.readUInt8(start + 12) > 1) return false;
        break;
      case "PLTE":
        if (palette || hasData || size === 0 || size % 3 !== 0 || size > 768 ||
            color === 0 || color === 4 || (color === 3 && size / 3 > 2 ** bitDepth)) return false;
        palette = true;
        break;
      case "IDAT":
        if (dataEnded || (color === 3 && !palette)) return false;
        hasData = true;
        payloadSize += size;
        break;
      case "IEND":
        return size === 0 && payloadSize > 0 && end + 4 === data.length;
      case "acTL":
      case "fcTL":
      case "fdAT":
        return false;
      default:
        if (type.charAt(0) === type.charAt(0).toUpperCase()) return false;
    }
    offset = end + 4;
  }
  return false;
}

function jpegScanEnd(data: Buffer, start: number, restartInterval: number): number {
  let offset = start;
  let hasData = false;
  let expectedRestart = 0xd0;
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      hasData = true;
      offset++;
      continue;
    }
    const marker = offset++;
    while (data[offset] === 0xff) offset++;
    const next = data[offset++];
    if (next === 0) {
      if (offset !== marker + 2) return -1;
      hasData = true;
    } else if (next === undefined || next < 0xd0 || next > 0xd7) {
      return hasData ? marker : -1;
    } else {
      if (!hasData || restartInterval === 0 || next !== expectedRestart) return -1;
      expectedRestart = next === 0xd7 ? 0xd0 : next + 1;
      hasData = false;
    }
  }
  return -1;
}

function jpegScanHeader(data: Buffer, end: number, count: number, progressive: boolean): boolean {
  const start = data.readUInt8(end - 3);
  const finish = data.readUInt8(end - 2);
  const approximation = data.readUInt8(end - 1);
  if (!progressive) return start === 0 && finish === 63 && approximation === 0;
  const high = approximation >>> 4;
  const low = approximation & 0x0f;
  return finish >= start && finish <= 63 &&
    (start === 0 ? finish === 0 : count === 1) &&
    high <= 13 && low <= 13 && (high === 0 || high === low + 1);
}

function jpeg(data: Buffer): boolean {
  const components = new Map<number, { order: number; units: number }>();
  const sequential = new Set<number>();
  let scanned = false;
  let progressive = false;
  let restartInterval = 0;
  for (let offset = 2; offset < data.length;) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) return scanned && offset === data.length && (progressive || sequential.size === components.size);
    if (marker === undefined || offset + 2 > data.length) return false;
    const size = data.readUInt16BE(offset);
    const end = offset + size;
    if (size < 2 || end > data.length) return false;
    if (marker === 0xc0 || marker === 0xc2) {
      if (components.size > 0 || size < 8 || data[offset + 2] !== 8 ||
          !dimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3))) return false;
      progressive = marker === 0xc2;
      const count = data.readUInt8(offset + 7);
      if (count < 1 || count > 4 || size !== 8 + count * 3) return false;
      for (let i = 0; i < count; i++) {
        const component = offset + 8 + i * 3;
        const factors = data.readUInt8(component + 1);
        const horizontal = factors >>> 4;
        const vertical = factors & 0x0f;
        if (horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 ||
            data.readUInt8(component + 2) > 3) return false;
        components.set(data.readUInt8(component), { order: i, units: horizontal * vertical });
      }
      if (components.size !== count) return false;
    } else if (marker === 0xda) {
      if (size < 6 || components.size === 0) return false;
      const count = data.readUInt8(offset + 2);
      if (count < 1 || count > components.size || size !== 6 + count * 2 ||
          !jpegScanHeader(data, end, count, progressive)) return false;
      const scannedComponents = new Set<number>();
      const tableLimit = progressive ? 3 : 1;
      const dcScan = data.readUInt8(end - 3) === 0;
      const dcRefinement = dcScan && (data.readUInt8(end - 1) >>> 4) !== 0;
      let mcuUnits = 0;
      let lastOrder = -1;
      for (let i = 0; i < count; i++) {
        const component = data.readUInt8(offset + 3 + i * 2);
        const tables = data.readUInt8(offset + 4 + i * 2);
        const dc = tables >>> 4;
        const ac = tables & 0x0f;
        const frame = components.get(component);
        if (!frame || frame.order <= lastOrder || (!progressive && sequential.has(component)) ||
            dc > tableLimit || ac > tableLimit ||
            (progressive && ((dcScan ? ac : dc) !== 0 || (dcRefinement && dc !== 0)))) return false;
        lastOrder = frame.order;
        mcuUnits += frame.units;
        scannedComponents.add(component);
      }
      if (count > 1 && mcuUnits > 10) return false;
      offset = jpegScanEnd(data, end, restartInterval);
      if (offset < 0) return false;
      if (!progressive) {
        for (const component of scannedComponents) sequential.add(component);
      }
      scanned = true;
      continue;
    } else if (marker === 0xdd) {
      if (size !== 4) return false;
      restartInterval = data.readUInt16BE(offset + 2);
    } else if (marker !== 0xc4 && marker !== 0xdb &&
        marker !== 0xfe && (marker < 0xe0 || marker > 0xef)) return false;
    offset = end;
  }
  return false;
}

function webpImage(data: Buffer, start: number, size: number, type: string): [number, number] | undefined {
  if (type === "VP8L") {
    if (size < 6 || data[start] !== 0x2f) return undefined;
    const bits = data.readUInt32LE(start + 1);
    return bits >>> 29 === 0 ? [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1] : undefined;
  }
  if (size < 10 || data.readUIntBE(start + 3, 3) !== 0x9d012a) return undefined;
  const flags = data.readUIntLE(start, 3);
  const partition = flags >>> 5;
  const version = (flags >>> 1) & 7;
  if ((flags & 1) !== 0 || (flags & 0x10) === 0 || version > 3 || partition === 0 || partition >= size - 10) return undefined;
  return [data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff];
}

function webpAlpha(header: number, size: number, width: number, height: number): boolean {
  const compression = header & 3;
  const preprocessing = (header >>> 4) & 3;
  if (preprocessing > 1) return false;
  if (compression === 0) return size === 1 + width * height;
  return compression === 1 && size > 1;
}

function webp(data: Buffer): boolean {
  if (data.length < 20 || data.readUInt32LE(4) !== data.length - 8) return false;
  let canvas: [number, number] | undefined;
  let image: [number, number] | undefined;
  const ancillary = new Set<string>();
  let offset = 12;
  let flags = 0;
  let lossy = false;
  while (offset + 8 <= data.length) {
    const type = data.toString("latin1", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const padded = end + (size % 2);
    if (padded > data.length || (padded !== end && data[end] !== 0)) return false;
    switch (type) {
      case "VP8X": {
        if (offset !== 12 || size !== 10) return false;
        flags = data.readUInt8(start);
        if ((flags & 0xc3) !== 0 || data.readUIntBE(start + 1, 3) !== 0) return false;
        canvas = [data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1];
        if (!dimensions(...canvas)) return false;
        break;
      }
      case "VP8 ":
      case "VP8L":
        if (image || (type === "VP8L" && ancillary.has("ALPH"))) return false;
        lossy = type === "VP8 ";
        image = webpImage(data, start, size, type);
        if (!image || !dimensions(...image) || (canvas && (image[0] !== canvas[0] || image[1] !== canvas[1]))) return false;
        break;
      case "ICCP":
      case "ALPH":
      case "EXIF":
      case "XMP ":
        if (!canvas || size === 0 || ancillary.has(type) ||
            ((type === "ICCP" || type === "ALPH") && image !== undefined) ||
            (type === "ICCP" && ancillary.has("ALPH"))) return false;
        if (type === "ALPH" && !webpAlpha(data.readUInt8(start), size, ...canvas)) return false;
        ancillary.add(type);
        break;
      case "ANIM":
      case "ANMF":
        return false;
    }
    offset = padded;
  }
  return image !== undefined && offset === data.length &&
    Boolean(flags & 0x20) === ancillary.has("ICCP") &&
    Boolean(flags & 0x08) === ancillary.has("EXIF") &&
    Boolean(flags & 0x04) === ancillary.has("XMP ") &&
    (!lossy || Boolean(flags & 0x10) === ancillary.has("ALPH"));
}

export function validatedRasterType(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.subarray(0, 8).equals(PNG_SIGNATURE) && png(data)) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && jpeg(data)) return "image/jpeg";
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP" && webp(data)) return "image/webp";
  return undefined;
}
