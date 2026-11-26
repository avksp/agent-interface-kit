import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { createLock, hash, jsonBytes, MANIFEST_NAME, readLock } from "@aik/compile-core";
import { publishLock, publishOutput, recoverOutput, verifyOutput } from "@aik/compile-core/writer";
import { runCli } from "@aik/cli";
import { compileFixture, fixtureHost, fixtureSnapshot, forwardFs, lockArgs, lockFixture, png, runIsolatedCli, runObservedCli, tree,
  writeFixture } from "./support/core-harness.mjs";

import { buildQualificationProbe, onApfsx } from "./support/lock-apfsx.mjs";
import { loadSecureFs } from "../../../packages/cli/src/commands/secure-fs.ts";

const MB = 1024 * 1024;

/** @param {import("node:test").TestContext} t */
async function rootFor(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "aik-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * @param {import("@aik/cli").CliResult} result
 * @param {string} code
 * @param {string | null} [sourceRef]
 */
function refuses(result, code, sourceRef = null) {
  assert.deepEqual(result, { status: "error", diagnostics: [{ code, severity: "error", sourceRef }] });
}

void test("CLI lock, compile and verify produce identical bytes from two absolute roots", async (t) => {
  const roots = [await rootFor(t), await rootFor(t)];
  const observed = [];
  for (const root of roots) {
    const paths = await writeFixture(root);
    const host = fixtureHost(root);
    assert.equal((await lockFixture(paths, host)).status, "ok");
    const first = await compileFixture(paths, host);
    assert.equal(first.status, "ok");
    assert.equal((await runCli(["verify", "--manifest", paths.manifest], host)).status, "ok");
    const expected = [
      { path: "artifact-manifest.json", type: "file" },
      { path: "assets", type: "directory" },
      { path: "assets/a.png", type: "file" },
      { path: "fixture.txt", type: "file" },
    ];
    const before = await tree(paths.output);
    assert.deepEqual(before.map(({ path, type }) => ({ path, type })), expected);
    const inode = (await lstat(paths.manifest)).ino;
    assert.deepEqual(await compileFixture(paths, host), first);
    assert.equal((await lstat(paths.manifest)).ino, inode);
    assert.deepEqual(await tree(paths.output), before);
    observed.push({ lock: await readFile(paths.lock), output: before });
    await mkdir(join(paths.output, "same-extra"));
  }
  assert.notEqual(roots[0], roots[1]);
  assert.deepEqual(observed[0], observed[1]);
  for (const root of roots) {
    const current = await tree(join(root, "site"));
    assert.notDeepEqual(current, observed[0]?.output);
    assert.ok(current.some((entry) => entry.path === "same-extra"));
  }
});

void test("CLI refuses malformed, stale and escaping inputs before publication", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  await writeFile(paths.lock, "{}");
  refuses(await compileFixture(paths, host), "INVALID_LOCK");
  await rm(paths.lock);
  assert.equal((await lockFixture(paths, host)).status, "ok");

  const locked = await readFile(paths.lock);
  await writeFile(paths.lock, locked.toString("utf8").replace("assets/a.png", "../outside.png"));
  refuses(await compileFixture(paths, host), "INVALID_LOCK");
  await writeFile(paths.lock, locked);
  refuses(await compileFixture(paths, { ...host, nodeVersion: "changed" }), "INVALID_LOCK");
  await writeFile(paths.image, Buffer.concat([png, Buffer.from([1])]));
  refuses(await compileFixture(paths, host), "INPUT_DIGEST_MISMATCH", "fixture:image");
  await rm(paths.image);
  await writeFile(join(root, "outside.png"), png);
  await symlink(join(root, "outside.png"), paths.image);
  refuses(await compileFixture(paths, host), "MISSING_DEPENDENCY", "fixture:image");
  await assert.rejects(lstat(paths.output), { code: "ENOENT" });
});

void test("overlay precedence keeps child order explicit and reports deterministic conflicts", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const rules = [
    { id: "low", nodeId: "text", property: "semantic", precedence: 1, value: "p" },
    { id: "higher", nodeId: "text", property: "semantic", precedence: 6, value: "h1" },
    { id: "order", nodeId: "frame", property: "reading-order", precedence: 6, value: ["image", "text"] },
  ];
  await writeFile(paths.overlay, jsonBytes({ schemaVersion: "aik.overlay.v1", rules }));
  assert.equal((await lockFixture(paths, host)).status, "ok");
  assert.equal((await compileFixture(paths, host)).status, "ok");
  const emitted = await readFile(join(paths.output, "fixture.txt"), "utf8");
  assert.match(emitted, /"intent":\{"semantic":"h1"\}/u);
  assert.ok(emitted.indexOf('"id":"image"') < emitted.indexOf('"id":"text"'));
  await rm(paths.lock);
  rules.push({ id: "conflict", nodeId: "text", property: "semantic", precedence: 6, value: "span" });
  await writeFile(paths.overlay, jsonBytes({ schemaVersion: "aik.overlay.v1", rules }));
  refuses(await lockFixture(paths, host), "CONFLICTING_INTENT", "fixture:text");
  await writeFile(paths.overlay, jsonBytes({ schemaVersion: "aik.overlay.v1", rules: rules.toReversed() }));
  refuses(await lockFixture(paths, host), "CONFLICTING_INTENT", "fixture:text");
});

/** @param {number} depth @param {number} [level] @returns {import("@aik/compile-core").DesignNode} */
function nested(depth, level = 1) {
  return {
    id: String(level), sourceRef: "depth:" + level, kind: "frame",
    children: depth > level ? [nested(depth, level + 1)] : [],
  };
}

void test("JSON bytes and node or depth limits accept the exact boundary", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const snapshot = fixtureSnapshot();
  const overlay = Buffer.from(jsonBytes({ schemaVersion: "aik.overlay.v1", rules: [] }));
  await writeFile(paths.overlay, Buffer.concat([overlay, Buffer.alloc(4 * MB - overlay.length, 32)]));
  assert.equal((await lockFixture(paths, host)).status, "ok");
  await rm(paths.lock);
  await writeFile(paths.overlay, Buffer.concat([overlay, Buffer.alloc(4 * MB - overlay.length + 1, 32)]));
  refuses(await lockFixture(paths, host), "INPUT_LIMIT_EXCEEDED");
  await writeFile(paths.overlay, overlay);

  const wide = Array.from({ length: 2_001 }, (_, id) =>
    ({ id: String(id), sourceRef: "wide:" + id, kind: "frame", children: [] }));
  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, roots: wide.slice(0, 2_000), assets: [] }));
  assert.equal((await lockFixture(paths, host)).status, "ok");
  await rm(paths.lock);
  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, roots: wide, assets: [] }));
  refuses(await lockFixture(paths, host), "INPUT_LIMIT_EXCEEDED", "wide:2000");

  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, roots: [nested(32)], assets: [] }));
  assert.equal((await lockFixture(paths, host)).status, "ok");
  await rm(paths.lock);
  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, roots: [nested(33)], assets: [] }));
  refuses(await lockFixture(paths, host), "INPUT_LIMIT_EXCEEDED", "depth:33");
});

/** @param {number} size */
function raster(size) {
  const marker = Buffer.alloc(size - png.length);
  marker.writeUInt32BE(marker.length - 12, 0);
  marker.write("tEXt", 4, "ascii");
  marker.write("Note\0", 8, "ascii");
  marker.fill(65, 13, marker.length - 4);
  marker.writeUInt32BE(crc32(marker.subarray(4, -4)), marker.length - 4);
  return Buffer.concat([png.subarray(0, -12), marker, png.subarray(-12)]);
}

void test("asset byte limits and declared raster type are enforced before output", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const snapshot = fixtureSnapshot();
  const full = raster(8 * MB);
  const files = [];
  for (let index = 0; index < 4; index++) {
    const path = "assets/" + index + ".png";
    await writeFile(join(paths.capture, path), full);
    files.push({ path, sha256: hash(full), mediaType: "image/png" });
  }
  const roots = files.map(({ path }, index) => ({
    id: String(index), sourceRef: "asset:" + index, asset: path, kind: "image", children: [],
  }));
  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, roots, assets: files }));
  assert.equal((await lockFixture(paths, host)).status, "ok");
  await rm(paths.lock);
  const byte = Uint8Array.of(0);
  const fifth = { path: "assets/z.png", sha256: hash(byte), mediaType: "image/png" };
  await writeFile(join(paths.capture, fifth.path), byte);
  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, roots, assets: [...files, fifth] }));
  refuses(await lockFixture(paths, host), "INPUT_LIMIT_EXCEEDED");

  await writeFile(paths.snapshot, jsonBytes(snapshot));
  await writeFile(paths.image, raster(8 * MB + 1));
  refuses(await lockFixture(paths, host), "INPUT_LIMIT_EXCEEDED", "fixture:image");

  await writeFile(paths.image, png);
  const file = snapshot.assets[0];
  assert.ok(file);
  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, assets: [{ ...file, mediaType: "image/jpeg" }] }));
  refuses(await lockFixture(paths, host), "ASSET_TYPE_MISMATCH", "fixture:image");
});

void test("an existing generation survives drift, extra files and symlink refusals", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  assert.equal((await lockFixture(paths, host)).status, "ok");
  assert.equal((await compileFixture(paths, host)).status, "ok");
  const original = await readFile(paths.manifest);

  await rm(paths.lock);
  assert.equal((await lockFixture(paths, host, ["--naming", "bem"])).status, "ok");
  refuses(await compileFixture(paths, host), "OUTPUT_DRIFT");
  assert.deepEqual(await readFile(paths.manifest), original);

  const textPath = join(paths.output, "fixture.txt");
  const text = await readFile(textPath);
  await writeFile(textPath, "changed");
  refuses(await runCli(["verify", "--manifest", paths.manifest], host), "OUTPUT_DRIFT");
  await writeFile(textPath, text);
  const stray = join(paths.output, "extra");
  await mkdir(stray);
  refuses(await runCli(["verify", "--manifest", paths.manifest], host), "OUTPUT_DRIFT");
  await rm(stray, { recursive: true });
  await symlink(paths.image, stray);
  refuses(await runCli(["verify", "--manifest", paths.manifest], host), "OUTPUT_DRIFT");
  assert.deepEqual(await readFile(paths.manifest), original);
});

void test("competing writers reserve one destination before publication", async (t) => {
  const root = await rootFor(t);
  const destination = join(root, "site");
  const identity = fixtureHost(root).writer;
  const build = (/** @type {string} */ text) =>
    publishOutput(destination, root, [{ path: "a.txt", mediaType: "text/plain", bytes: Buffer.from(text) }], identity, loadSecureFs());
  const results = await Promise.allSettled([build("a"), build("b")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const refused = results.find((result) => result.status === "rejected");
  assert.ok(refused);
  assert.ok(refused.reason instanceof Error);
  assert.equal(refused.reason.message, "OUTPUT_BUSY");
  assert.ok(["a", "b"].includes(await readFile(join(destination, "a.txt"), "utf8")));
});

void test("an interrupted writer leaves recoverable staging and preserves committed output", async (t) => {
  const root = await rootFor(t);
  const identity = fixtureHost(root).writer;
  const script = `
    import { writeSync } from "node:fs";
    import { publishOutput } from "@aik/compile-core/writer";
    import { loadSecureFs } from "./packages/cli/src/commands/secure-fs.ts";
    import { forwardFs } from "./tests/releases/0.1.0/support/core-harness.mjs";
    import process from "node:process";
    const [root, destination, state] = process.argv.slice(1);
    const files = [{path: "assets/a.txt", mediaType: "text/plain", bytes: Buffer.from("fixture")}];
    const native = loadSecureFs();
    const fs = forwardFs(native, {
      renameExclusive(from, source, to, target) {
        if (state === "hold") {
          writeSync(1, "staged\\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        native.renameExclusive(from, source, to, target);
      },
    });
    await publishOutput(destination, root, files, {pid: process.pid, bootId: "test-local-boot"}, fs);
    process.stdout.write("committed\\n");
    setInterval(() => {}, 1000);
  `;
  const early = join(root, "not-committed");
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    first.kill("SIGKILL");
  }, 5_000);
  const first = spawn(process.execPath, ["--input-type=module", "-e", script, root, early, "hold"]);
  const firstClosed = once(first, "close");
  t.after(() => {
    clearTimeout(timer);
    first.kill("SIGKILL");
  });
  const ready = await Promise.race([once(first.stdout, "data"), firstClosed]);
  assert.ok(Buffer.isBuffer(ready[0]));
  assert.equal(ready[0].toString("utf8"), "staged\n");
  await wait(30);
  await assert.rejects(lstat(early), { code: "ENOENT" });
  await assert.rejects(recoverOutput(early, root, identity.bootId, () => true, loadSecureFs()), { message: "OUTPUT_BUSY" });
  first.kill("SIGKILL");
  assert.deepEqual(await firstClosed, [null, "SIGKILL"]);
  clearTimeout(timer);
  assert.equal(expired, false);
  await assert.rejects(lstat(early), { code: "ENOENT" });
  const dead = first.pid;
  await recoverOutput(early, root, identity.bootId, (pid) => pid !== dead, loadSecureFs());
  assert.deepEqual(await readdir(root), []);

  const late = join(root, "committed");
  const second = spawn(process.execPath, ["--input-type=module", "-e", script, root, late, "publish"]);
  const secondClosed = once(second, "close");
  t.after(() => second.kill("SIGKILL"));
  const signal = await Promise.race([once(second.stdout, "data"), secondClosed]);
  assert.ok(Buffer.isBuffer(signal[0]));
  assert.match(signal[0].toString("utf8"), /committed/u);
  const manifest = await readFile(join(late, "artifact-manifest.json"));
  second.kill("SIGKILL");
  assert.deepEqual(await secondClosed, [null, "SIGKILL"]);
  const reservation = join(root, ".aik-" + hash(Buffer.from("committed")).slice(0, 32) + ".reservation");
  assert.ok(second.pid);
  await mkdir(reservation);
  await writeFile(join(reservation, "owner.json"), jsonBytes({
    pid: second.pid, bootId: identity.bootId,
  }));
  await recoverOutput(late, root, identity.bootId, (pid) => pid !== second.pid, loadSecureFs());
  await assert.rejects(lstat(reservation), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(late, "artifact-manifest.json")), manifest);
  assert.equal((await runCli(["verify", "--manifest", join(late, "artifact-manifest.json")], fixtureHost(root))).status, "ok");
});


void test("lock validates digest-matched PNG, JPEG and WebP containers", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const snapshot = fixtureSnapshot();
  const asset = snapshot.assets[0];
  assert.ok(asset);
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z", "base64");
  const webp = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA", "base64");
  const badPng = Buffer.from(png);
  const crcOffset = png.length - 13;
  badPng[crcOffset] = badPng.readUInt8(crcOffset) ^ 1;
  for (const [mediaType, valid, invalid] of [
    ["image/png", png, badPng],
    ["image/jpeg", jpeg, jpeg.subarray(0, -1)],
    ["image/webp", webp, Buffer.concat([webp, Buffer.from([0])])],
  ]) {
    assert.ok(typeof mediaType === "string" && Buffer.isBuffer(valid) && Buffer.isBuffer(invalid));
    for (const [bytes, accepted] of [[valid, true], [invalid, false]]) {
      assert.ok(Buffer.isBuffer(bytes));
      await writeFile(paths.snapshot, jsonBytes({ ...snapshot, assets: [{ ...asset, mediaType, sha256: hash(bytes) }] }));
      await writeFile(paths.image, bytes);
      const result = await lockFixture(paths, host);
      if (accepted === true) {
        assert.equal(result.status, "ok");
        assert.equal((await lstat(paths.lock)).nlink, 1);
        await rm(paths.lock);
      } else {
        refuses(result, "ASSET_TYPE_MISMATCH", "fixture:image");
        await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
      }
    }
  }
});

/** @param {string} type @param {Buffer} payload */
function pngChunk(type, payload) {
  const name = Buffer.from(type);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length);
  name.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([header, payload, checksum]);
}

/** @param {number} width @param {number} height */
function pngHeader(width, height) {
  const payload = Buffer.from(png.subarray(16, 29));
  payload.writeUInt32BE(width);
  payload.writeUInt32BE(height, 4);
  return pngChunk("IHDR", payload);
}

/** @param {number} width @param {number} height @param {number} [frame] */
function jpegFrame(width, height, frame = 0xc0) {
  const bytes = Buffer.from([0xff, frame, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  bytes.writeUInt16BE(height, 5);
  bytes.writeUInt16BE(width, 7);
  return bytes;
}

/** @param {number} width @param {number} height */
function webpFrame(width, height) {
  const bytes = Buffer.from("RIFF____WEBPVP8 ____", "ascii");
  const payload = Buffer.of(0x30, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0, 1, 2, 3, 0);
  bytes.writeUInt32LE(26, 4);
  bytes.writeUInt32LE(13, 16);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return Buffer.concat([bytes, payload]);
}

/** @param {Buffer[]} chunks */
const pngWith = (...chunks) => Buffer.concat([png.subarray(0, 8), ...chunks]);

/** @param {Buffer[]} segments */
const jpegWith = (...segments) => Buffer.concat([Buffer.of(0xff, 0xd8), ...segments]);

/** @param {string} name @param {Buffer} payload */
function webpChunk(name, payload) {
  const header = Buffer.alloc(8);
  header.write(name, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
}

/** @param {Buffer[]} chunks */
function riffWebp(...chunks) {
  const result = Buffer.concat([Buffer.from("RIFF____WEBP", "ascii"), ...chunks]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

/** @param {number} flags @param {Buffer[]} chunks */
function extendedWebp(flags, ...chunks) {
  const canvas = Buffer.alloc(10);
  canvas[0] = flags;
  return riffWebp(webpChunk("VP8X", canvas), ...chunks);
}

/** @param {Buffer} frame @param {Buffer} scan @param {Buffer} end */
function progressiveJpeg(frame, scan, end) {
  const dc = Buffer.from(scan);
  dc[8] = 0;
  const ac = Buffer.from(scan);
  ac[7] = 1;
  return jpegWith(frame, dc, Buffer.of(1), ac, Buffer.of(1), end);
}

/**
 * @param {Buffer} frame
 * @param {Buffer} scan
 * @param {Buffer} end
 * @param {Buffer} webp
 */
function rasterStructureCases(frame, scan, end, webp) {
  /** @param {number} marker @param {number} factors */
  const withFactors = (marker, factors) => {
    const result = Buffer.from(frame);
    result[1] = marker;
    result[11] = factors;
    return marker === 0xc2 ? progressiveJpeg(result, scan, end) : jpegWith(result, scan, Buffer.of(1), end);
  };
  /** @param {Buffer} interval */
  const withInterval = (interval) => jpegWith(frame, interval, scan, Buffer.of(1), end);
  const lossy = webp.subarray(12);
  const lossless = webpChunk("VP8L", Buffer.of(0x2f, 0, 0, 0, 0x10, 0));
  const losslessWithoutHint = webpChunk("VP8L", Buffer.of(0x2f, 0, 0, 0, 0, 0));
  const profile = webpChunk("ICCP", Buffer.of(1));
  const alpha = webpChunk("ALPH", Buffer.of(0, 255));
  const exif = webpChunk("EXIF", Buffer.of(1));
  const xmp = webpChunk("XMP ", Buffer.of(1));
  const encoded = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/9oADAMBAAIQAxAAAAGdChv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEA//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==", "base64");
  assert.equal(hash(encoded), "14c9baa023b051f18fc674c6af4b568f0e7ada29b11a871109cf2d4dbedd368c");
  const frameMarkers = [0xc0, 0xc2];
  return {
    jpegGood: [encoded, ...frameMarkers.flatMap((marker) => [withFactors(marker, 0x11), withFactors(marker, 0x44)]),
      withInterval(Buffer.of(255, 0xdd, 0, 4, 0, 0))],
    jpegBad: [...frameMarkers.flatMap((marker) => [0x01, 0x10, 0x51, 0x15].map((factors) => withFactors(marker, factors))),
      withInterval(Buffer.of(255, 0xdd, 0, 3, 0)), withInterval(Buffer.of(255, 0xdd, 0, 5, 0, 0, 0))],
    webpGood: [riffWebp(lossless), extendedWebp(0x10, alpha, lossy), extendedWebp(0x3c, profile, lossless, exif, xmp),
      extendedWebp(0, lossless), extendedWebp(0x10, losslessWithoutHint)],
    webpBad: [extendedWebp(0x20, lossy), extendedWebp(0, profile, lossy),
      extendedWebp(0x08, lossy), extendedWebp(0, lossy, exif),
      extendedWebp(0x04, lossy), extendedWebp(0, lossy, xmp),
      extendedWebp(0x10, lossy), extendedWebp(0, alpha, lossy),
      extendedWebp(0x30, alpha, profile, lossy), extendedWebp(0x10, alpha, lossless)],
  };
}

/**
 * @param {Buffer} frame
 * @param {Buffer} scan
 * @param {Buffer} end
 * @param {Buffer} webp
 */
function rasterHeaderCases(frame, scan, end, webp) {
  const progressiveFrame = Buffer.from(frame);
  progressiveFrame[1] = 0xc2;
  /** @param {number} start @param {number} finish @param {number} approximation @param {number} [tables] */
  const scanHeader = (start, finish, approximation, tables = 0) => {
    const header = Buffer.from(scan);
    header[6] = tables;
    header[7] = start;
    header[8] = finish;
    header[9] = approximation;
    return header;
  };
  /** @param {Buffer} source @param {Buffer[]} headers */
  const encode = (source, ...headers) => jpegWith(source, ...headers.flatMap((header) => [header, Buffer.of(1)]), end);
  const maxQuant = Buffer.from(frame);
  maxQuant[12] = 3;
  const badQuant = Buffer.from(frame);
  badQuant[12] = 4;
  const multiple = Buffer.concat([progressiveFrame, Buffer.of(2, 0x11, 0)]);
  multiple.writeUInt16BE(14, 2);
  multiple[9] = 2;
  const multipleAc = Buffer.of(255, 0xda, 0, 10, 2, 1, 0, 2, 0, 1, 63, 0);
  const sequentialMcu = Buffer.of(255, 0xda, 0, 10, 2, 1, 0, 2, 0, 0, 63, 0);
  const progressiveMcu = Buffer.of(255, 0xda, 0, 10, 2, 1, 0, 2, 0, 0, 0, 0);
  /** @param {number} marker @param {number} first @param {number} second */
  const mcuFrame = (marker, first, second) => {
    const result = Buffer.from(multiple);
    result[1] = marker;
    result[11] = first;
    result[14] = second;
    return result;
  };
  const enabled = Buffer.of(255, 0xdd, 0, 4, 0, 1);
  const disabled = Buffer.of(255, 0xdd, 0, 4, 0, 0);
  const restarted = Buffer.of(1, 255, 0xd0, 1);
  const orderedFrame = mcuFrame(0xc0, 0x11, 0x11);
  orderedFrame[10] = 9;
  orderedFrame[13] = 4;
  const orderedScan = Buffer.from(sequentialMcu);
  orderedScan[5] = 9;
  orderedScan[7] = 4;
  const reversedScan = Buffer.from(orderedScan);
  reversedScan[5] = 4;
  reversedScan[7] = 9;
  const firstSequential = Buffer.from(scan);
  firstSequential[5] = 9;
  const secondSequential = Buffer.from(scan);
  secondSequential[5] = 4;
  const restartWrap = Buffer.from(Array.from({ length: 9 }, (_, n) => [1, 255, 0xd0 + (n % 8)]).flat());
  const lossy = webp.subarray(12);
  /** @param {number} version */
  const versioned = (version) => {
    const image = Buffer.from(lossy);
    image[8] = 0x30 | (version << 1);
    return riffWebp(image);
  };
  /** @param {number[]} bytes */
  const alpha = (...bytes) => extendedWebp(0x10, webpChunk("ALPH", Buffer.from(bytes)), lossy);
  const compressedAlpha = Buffer.from("UklGRmAAAABXRUJQVlA4WAoAAAAQAAAADwAADwAAQUxQSA8AAAABEBIQV013RlYjYgJI8xcAVlA4ICoAAACQAQCdASoQABAAAgA0JaACdLoAA5gA/vDEC/8EFtR6YceH/cdgbrl8AAA=", "base64");
  assert.equal(hash(compressedAlpha), "7c972d50d83a1c75bd013b9073740c5e4c1af029f9dbc608d5b799aa48a2b97b");
  const missingTokens = Buffer.from(compressedAlpha);
  const vp8 = missingTokens.indexOf("VP8 ", 12, "latin1");
  assert.equal(vp8, 54);
  const keyFrameBytes = missingTokens.readUInt32LE(vp8 + 4);
  const frameTag = missingTokens.readUIntLE(vp8 + 8, 3);
  assert.ok(frameTag >>> 5 < keyFrameBytes - 10);
  missingTokens.writeUIntLE(((keyFrameBytes - 10) << 5) | (frameTag & 31), vp8 + 8, 3);
  const rawAlphaModes = [0, 1].flatMap((preprocess) => [0, 1, 2, 3].map((filter) =>
    alpha((preprocess << 4) | (filter << 2), 255)));
  const reservedWebpByte = extendedWebp(0, lossy);
  reservedWebpByte[21] = 1;
  const hidden = Buffer.from(lossy);
  hidden[8] = hidden.readUInt8(8) & ~0x10;
  const firstDc = scanHeader(0, 0, 1);
  const firstAc = scanHeader(1, 63, 1);
  return {
    jpegGood: [encode(frame, scanHeader(0, 63, 0, 0x11)), encode(maxQuant, scan),
      jpegWith(frame, scan, Buffer.of(255, 0), end),
      jpegWith(frame, scan, Buffer.of(1, 255), end),
      encode(progressiveFrame, firstDc, firstAc, scanHeader(0, 0, 0x10), scanHeader(1, 63, 0x10)),
      encode(mcuFrame(0xc0, 0x32, 0x22), sequentialMcu), encode(mcuFrame(0xc2, 0x32, 0x22), progressiveMcu),
      jpegWith(frame, enabled, scan, restartWrap, Buffer.of(1), end),
      jpegWith(frame, enabled, scan, Buffer.of(1), end), encode(orderedFrame, orderedScan),
      jpegWith(orderedFrame, enabled, firstSequential, restarted, secondSequential, restarted, end),
      jpegWith(orderedFrame, enabled, firstSequential, restarted, disabled, secondSequential, Buffer.of(1), end)],
    jpegBad: [encode(badQuant, scan), encode(frame, scanHeader(1, 63, 0)), encode(frame, scanHeader(0, 0, 0)),
      encode(frame, scanHeader(0, 63, 1)), encode(frame, scanHeader(0, 63, 0, 0x20)),
      encode(frame, scanHeader(0, 63, 0, 0x02)), encode(progressiveFrame, scanHeader(0, 63, 0)),
      encode(progressiveFrame, firstDc, scanHeader(9, 8, 0)), encode(progressiveFrame, firstDc, scanHeader(1, 64, 0)),
      encode(progressiveFrame, scanHeader(0, 0, 14)), encode(progressiveFrame, firstDc, scanHeader(1, 63, 0x22)),
      encode(progressiveFrame, scanHeader(0, 0, 0, 0x40)), encode(multiple, multipleAc),
      encode(progressiveFrame, scanHeader(0, 0, 0, 0x01)), encode(progressiveFrame, firstDc, scanHeader(1, 63, 0, 0x10)),
      encode(mcuFrame(0xc0, 0x31, 0x42), sequentialMcu), encode(mcuFrame(0xc2, 0x31, 0x42), progressiveMcu),
      jpegWith(frame, scan, Buffer.of(1, 255, 0xd0, 1), end),
      jpegWith(frame, enabled, scan, Buffer.of(1, 255, 0xd1, 1), end),
      jpegWith(frame, enabled, scan, Buffer.of(1, 255, 0xd0, 1, 255, 0xd0, 1), end),
      encode(orderedFrame, reversedScan), encode(orderedFrame, firstSequential),
      encode(orderedFrame, firstSequential, firstSequential),
      encode(progressiveFrame, firstDc, scanHeader(0, 0, 0x10, 0x10)),
      jpegWith(orderedFrame, enabled, firstSequential, restarted, disabled, secondSequential, restarted, end),
      jpegWith(orderedFrame, enabled, firstSequential, restarted, secondSequential, Buffer.of(1, 255, 0xd1, 1), end),
      jpegWith(frame, enabled, scan, Buffer.of(255, 0xd0, 1), end),
      jpegWith(frame, enabled, scan, Buffer.of(1, 255, 0xd0, 255, 0xd1, 1), end),
      jpegWith(frame, enabled, scan, Buffer.of(1, 255, 0xd0), end),
      jpegWith(frame, scan, Buffer.of(1, 255, 255, 0, 1), end)],
    webpGood: [versioned(0), versioned(1), versioned(2), versioned(3), ...rawAlphaModes, alpha(0xc0, 255), compressedAlpha],
    webpBad: [missingTokens, riffWebp(hidden), extendedWebp(0x80, lossy), extendedWebp(0x01, lossy),
      extendedWebp(0x02, lossy), reservedWebpByte, versioned(4), versioned(5), versioned(6), versioned(7), alpha(0), alpha(0, 255, 255),
      alpha(2, 255), alpha(0x20, 255), alpha(1)],
  };
}

void test("digest-matched raster structure and exact dimensions gate both lock and compile", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  assert.equal((await lockFixture(paths, host)).status, "ok");
  assert.equal((await compileFixture(paths, host)).status, "ok");
  const prior = await tree(paths.output);
  const original = readLock(await readFile(paths.lock));
  await rm(paths.lock);
  const snapshot = fixtureSnapshot();
  const image = snapshot.assets[0];
  assert.ok(image);
  const ihdr = pngHeader(1, 1);
  const idat = png.subarray(33, -12);
  const iend = png.subarray(-12);
  const ancillary = pngChunk("tEXt", Buffer.from("test"));
  const badLength = Buffer.from(idat);
  badLength.writeUInt32BE(0xffffffff);
  const badCrc = Buffer.from(idat);
  badCrc[badCrc.length - 1] = badCrc.readUInt8(badCrc.length - 1) ^ 1;
  const frame = jpegFrame(1, 1);
  const scan = Buffer.of(0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0);
  const eoi = Buffer.of(0xff, 0xd9);
  const badSegment = Buffer.from(frame);
  badSegment.writeUInt16BE(1, 2);
  const webp = webpFrame(1, 1);
  const badRiff = Buffer.from(webp);
  badRiff.writeUInt32LE(23, 4);
  const badChunk = Buffer.from(webp);
  badChunk.writeUInt32LE(17, 16);
  const badPad = Buffer.from(webp);
  badPad.writeUInt8(1, badPad.length - 1);
  const animated = Buffer.from(webp);
  animated.write("ANIM", 12);
  const trailing = Buffer.concat([webp, Buffer.of(0)]);
  trailing.writeUInt32LE(trailing.length - 8, 4);
  const featureCases = rasterStructureCases(frame, scan, eoi, webp);
  const headerCases = rasterHeaderCases(frame, scan, eoi, webp);
  const cases = [
    { type: "image/png", make: (/** @type {number} */ w, /** @type {number} */ h) => pngWith(pngHeader(w, h), idat, iend),
      invalid: [pngWith(ihdr, badLength, iend), pngWith(ihdr, badCrc, iend), pngWith(ancillary, ihdr, idat, iend),
        pngWith(ihdr, ihdr, idat, iend), pngWith(ihdr, idat, ancillary, idat, iend),
        pngWith(ihdr, pngChunk("IDAT", Buffer.alloc(0)), iend), pngWith(ihdr, idat, iend, Buffer.of(0))] },
    { type: "image/jpeg", make: (/** @type {number} */ w, /** @type {number} */ h) =>
      progressiveJpeg(jpegFrame(w, h, 0xc2), scan, eoi),
      positive: [...featureCases.jpegGood, ...headerCases.jpegGood],
      invalid: [...featureCases.jpegBad, ...headerCases.jpegBad, jpegWith(badSegment, scan, Buffer.of(1), eoi), jpegWith(jpegFrame(1, 1, 0xc1), scan, Buffer.of(1), eoi),
        jpegWith(frame, scan, eoi), jpegWith(frame, scan, Buffer.of(1), eoi, Buffer.of(0))] },
    { type: "image/webp", make: webpFrame, positive: [...featureCases.webpGood, ...headerCases.webpGood],
      invalid: [...featureCases.webpBad, ...headerCases.webpBad, badRiff, badChunk, badPad, animated, trailing] },
  ];
  const pixels = 16_777_216;
  let nearest = Infinity;
  for (let width = 1; width <= 8192; width++) {
    const height = Math.floor(pixels / width) + 1;
    if (height <= 8192) nearest = Math.min(nearest, width * height);
  }
  assert.equal(nearest, 2113 * 7940);
  const output = join(root, "trial");
  for (const { type, make, positive = [], invalid } of cases) {
    /** @type {[Buffer, boolean][]} */
    const specimens = [
      ...[[8192, 1], [1, 8192], [4096, 4096]].map(([w = 0, h = 0]) => /** @type {[Buffer, boolean]} */ ([make(w, h), true])),
      ...[[0, 1], [1, 0], [8193, 1], [1, 8193], [2113, 7940]].map(([w = 0, h = 0]) => /** @type {[Buffer, boolean]} */ ([make(w, h), false])),
      ...positive.map((bytes) => /** @type {[Buffer, boolean]} */ ([bytes, true])),
      ...invalid.map((bytes) => /** @type {[Buffer, boolean]} */ ([bytes, false])),
    ];
    for (const [bytes, accepted] of specimens) {
      const sha256 = hash(bytes);
      const input = jsonBytes({ ...snapshot, assets: [{ ...image, mediaType: type, sha256 }] });
      await writeFile(paths.snapshot, input);
      await writeFile(paths.image, bytes);
      const locked = await lockFixture(paths, host);
      if (accepted) {
        assert.equal(locked.status, "ok", type);
      } else {
        refuses(locked, "ASSET_TYPE_MISMATCH", "fixture:image");
        await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
        await writeFile(paths.lock, jsonBytes(createLock({
          ...original.inputs, snapshot: { ...original.inputs.snapshot, sha256: hash(input) },
          assets: [{ path: image.path, sha256 }], toolchain: original.toolchain, options: original.options,
        })));
      }
      const compiled = await runCli(["compile", "--lock", paths.lock, "--out", output], host);
      if (accepted) {
        assert.equal(compiled.status, "ok", type);
        assert.deepEqual(await readFile(join(output, image.path)), bytes);
        await rm(output, { recursive: true });
      } else {
        refuses(compiled, "ASSET_TYPE_MISMATCH", "fixture:image");
        refuses(await compileFixture(paths, host), "ASSET_TYPE_MISMATCH", "fixture:image");
        assert.deepEqual(await tree(paths.output), prior);
        await assert.rejects(lstat(output), { code: "ENOENT" });
      }
      await rm(paths.lock);
    }
  }
  assert.deepEqual(await tree(paths.output), prior);
});

void test("snapshot intake refuses repeated decoded keys", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const snapshot = fixtureSnapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal((await lockFixture(paths, host)).status, "ok");
  await rm(paths.lock);
  const duplicate = serialized.replace('"roots":', String.raw`"\u0072oots":null,"roots":`);
  assert.deepEqual(JSON.parse(duplicate), snapshot);
  assert.notEqual(duplicate, serialized);
  await writeFile(paths.snapshot, duplicate);
  refuses(await lockFixture(paths, host), "INVALID_SNAPSHOT");
  await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
});

void test("production callers read through the acquired directory after relocation", async (t) => {
  for (const route of ["capture-root", "capture-assets", "existing-lock", "verify"]) {
    await t.test(route, async (subtest) => {
      const root = await rootFor(subtest);
      const paths = await writeFixture(root);
      const host = fixtureHost(root);
      if (route === "existing-lock" || route === "verify") {
        assert.equal((await lockFixture(paths, host)).status, "ok");
      }
      if (route === "verify") assert.equal((await compileFixture(paths, host)).status, "ok");
      const assets = route === "capture-assets";
      const target = route === "verify" ? paths.output : assets ? dirname(paths.image) : paths.capture;
      const name = route === "verify" ? MANIFEST_NAME
        : route === "existing-lock" ? "build.lock.json" : assets ? "a.png" : "snapshot.json";
      const relocated = join(root, "original");
      const original = await readFile(join(target, name));
      const identity = await lstat(target);
      const args = route === "verify" ? ["verify", "--manifest", paths.manifest]
        : lockArgs(paths);
      /** @type {object | undefined} */
      let held;
      let reads = 0;
      /** @param {object} acquired */
      function relocate(acquired) {
        assert.equal(held, undefined, "a replacement directory must never be opened");
        held = acquired;
        renameSync(target, relocated);
        mkdirSync(target);
        writeFileSync(join(target, name), "separate fixture bytes");
        const moved = lstatSync(relocated);
        const replacement = lstatSync(target);
        assert.equal(moved.ino, identity.ino);
        assert.equal(moved.dev, identity.dev);
        assert.equal(replacement.dev, identity.dev);
        assert.notEqual(replacement.ino, identity.ino);
      }

      const result = await runObservedCli((fs) => {
        return forwardFs(fs, {
          openRoot(path) {
            const acquired = fs.openRoot(path);
            if (!assets && path === target) relocate(acquired);
            return acquired;
          },
          openDirectory(parent, component) {
            const acquired = fs.openDirectory(parent, component);
            if (assets && component === "assets") relocate(acquired);
            return acquired;
          },
          readFile(parent, component, limit) {
            const bytes = fs.readFile(parent, component, limit);
            if (component === name) {
              assert.equal(parent, held);
              assert.deepEqual(bytes, original);
              reads++;
            }
            return bytes;
          },
        });
      }, args, host);
      assert.equal(result.status, "ok");
      assert.equal(reads, 1);
      assert.deepEqual(await readFile(join(relocated, name)), original);
      assert.equal(await readFile(join(target, name), "utf8"), "separate fixture bytes");
      if (route !== "verify") await assert.rejects(lstat(paths.output), { code: "ENOENT" });
    });
  }
});

void test("production capture, existing lock and verify refuse independent idle FIFOs", async (t) => {
  const cases = [
    { file: "image", code: "MISSING_DEPENDENCY", sourceRef: "fixture:image" },
    { file: "lock", code: "INVALID_LOCK", sourceRef: null },
    { file: "manifest", code: "OUTPUT_DRIFT", sourceRef: null },
  ];
  for (const { file, code, sourceRef } of cases) {
    await t.test(file, async (subtest) => {
      const root = await rootFor(subtest);
      const paths = await writeFixture(root);
      const verifies = file === "manifest";
      const target = file === "image" ? paths.image : verifies ? paths.manifest : paths.lock;
      if (verifies) await mkdir(paths.output);
      if (file === "image") await rm(target);
      const fifo = spawn("/usr/bin/mkfifo", [target], { stdio: "ignore" });
      /** @type {unknown} */
      const created = await once(fifo, "close");
      assert.deepEqual(created, [0, null]);
      assert.ok((await lstat(target)).isFIFO());
      const args = verifies ? ["verify", "--manifest", target]
        : lockArgs(paths);
      const result = await runIsolatedCli(root, args);
      assert.deepEqual(result, { status: "error", diagnostics: [{ code, severity: "error", sourceRef }] });
      assert.ok((await lstat(target)).isFIFO());
      if (file === "image") await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
    });
  }
});

void test("writer refuses manifest drift before body reads and unexplained directories before descent", async (t) => {
  const root = await rootFor(t);
  const destination = join(root, "site");
  const fs = loadSecureFs();
  const identity = fixtureHost(root).writer;
  const leaf = { path: "a.txt", mediaType: "text/plain", bytes: Buffer.from("a") };
  await publishOutput(destination, root, [leaf], identity, fs);
  const manifest = join(destination, MANIFEST_NAME);
  const original = await readFile(manifest);
  /** @type {string[]} */
  const reads = [];
  let visits = 0;
  let unexpectedOpens = 0;
  /** @type {typeof fs} */
  const monitored = forwardFs(fs, {
    openDirectory(dir, name) {
      if (name === "unexplained") unexpectedOpens++;
      return fs.openDirectory(dir, name);
    },
    /** @type {typeof fs.readFile} */
    readFile(dir, name, limit) {
      reads.push(name);
      return fs.readFile(dir, name, limit);
    },
    /** @type {typeof fs.visit} */
    visit(dir, use) {
      visits++;
      fs.visit(dir, use);
    },
  });
  await assert.rejects(publishOutput(destination, root, [{ ...leaf, bytes: Buffer.from("b") }], identity, monitored),
    { message: "OUTPUT_DRIFT" });
  assert.deepEqual(reads, [MANIFEST_NAME]);
  assert.equal(visits, 0);

  await mkdir(join(destination, "unexplained"));
  await writeFile(join(destination, "unexplained", "child"), "untouched");
  const empty = join(destination, "unexplained", "empty");
  for (let index = 0; index < 96; index++) {
    await mkdir(join(empty, String(index), "leaf"), { recursive: true });
  }
  const before = await tree(destination);
  await assert.rejects(publishOutput(destination, root, [leaf], identity, monitored), { message: "OUTPUT_DRIFT" });
  assert.equal(visits, 2);
  visits = 0;
  await assert.rejects(verifyOutput(manifest, monitored), { message: "OUTPUT_DRIFT" });
  assert.equal(visits, 1);
  assert.equal(unexpectedOpens, 0);
  assert.deepEqual(await tree(destination), before);
  assert.deepEqual(await readFile(manifest), original);
  assert.equal(await readFile(join(destination, "unexplained", "child"), "utf8"), "untouched");
});

/**
 * @param {ReturnType<typeof loadSecureFs>} fs
 * @param {string[]} mutations
 */
function watchWrites(fs, mutations) {
  return forwardFs(fs, {
    createDirectory(parent, name) {
      mutations.push(name);
      fs.createDirectory(parent, name);
    },
    createLockStage(parent) {
      mutations.push("lock-stage");
      return fs.createLockStage(parent);
    },
    writeFile(parent, name, bytes) {
      mutations.push(name);
      fs.writeFile(parent, name, bytes);
    },
    renameExclusive(from, name, to, destination) {
      mutations.push(destination);
      fs.renameExclusive(from, name, to, destination);
    },
    unlinkEntry(parent, name, directory) {
      mutations.push(name);
      fs.unlinkEntry(parent, name, directory);
    },
  });
}

void test("CLI rejects existing aliases and illegal paths before mutation", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  assert.equal((await lockFixture(paths, host)).status, "ok");
  assert.equal((await compileFixture(paths, host)).status, "ok");
  await writeFile(join(paths.capture, "asset.json"), png);
  const snapshot = fixtureSnapshot();
  const image = snapshot.roots[0]?.children[1];
  const asset = snapshot.assets[0];
  assert.ok(image && asset);
  image.asset = "asset.json";
  await writeFile(paths.snapshot, jsonBytes({ ...snapshot, assets: [{ ...asset, path: "asset.json" }] }));
  const before = await tree(root);
  const alias = join(paths.capture, "BUILD.lock.json");
  const existing = await lstat(paths.lock);
  const aliasStat = await lstat(alias);
  assert.equal(aliasStat.dev, existing.dev);
  assert.equal(aliasStat.ino, existing.ino);
  // Supply identical requested bytes for the stored-spelling check below.
  /** @type {string[]} */
  const writes = [];
  /** @param {ReturnType<typeof loadSecureFs>} fs */
  const observe = (fs) => watchWrites(fs, writes);
  for (const name of ["snapshot.json", "Snapshot.json", "overlay.json", "OVERLAY.json", "asset.json", "ASSET.json",
    ".AiK-guard.json", "-bad.json", "a@b.json", "_bad.json", "assets/nested.json", "BUILD.lock.json"]) {
    const requested = join(paths.capture, name);
    refuses(await runObservedCli(observe,
      lockArgs(paths, requested), host), "INVALID_LOCK");
    assert.deepEqual(writes, [], name);
    assert.deepEqual(await tree(root), before, name);
  }
  await writeFile(paths.snapshot, jsonBytes(fixtureSnapshot()));
  const unchanged = await tree(root);
  refuses(await runObservedCli(observe, lockArgs(paths, alias), host),
    "INVALID_LOCK");
  refuses(await runObservedCli(observe, ["compile", "--lock", paths.lock, "--out", join(root, "Site")], host), "OUTPUT_DRIFT");
  refuses(await runObservedCli(observe, ["compile", "--lock", paths.lock, "--out", join(root, ".AiK-guard")], host), "INVALID_OUTPUT");
  assert.deepEqual(writes, []);
  assert.deepEqual(await tree(root), unchanged);
  const positive = join(root, "MiXeD");
  assert.equal((await runObservedCli(observe, ["compile", "--lock", paths.lock, "--out", positive], host)).status, "ok");
  assert.ok((await readdir(root)).includes("MiXeD"));
  const allowedLockName = "bad_.json";
  assert.equal((await runObservedCli(observe, lockArgs(paths, join(paths.capture, allowedLockName)), host)).status, "ok");
  assert.ok((await readdir(paths.capture)).includes(allowedLockName));
});

/** @param {string[]} paths */
const leaves = (paths) => paths.map((path) => ({ path, mediaType: "text/plain", bytes: Buffer.from("text") }));

void test("writer keeps isolated path boundary and folder prefix checks ahead of reservation", async (t) => {
  const root = await rootFor(t);
  const native = loadSecureFs();
  /** @type {string[]} */
  const mutations = [];
  const fs = watchWrites(native, mutations);
  const identity = fixtureHost(root).writer;
  const long = "a".repeat(250) + "/" + "b".repeat(250) + "/c" + "d".repeat(9);
  assert.equal(long.length, 512);
  const deep = Array.from({ length: 32 }, () => "x").join("/");
  await publishOutput(join(root, "Long"), root, leaves([long]), identity, fs);
  await publishOutput(join(root, "Deep"), root, leaves([deep]), identity, fs);
  const before = await tree(root);
  mutations.length = 0;
  for (const files of [[long + "e"], [deep + "/y"], [".AiK-guard"], ["a@b"], ["-a"], ["b_"], ["A/x", "a/y"],
    ["entry", "entry/child"], ["entry/child", "entry"], ["artifact-manifest.json"]]) {
    await assert.rejects(publishOutput(join(root, "invalid"), root, leaves(files), identity, fs), { message: "INVALID_OUTPUT" });
    assert.deepEqual(mutations, [], files.join(", "));
    assert.deepEqual(await tree(root), before);
  }
});

void test("production intake preserves exact admissible path lengths and depth", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const long = "a".repeat(250) + "/" + "b".repeat(250) + "/" + "X".repeat(10);
  const deep = "x/".repeat(31) + "Png";
  for (const { path, accepts } of [
    { path: long, accepts: true }, { path: long + "x", accepts: false },
    { path: deep, accepts: true }, { path: "x/" + deep, accepts: false },
  ]) {
    const file = join(paths.capture, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, png);
    const snapshot = fixtureSnapshot();
    const image = snapshot.roots[0]?.children[1];
    assert.ok(image);
    image.asset = path;
    await writeFile(paths.snapshot, jsonBytes({ ...snapshot, assets: [{ path, sha256: hash(png), mediaType: "image/png" }] }));
    const mutations = /** @type {string[]} */ ([]);
    const result = await runObservedCli((fs) => watchWrites(fs, mutations),
      lockArgs(paths), host);
    if (accepts) {
      assert.equal(result.status, "ok");
      assert.equal(readLock(await readFile(paths.lock)).inputs.assets[0]?.path, path);
      await rm(paths.lock);
    } else {
      refuses(result, "INVALID_SNAPSHOT");
      assert.deepEqual(mutations, []);
      await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
    }
    assert.deepEqual(await readFile(file), png);
  }
});

void test("stage identity and one-link lock hold at the exclusive native rename boundary", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  let renames = 0;
  /** @param {ReturnType<typeof loadSecureFs>} fs */
  const observe = (fs) => {
    /** @type {Map<object, string>} */
    const locations = new Map();
    return forwardFs(fs, {
      openRoot(path) {
        const dir = fs.openRoot(path);
        locations.set(dir, path);
        return dir;
      },
      openDirectory(parent, name) {
        const dir = fs.openDirectory(parent, name);
        const base = locations.get(parent);
        assert.ok(base);
        locations.set(dir, join(base, name));
        return dir;
      },
      openLockStage(parent, token) {
        const stage = fs.openLockStage(parent, token);
        const base = locations.get(parent);
        assert.equal(base, paths.staging);
        const entries = readdirSync(base);
        assert.equal(entries.length, 1);
        const [name] = entries;
        assert.ok(name);
        locations.set(stage, join(base, name));
        return stage;
      },
      renameExclusive(from, name, to, destination) {
        const base = locations.get(from);
        const targetParent = locations.get(to);
        assert.ok(base && targetParent);
        const staged = join(base, name);
        const source = lstatSync(staged);
        const stage = lstatSync(source.isDirectory() ? staged : dirname(staged));
        assert.equal(stage.mode & 0o777, 0o700);
        assert.equal(stage.dev, lstatSync(targetParent).dev);
        if (source.isFile()) assert.equal(source.nlink, 1);
        fs.renameExclusive(from, name, to, destination);
        const published = lstatSync(join(targetParent, destination));
        assert.equal(published.ino, source.ino);
        assert.equal(published.dev, source.dev);
        if (source.isFile()) assert.equal(published.nlink, 1);
        renames++;
      },
    });
  };
  const command = lockArgs(paths);
  assert.equal((await runObservedCli(observe, command, host)).status, "ok");
  assert.equal((await runObservedCli(observe, ["compile", "--lock", paths.lock, "--out", paths.output], host)).status, "ok");
  const prior = await tree(root);
  const inode = (await lstat(paths.lock)).ino;
  assert.equal((await runObservedCli(observe, command, host)).status, "ok");
  refuses(await runObservedCli(observe, [...command, "--naming", "bem"], host), "INVALID_LOCK");
  assert.equal((await lstat(paths.lock)).ino, inode);
  assert.deepEqual(await tree(root), prior);
  assert.equal(renames, 2);
});

void test("late lock contenders are compared after the actual exclusive refusal", async (t) => {
  const root = await rootFor(t);
  const native = loadSecureFs();
  const staging = join(root, "staging");
  await mkdir(staging, { mode: 0o700 });
  const bytes = Buffer.from("canonical fixture");
  for (const exact of [true, false]) {
    const name = exact ? "exact.json" : "different.json";
    const contender = exact ? bytes : Buffer.from("different bytes!!");
    let inode = 0;
    let exclusiveRefusals = 0;
    const observed = forwardFs(native, {
      renameExclusive(from, source, to, destination) {
        assert.equal(destination, name);
        // A cooperating writer publishes its fixture between the two production checks.
        writeFileSync(join(root, name), contender, { flag: "wx" });
        inode = lstatSync(join(root, name)).ino;
        try {
          native.renameExclusive(from, source, to, destination);
        } catch (error) {
          assert.ok(error instanceof Error && "code" in error && error.code === "EEXIST");
          exclusiveRefusals++;
          throw error;
        }
        assert.fail("Exclusive rename changed the existing fixture");
      },
    });
    const request = publishLock(native.openRoot(root), native.openRoot(staging), name, bytes, observed);
    if (exact) await request;
    else await assert.rejects(request, { message: "INVALID_LOCK" });
    assert.equal(exclusiveRefusals, 1);
    assert.equal((await lstat(join(root, name))).ino, inode);
    assert.deepEqual(await readFile(join(root, name)), contender);
    assert.deepEqual(await readdir(staging), []);
  }
});

void test("production APFSX lock path rejects stored aliases and serializes independent publishers", async (t) => {
  const otherVolume = await rootFor(t);
  await onApfsx(async (root) => {
    const paths = await writeFixture(root);
    const host = fixtureHost(root);
    const otherStage = join(root, "second-staging");
    await mkdir(otherStage, { mode: 0o700 });
    const fs = loadSecureFs();
    const capture = fs.openRoot(paths.capture);
    const second = fs.openRoot(paths.capture);
    const guard = fs.acquireLockGuard(capture);
    try {
      assert.throws(() => fs.acquireLockGuard(second), { code: "EAGAIN" });
      assert.deepEqual(await runIsolatedCli(root, lockArgs(paths, join(paths.capture, "Build.lock.json"), otherStage)),
        { status: "error", diagnostics: [{ code: "OUTPUT_BUSY", severity: "error", sourceRef: null }] });
      await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
      assert.deepEqual(await readdir(paths.staging), []);
      assert.deepEqual(await readdir(otherStage), []);
    } finally {
      fs.closeDirectory(second);
      fs.closeDirectory(capture);
      fs.closeDirectory(guard);
    }

    const alias = join(paths.capture, "BUILD.lock.json");
    const writes = /** @type {string[]} */ ([]);
    /** @param {ReturnType<typeof loadSecureFs>} native */
    const observe = (native) => watchWrites(native, writes);
    await writeFile(alias, "alternate fixture", { flag: "wx" });
    const alternate = await lstat(alias);
    const alone = await tree(paths.capture);
    refuses(await runObservedCli(observe, lockArgs(paths), host), "INVALID_LOCK");
    assert.deepEqual(writes, []);
    assert.deepEqual(await tree(paths.capture), alone);
    await rm(alias);

    const first = await runIsolatedCli(root, lockArgs(paths));
    assert.ok(first && typeof first === "object" && "status" in first && first.status === "ok");
    const canonical = await readFile(paths.lock);
    const published = await lstat(paths.lock);
    assert.equal(published.nlink, 1);
    assert.equal(published.dev, (await lstat(paths.staging)).dev);
    assert.notEqual(published.dev, (await lstat(otherVolume)).dev);
    assert.equal((await runObservedCli(observe, lockArgs(paths), host)).status, "ok");
    refuses(await runObservedCli(observe, [...lockArgs(paths), "--naming", "bem"], host), "INVALID_LOCK");

    await writeFile(alias, canonical, { flag: "wx" });
    const parallel = await lstat(alias);
    assert.notEqual(parallel.ino, published.ino);
    assert.equal(parallel.nlink, 1);
    assert.equal(alternate.dev, parallel.dev);
    const both = await tree(paths.capture);
    refuses(await runObservedCli(observe, lockArgs(paths), host), "INVALID_LOCK");
    assert.deepEqual(await tree(paths.capture), both);
    assert.deepEqual(writes, []);
    await rm(alias);
    assert.equal((await lstat(paths.lock)).ino, published.ino);
    assert.deepEqual(await readFile(paths.lock), canonical);
    const late = join(paths.capture, "late.json");
    const lateAlias = join(paths.capture, "LATE.json");
    let refused = 0;
    refuses(await runObservedCli((native) => forwardFs(native, {
      renameExclusive(from, source, to, name) {
        writeFileSync(late, canonical, { flag: "wx" });
        writeFileSync(lateAlias, canonical, { flag: "wx" });
        try {
          native.renameExclusive(from, source, to, name);
        } catch (error) {
          assert.ok(error instanceof Error && "code" in error && error.code === "EEXIST");
          refused++;
          throw error;
        }
        assert.fail("Exclusive rename changed the existing fixture");
      },
    }), lockArgs(paths, late), host), "INVALID_LOCK");
    assert.equal(refused, 1);
    assert.notEqual((await lstat(late)).ino, (await lstat(lateAlias)).ino);
    assert.deepEqual(await readFile(late), canonical);
    assert.deepEqual(await readFile(lateAlias), canonical);
    assert.deepEqual(await readdir(paths.staging), []);
    const crossVolume = join(otherVolume, "staging");
    await mkdir(crossVolume, { mode: 0o700 });
    refuses(await runObservedCli(observe, lockArgs(paths, paths.lock, crossVolume), host), "INVALID_LOCK");
    assert.deepEqual(writes, []);
  });
  await onApfsx(async (root) => {
    const paths = await writeFixture(root);
    const writes = /** @type {string[]} */ ([]);
    refuses(await runObservedCli((fs) => watchWrites(fs, writes), lockArgs(paths), fixtureHost(root)), "INVALID_LOCK");
    assert.deepEqual(writes, []);
    assert.deepEqual(await readdir(paths.staging), []);
  }, "off");
});

void test("staging trust and native capability query fail before all publication writes", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const fs = loadSecureFs();
  const writes = /** @type {string[]} */ ([]);
  let guards = 0;
  /** @param {ReturnType<typeof loadSecureFs>} native */
  const observe = (native) => watchWrites(forwardFs(native, {
    acquireLockGuard(capture) {
      guards++;
      return native.acquireLockGuard(capture);
    },
  }), writes);
  const alias = join(root, "stage-link");
  await symlink(paths.staging, alias);
  for (const args of [lockArgs(paths).slice(0, -2), lockArgs(paths, paths.lock, "relative"),
    lockArgs(paths, paths.lock, paths.staging + "\0")]) {
    refuses(await runObservedCli(observe, args, host), "INVALID_ARGUMENTS");
  }
  for (const stage of [paths.capture, alias, join(root, "absent")]) {
    refuses(await runObservedCli(observe, lockArgs(paths, paths.lock, stage), host), "INVALID_LOCK");
  }
  await chmod(paths.staging, 0o750);
  refuses(await runObservedCli(observe, lockArgs(paths), host), "INVALID_LOCK");
  await chmod(paths.staging, 0o700);
  execFileSync("/bin/chmod", ["+a", userInfo().username + " allow list", paths.staging]);
  refuses(await runObservedCli(observe, lockArgs(paths), host), "INVALID_LOCK");
  execFileSync("/bin/chmod", ["-N", paths.staging]);

  const probe = await buildQualificationProbe(root, fs);
  const faultName = "AIK_TEST_QUALIFICATION_FAULT";
  const previous = process.env[faultName];
  try {
    for (const fault of ["clear", "invalid", "short", "query", "acl", "acl-unsupported"]) {
      process.env[faultName] = fault;
      refuses(await runObservedCli(() => observe(probe), lockArgs(paths), host),
        fault === "acl" ? "IO_ERROR" : "UNSUPPORTED_HOST");
      assert.equal(guards, 0, fault);
      assert.deepEqual(writes, [], fault);
      await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
      assert.deepEqual(await readdir(paths.staging), []);
    }
    process.env[faultName] = "empty-acl";
    assert.equal((await runObservedCli(() => observe(probe), lockArgs(paths), host)).status, "ok");
    assert.equal(guards, 1);
  } finally {
    if (previous === undefined) delete process.env[faultName];
    else process.env[faultName] = previous;
  }
  assert.equal((await lstat(paths.lock)).nlink, 1);
  assert.deepEqual(await readdir(paths.staging), []);
});

void test("lock publication uses held capture and staging descriptors after separate moves", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const captured = join(root, "moved-capture");
  const staged = join(root, "moved-staging");
  assert.equal((await runObservedCli((fs) => forwardFs(fs, {
    qualifyLockStaging(capture, parent) {
      fs.qualifyLockStaging(capture, parent);
      for (const [from, to] of [[paths.capture, captured], [paths.staging, staged]]) {
        assert.ok(from && to);
        renameSync(from, to);
        mkdirSync(from, { mode: 0o700 });
        writeFileSync(join(from, "untouched"), to);
      }
    },
  }), lockArgs(paths), fixtureHost(root))).status, "ok");
  for (const [current, moved] of [[paths.capture, captured], [paths.staging, staged]]) {
    assert.ok(current && moved);
    assert.deepEqual(await readdir(current), ["untouched"]);
    assert.equal(await readFile(join(current, "untouched"), "utf8"), moved);
  }
  const file = await lstat(join(captured, "build.lock.json"));
  assert.equal(file.nlink, 1);
  assert.ok(file.size > 0);
  assert.deepEqual(await readdir(staged), []);
});

/** @param {string} feature @param {"error" | "warning"} [severity] */
function lockCleanupDiagnostic(feature, severity = "warning") {
  return { code: "IO_ERROR", severity, feature, sourceRef: null };
}

void test("lock cleanup preserves primary failure, held identities and a published lock", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const problem = new Error("fixture failure");
  for (const operation of ["createLockStage", "openLockStage"]) {
    refuses(await runObservedCli((fs) => forwardFs(fs, { [operation]: () => { throw problem; } }),
      lockArgs(paths), host), "IO_ERROR");
    assert.deepEqual(await readdir(paths.staging), [], operation);
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  }
  const closes = /** @type {string[]} */ ([]);
  const ordered = await runObservedCli((fs) => {
    const order = /** @type {Map<object, string>} */ (new Map());
    return forwardFs(fs, {
      openRoot(path) {
        const handle = fs.openRoot(path);
        order.set(handle, path === paths.staging ? "lock-staging-parent-close" : "lock-capture-close");
        return handle;
      },
      acquireLockGuard(capture) {
        const guard = fs.acquireLockGuard(capture);
        order.set(guard, "lock-guard-release");
        return guard;
      },
      openLockStage(parent, token) {
        const stage = fs.openLockStage(parent, token);
        order.set(stage, "lock-stage-close");
        return stage;
      },
      writeFile() { throw problem; },
      unlinkEntry() { throw problem; },
      removeLockStage() { throw problem; },
      closeDirectory(handle) {
        fs.closeDirectory(handle);
        const feature = order.get(handle);
        if (feature) {
          closes.push(feature);
          throw problem;
        }
      },
    });
  }, lockArgs(paths), host);
  assert.deepEqual(ordered, { status: "error", diagnostics: [
    { code: "IO_ERROR", severity: "error", sourceRef: null }, lockCleanupDiagnostic("lock-stage-file-remove"),
    lockCleanupDiagnostic("lock-stage-directory-remove"), lockCleanupDiagnostic("lock-stage-close"), lockCleanupDiagnostic("lock-staging-parent-close"),
    lockCleanupDiagnostic("lock-capture-close"), lockCleanupDiagnostic("lock-guard-release"),
  ] });
  assert.deepEqual(closes, ["lock-stage-close", "lock-staging-parent-close", "lock-capture-close", "lock-guard-release"]);
  const residual = await readdir(paths.staging);
  assert.equal(residual.length, 1);
  assert.ok(residual[0]);
  await rm(join(paths.staging, residual[0]), { recursive: true });

  /** @type {string | undefined} */
  let observedName;
  const moved = join(paths.staging, "moved-fixture");
  const replacement = await runObservedCli((fs) => forwardFs(fs, {
    openLockStage(parent, token) {
      const [name] = readdirSync(paths.staging);
      assert.ok(name);
      observedName = join(paths.staging, name);
      renameSync(observedName, moved);
      mkdirSync(observedName, { mode: 0o700 });
      return fs.openLockStage(parent, token);
    },
  }), lockArgs(paths), host);
  assert.deepEqual(replacement, { status: "error", diagnostics: [
    { code: "IO_ERROR", severity: "error", sourceRef: null }, lockCleanupDiagnostic("lock-stage-directory-remove"),
  ] });
  assert.ok(observedName);
  assert.ok((await lstat(observedName)).isDirectory());
  assert.ok((await lstat(moved)).isDirectory());
  await rm(observedName, { recursive: true });
  await rm(moved, { recursive: true });

  const published = await runObservedCli((fs) => forwardFs(fs, {
    removeLockStage(parent, token) {
      fs.removeLockStage(parent, token);
      throw problem;
    },
  }), lockArgs(paths), host);
  assert.deepEqual(published, { status: "error", diagnostics: [lockCleanupDiagnostic("lock-stage-directory-remove", "error")] });
  const before = await lstat(paths.lock);
  const bytes = await readFile(paths.lock);
  assert.equal(before.nlink, 1);
  assert.equal((await lockFixture(paths, host)).status, "ok");
  assert.equal((await lstat(paths.lock)).ino, before.ino);
  assert.deepEqual(await readFile(paths.lock), bytes);
  assert.deepEqual(await readdir(paths.staging), []);
});

/**
 * @template Result
 * @param {string} fault
 * @param {string} trace
 * @param {() => Result} use
 * @returns {Result}
 */
function observeTransferFault(fault, trace, use) {
  const faultKey = "AIK_TEST_TRANSFER_FAULT";
  const traceKey = "AIK_TEST_TRANSFER_TRACE";
  const oldFault = process.env[faultKey];
  const oldTrace = process.env[traceKey];
  writeFileSync(trace, "");
  process.env[faultKey] = fault;
  process.env[traceKey] = trace;
  try {
    return use();
  } finally {
    if (oldFault === undefined) delete process.env[faultKey];
    else process.env[faultKey] = oldFault;
    if (oldTrace === undefined) delete process.env[traceKey];
    else process.env[traceKey] = oldTrace;
  }
}

void test("native lock reads distinguish operational faults on both exact comparison routes", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const native = loadSecureFs();
  assert.equal((await lockFixture(paths, host)).status, "ok");
  const bytes = await readFile(paths.lock);
  await rm(paths.lock);
  const probe = await buildQualificationProbe(root, native);
  const trace = join(root, "transfer-trace.txt");
  const cases = [
    { fault: "initial-stat", nativeCode: "EIO", result: "IO_ERROR", trace: "1,0,0;" },
    { fault: "final-stat", nativeCode: "EIO", result: "IO_ERROR", trace: "2,0,0;" },
    { fault: "read-error", nativeCode: "EIO", result: "IO_ERROR", trace: "1,0,0;" },
    { fault: "close", nativeCode: "EIO", result: "IO_ERROR", trace: "2,0,0;" },
    { fault: "read-close", nativeCode: "EIO", result: "IO_ERROR", trace: "1,0,0;" },
    { fault: "early-eof", nativeCode: "INVALID_FILE", result: "INVALID_LOCK", trace: "1,0,0;" },
    { fault: "unstable", nativeCode: "INVALID_FILE", result: "INVALID_LOCK", trace: "2,0,0;" },
    { fault: "short-read", nativeCode: null, result: null, trace: "2,2,0;" },
  ];
  for (const late of [false, true]) {
    for (const current of cases) {
      /** @type {Awaited<ReturnType<typeof lstat>> | undefined} */
      let contender;
      if (!late) {
        await writeFile(paths.lock, bytes, { flag: "wx" });
        contender = await lstat(paths.lock);
      }
      /** @type {unknown} */
      let nativeCode = null;
      let comparisons = 0;
      let exclusiveRefusals = 0;
      const events = /** @type {string[]} */ ([]);
      const handles = /** @type {Map<object, string>} */ (new Map());
      const result = await runObservedCli(() => forwardFs(probe, {
        openRoot(path) {
          const dir = probe.openRoot(path);
          handles.set(dir, path === paths.staging ? "staging-parent-close" : "capture-close");
          return dir;
        },
        acquireLockGuard(capture) {
          const guard = probe.acquireLockGuard(capture);
          handles.set(guard, "guard-release");
          return guard;
        },
        createLockStage(parent) {
          events.push("stage-create");
          return probe.createLockStage(parent);
        },
        openLockStage(parent, token) {
          const stage = probe.openLockStage(parent, token);
          handles.set(stage, "stage-close");
          return stage;
        },
        writeFile(parent, name, body) {
          events.push("stage-write");
          probe.writeFile(parent, name, body);
        },
        renameExclusive(from, source, to, name) {
          events.push("exclusive-rename");
          writeFileSync(paths.lock, bytes, { flag: "wx" });
          contender = lstatSync(paths.lock);
          try {
            probe.renameExclusive(from, source, to, name);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") exclusiveRefusals++;
            throw error;
          }
        },
        readFile(parent, name, limit, compare) {
          if (!compare) return probe.readFile(parent, name, limit);
          comparisons++;
          try {
            return observeTransferFault(current.fault, trace, () => probe.readFile(parent, name, limit, true));
          } catch (error) {
            nativeCode = error instanceof Error && "code" in error ? error.code : undefined;
            throw error;
          }
        },
        unlinkEntry(parent, name, directory) {
          events.push("stage-file-remove");
          probe.unlinkEntry(parent, name, directory);
        },
        removeLockStage(parent, token) {
          events.push("stage-directory-remove");
          probe.removeLockStage(parent, token);
        },
        closeDirectory(handle) {
          const event = handles.get(handle);
          if (event) events.push(event);
          probe.closeDirectory(handle);
        },
      }), lockArgs(paths), host);
      if (current.result) refuses(result, current.result);
      else assert.equal(result.status, "ok");
      assert.equal(comparisons, 1);
      assert.equal(nativeCode, current.nativeCode);
      assert.equal(await readFile(trace, "utf8"), current.trace);
      assert.equal(exclusiveRefusals, Number(late));
      assert.deepEqual(events, [
        ...(late ? ["stage-create", "stage-write", "exclusive-rename", "stage-file-remove", "stage-directory-remove", "stage-close"] : []),
        "staging-parent-close", "capture-close", "guard-release",
      ]);
      assert.ok(contender);
      const unchanged = await lstat(paths.lock);
      assert.equal(unchanged.ino, contender.ino);
      assert.equal(unchanged.dev, contender.dev);
      assert.equal(unchanged.nlink, 1);
      assert.deepEqual(await readFile(paths.lock), bytes);
      assert.ok((await readdir(paths.capture)).includes("build.lock.json"));
      assert.deepEqual(await readdir(paths.staging), []);
      assert.equal((await lockFixture(paths, host)).status, "ok");
      assert.equal((await lstat(paths.lock)).ino, unchanged.ino);
      await rm(paths.lock);
    }
  }
  const writes = /** @type {string[]} */ ([]);
  await mkdir(paths.lock);
  refuses(await runObservedCli((fs) => watchWrites(fs, writes), lockArgs(paths), host), "INVALID_LOCK");
  await rm(paths.lock, { recursive: true });
  for (const size of [bytes.length, bytes.length + 1]) {
    const other = Buffer.alloc(size);
    await writeFile(paths.lock, other);
    refuses(await runObservedCli((fs) => watchWrites(fs, writes), lockArgs(paths), host), "INVALID_LOCK");
    assert.deepEqual(await readFile(paths.lock), other);
  }
  assert.deepEqual(writes, []);
});

void test("native transfer preserves capture, verify and write behavior with close faults and partial writes", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const probe = await buildQualificationProbe(root, loadSecureFs());
  const trace = join(root, "transfer-trace.txt");
  /** @param {string} selected */
  const readClose = (selected) => forwardFs(probe, {
    readFile(parent, name, limit, compare) {
      if (name !== selected) return probe.readFile(parent, name, limit, compare ?? false);
      assert.equal(compare, undefined);
      return observeTransferFault("close", trace, () => probe.readFile(parent, name, limit));
    },
  });
  assert.equal((await runObservedCli(() => readClose("snapshot.json"), lockArgs(paths), host)).status, "ok");
  assert.equal(await readFile(trace, "utf8"), "2,0,0;");
  assert.equal((await compileFixture(paths, host)).status, "ok");
  assert.equal((await runObservedCli(() => readClose(MANIFEST_NAME), ["verify", "--manifest", paths.manifest], host)).status, "ok");
  assert.equal(await readFile(trace, "utf8"), "2,0,0;");
  const expected = await readFile(paths.lock);
  await rm(paths.lock);

  /** @param {string} fault */
  const writeFault = (fault) => forwardFs(probe, {
    writeFile(parent, name, bytes) {
      observeTransferFault(fault, trace, () => probe.writeFile(parent, name, bytes));
    },
  });
  refuses(await runObservedCli(() => writeFault("close"), lockArgs(paths), host), "IO_ERROR");
  assert.equal(await readFile(trace, "utf8"), "0,0,0;");
  await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  assert.deepEqual(await readdir(paths.staging), []);
  assert.equal((await runObservedCli(() => writeFault("short-write"), lockArgs(paths), host)).status, "ok");
  assert.equal(await readFile(trace, "utf8"), "0,0,2;");
  assert.deepEqual(await readFile(paths.lock), expected);
  assert.deepEqual(await readdir(paths.staging), []);
});

void test("native lock scan stops on the first excess entry and preserves an exact retry at capacity", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const occupied = (await readdir(paths.capture)).length;
  const limit = 4096;
  for (let start = occupied; start < limit - 1; start += 32) {
    const count = Math.min(32, limit - 1 - start);
    await Promise.all(Array.from({ length: count }, (_, index) =>
      writeFile(join(paths.capture, "entry-" + String(start + index)), "")));
  }
  assert.equal((await readdir(paths.capture)).length, limit - 1);
  const scans = /** @type {number[]} */ ([]);
  const writes = /** @type {string[]} */ ([]);
  /** @param {ReturnType<typeof loadSecureFs>} fs */
  const observe = (fs) => watchWrites(forwardFs(fs, {
    visit(parent, use, maxEntries) {
      assert.equal(maxEntries, limit);
      let seen = 0;
      try {
        fs.visit(parent, (name) => {
          seen++;
          use(name);
        }, maxEntries);
      } finally {
        scans.push(seen);
      }
    },
  }), writes);
  const initial = await runObservedCli(observe, lockArgs(paths), host);
  assert.equal(initial.status, "ok");
  assert.deepEqual(scans.splice(0), [limit - 1]);
  assert.equal((await readdir(paths.capture)).length, limit);
  writes.length = 0;
  const inode = (await lstat(paths.lock)).ino;
  const bytes = await readFile(paths.lock);

  assert.equal((await runObservedCli(observe, lockArgs(paths), host)).status, "ok");
  assert.deepEqual(scans.splice(0), [limit, limit]);
  refuses(await runObservedCli(observe, lockArgs(paths, join(paths.capture, "absent.json")), host), "INVALID_LOCK");
  assert.deepEqual(scans.splice(0), [limit]);

  const extra = join(paths.capture, "first-excess-entry");
  await writeFile(extra, "");
  assert.equal((await readdir(paths.capture)).length, limit + 1);
  refuses(await runObservedCli(observe, lockArgs(paths), host), "INVALID_LOCK");
  assert.deepEqual(scans.splice(0), [limit]);
  assert.deepEqual(writes, []);
  assert.deepEqual(await readdir(paths.staging), []);
  assert.equal((await lstat(paths.lock)).ino, inode);
  assert.deepEqual(await readFile(paths.lock), bytes);
  await rm(extra);
  assert.equal((await lockFixture(paths, host)).status, "ok");
});

void test("lock validates the raw output suffix at the capture boundary before opening paths", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const writes = /** @type {string[]} */ ([]);
  let rootOpens = 0;
  /** @param {ReturnType<typeof loadSecureFs>} native */
  const observe = (native) => watchWrites(forwardFs(native, {
    openRoot() {
      rootOpens++;
      throw new Error("fixture capture is inaccessible");
    },
  }), writes);
  const before = await tree(root);
  const suffixes = ["./build.lock.json", "child/../build.lock.json", ".aik-stage/../build.lock.json",
    "/build.lock.json", "build.lock.json/", ".AiK-lock.json", "../outside.json", "build.lock.json\0"];
  const invalid = [...suffixes.map((suffix) => paths.capture + "/" + suffix), join(root, "outside.json")];
  const bin = fileURLToPath(new URL("../../../packages/cli/src/bin.ts", import.meta.url));
  for (const argument of invalid) {
    const args = lockArgs(paths, argument);
    refuses(await runObservedCli(observe, args, host), "INVALID_LOCK");
    if (!argument.includes("\0")) {
      assert.throws(() => execFileSync(process.execPath, [bin, ...args]), (error) => {
        assert.ok(error instanceof Error && "status" in error && error.status === 1);
        assert.ok("stdout" in error && Buffer.isBuffer(error.stdout));
        const result = /** @type {unknown} */ (JSON.parse(error.stdout.toString("utf8")));
        assert.deepEqual(result, { status: "error", diagnostics: [{ code: "INVALID_LOCK", severity: "error", sourceRef: null }] });
        return true;
      });
    }
  }
  assert.equal(rootOpens, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(await tree(root), before);

  for (const [argument, leaf] of [
    [paths.lock, "build.lock.json"],
    ["./" + relative(process.cwd(), join(paths.capture, "relative.json")), "relative.json"],
    [root + "/prefix/../capture/prefix.json", "prefix.json"],
  ]) {
    assert.ok(argument && leaf);
    const result = await runCli(lockArgs(paths, argument), host);
    assert.ok(result.status === "ok" && "lockPath" in result);
    assert.equal(result.lockPath, leaf);
  }
  const canonical = await readFile(paths.lock);
  assert.deepEqual(await readFile(join(paths.capture, "relative.json")), canonical);
  assert.deepEqual(await readFile(join(paths.capture, "prefix.json")), canonical);
});

void test("late native unsupported rename preserves the primary diagnostic and cleans the private stage", async (t) => {
  const root = await rootFor(t);
  const paths = await writeFixture(root);
  const host = fixtureHost(root);
  const probe = await buildQualificationProbe(root, loadSecureFs());
  const key = "AIK_TEST_RENAME_FAULT";
  const before = await tree(root);
  for (const fault of ["ENOTSUP", "EOPNOTSUPP", "EIO"]) {
    const events = /** @type {string[]} */ ([]);
    const handles = /** @type {Map<object, string>} */ (new Map());
    let readComparisons = 0;
    /** @type {unknown} */
    let nativeCode;
    const oldFault = process.env[key];
    const result = await runObservedCli(() => forwardFs(probe, {
      openRoot(path) {
        const handle = probe.openRoot(path);
        handles.set(handle, path === paths.staging ? "staging-parent-close" : "capture-close");
        return handle;
      },
      qualifyLockStaging(capture, parent) {
        probe.qualifyLockStaging(capture, parent);
        events.push("qualified");
      },
      acquireLockGuard(capture) {
        const guard = probe.acquireLockGuard(capture);
        handles.set(guard, "guard-release");
        return guard;
      },
      openLockStage(parent, token) {
        const stage = probe.openLockStage(parent, token);
        handles.set(stage, "stage-close");
        return stage;
      },
      renameExclusive(source, name, destination, leaf) {
        events.push("exclusive-rename");
        process.env[key] = fault;
        try {
          probe.renameExclusive(source, name, destination, leaf);
        } catch (error) {
          nativeCode = error instanceof Error && "code" in error ? error.code : undefined;
          throw error;
        } finally {
          if (oldFault === undefined) delete process.env[key];
          else process.env[key] = oldFault;
        }
      },
      readFile(parent, name, limit, compare) {
        if (compare) readComparisons++;
        return probe.readFile(parent, name, limit, compare ?? false);
      },
      unlinkEntry(parent, name, directory) {
        events.push("stage-file-remove");
        probe.unlinkEntry(parent, name, directory);
      },
      removeLockStage(parent, token) {
        events.push("stage-directory-remove");
        probe.removeLockStage(parent, token);
      },
      closeDirectory(handle) {
        const event = handles.get(handle);
        if (event) events.push(event);
        probe.closeDirectory(handle);
      },
    }), lockArgs(paths), host);
    assert.equal(nativeCode, fault === "EIO" ? "EIO" : "ENOTSUP");
    refuses(result, fault === "EIO" ? "IO_ERROR" : "UNSUPPORTED_HOST");
    assert.equal(readComparisons, 0);
    assert.deepEqual(events, ["qualified", "exclusive-rename", "stage-file-remove", "stage-directory-remove",
      "stage-close", "staging-parent-close", "capture-close", "guard-release"]);
    assert.deepEqual(await tree(root), before);
  }
  assert.equal((await lockFixture(paths, host)).status, "ok");
  assert.deepEqual(await readdir(paths.staging), []);
});

void test("late site conflict reads only the manifest under reservation and preserves the contender", async (t) => {
  const root = await rootFor(t);
  const destination = join(root, "site");
  const fs = loadSecureFs();
  const bytes = Buffer.from("body");
  const files = [{ path: "a.txt", mediaType: "text/plain", bytes }];
  const manifest = jsonBytes({
    schemaVersion: "aik-artifact-manifest.v1", files: [{ path: "a.txt", mediaType: "text/plain", sha256: hash(bytes) }],
  });
  const competing = Buffer.from(manifest);
  competing[0] = 32;
  /** @type {[string, number][]} */
  const reads = [];
  let reserved = false;
  let insideLookup = false;
  let visits = 0;
  let inode = 0;
  const observer = forwardFs(fs, {
    createDirectory(parent, name) {
      fs.createDirectory(parent, name);
      reserved ||= name.endsWith(".reservation");
    },
    openDirectory(parent, name) {
      if (reserved && name === "site") {
        mkdirSync(destination);
        writeFileSync(join(destination, MANIFEST_NAME), competing);
        writeFileSync(join(destination, "a.txt"), bytes);
        inode = lstatSync(destination).ino;
        insideLookup = true;
      }
      return fs.openDirectory(parent, name);
    },
    visit(parent, use) {
      if (insideLookup) visits++;
      fs.visit(parent, use);
    },
    readFile(parent, name, limit) {
      if (insideLookup) reads.push([name, limit]);
      return fs.readFile(parent, name, limit);
    },
  });
  await assert.rejects(publishOutput(destination, root, files, fixtureHost(root).writer, observer),
    { message: "OUTPUT_DRIFT" });
  assert.ok(insideLookup);
  assert.deepEqual(reads, [[MANIFEST_NAME, manifest.byteLength]]);
  assert.equal(visits, 0);
  assert.deepEqual(await readdir(root), ["site"]);
  assert.equal((await lstat(destination)).ino, inode);
  assert.deepEqual(await tree(destination), [
    { path: "a.txt", type: "file", bytes },
    { path: MANIFEST_NAME, type: "file", bytes: competing },
  ]);
});

void test("staged verification and identical retry bind requested file lengths and reject unexpected descent", async (t) => {
  const root = await rootFor(t);
  const destination = join(root, "site");
  const native = loadSecureFs();
  const identity = fixtureHost(root).writer;
  const file = { path: "folder/a.txt", mediaType: "text/plain", bytes: Buffer.from("fixture") };
  const expected = file.bytes.byteLength;
  /** @type {number[]} */
  const bodyReads = [];
  const monitor = forwardFs(native, {
    readFile(parent, name, limit) {
      if (name === "a.txt") bodyReads.push(limit);
      return native.readFile(parent, name, limit);
    },
  });
  await publishOutput(destination, root, [file], identity, monitor);
  assert.deepEqual(bodyReads, [expected]);
  const previous = await tree(destination);
  await publishOutput(destination, root, [file], identity, monitor);
  assert.deepEqual(bodyReads, [expected, expected, expected]);
  assert.deepEqual(await tree(destination), previous);

  for (const wrong of [Buffer.from("changed"), Buffer.from("short")]) {
    const mismatch = forwardFs(native, {
      readFile(parent, name, limit) {
        if (name === "a.txt") {
          assert.equal(limit, expected);
          return wrong;
        }
        return native.readFile(parent, name, limit);
      },
    });
    await assert.rejects(publishOutput(destination, root, [file], identity, mismatch), { message: "OUTPUT_DRIFT" });
    assert.deepEqual(await tree(destination), previous);
  }

  const stagedDestination = join(root, "staged");
  let stagedPath = "";
  let renames = 0;
  let unexpectedOpens = 0;
  const staged = forwardFs(native, {
    createDirectory(parent, name) {
      native.createDirectory(parent, name);
      if (name.endsWith(".stage")) stagedPath = join(root, name);
    },
    writeFile(parent, name, data) {
      native.writeFile(parent, name, data);
      if (name === MANIFEST_NAME) {
        mkdirSync(join(stagedPath, "unexpected"));
        writeFileSync(join(stagedPath, "unexpected", "child"), "fixture");
      }
    },
    openDirectory(parent, name) {
      if (name === "unexpected") unexpectedOpens++;
      return native.openDirectory(parent, name);
    },
    renameExclusive(from, name, to, target) {
      renames++;
      native.renameExclusive(from, name, to, target);
    },
  });
  await assert.rejects(publishOutput(stagedDestination, root, [file], identity, staged), { message: "OUTPUT_DRIFT" });
  assert.equal(unexpectedOpens, 0);
  assert.equal(renames, 0);
  await assert.rejects(lstat(stagedDestination), { code: "ENOENT" });
  assert.deepEqual(await tree(destination), previous);
});

/**
 * @param {{ path: string, bytes: Buffer, mediaType: string }[]} files
 * @param {[string, number][]} caps
 */
function virtualVerification(files, caps) {
  const root = { path: "" };
  const data = new Map(files.map((file) => [file.path, file.bytes]));
  data.set(MANIFEST_NAME, Buffer.from(jsonBytes({
    schemaVersion: "aik-artifact-manifest.v1",
    files: files.map(({ path, bytes, mediaType }) => ({ path, sha256: hash(bytes), mediaType })),
  })));
  /** @type {Map<string, Set<string>>} */
  const children = new Map();
  for (const path of data.keys()) {
    let prefix = "";
    for (const name of path.split("/")) {
      let entries = children.get(prefix);
      if (entries === undefined) {
        entries = new Set();
        children.set(prefix, entries);
      }
      entries.add(name);
      prefix = prefix ? prefix + "/" + name : name;
    }
  }
  /** @type {Map<object, string>} */
  const directories = new Map([[root, ""]]);
  /** @param {object} parent @param {string} name */
  function qualified(parent, name) {
    const path = directories.get(parent);
    assert.notEqual(path, undefined);
    return path ? path + "/" + name : name;
  }
  return forwardFs(loadSecureFs(), {
    openRoot: () => root,
    openDirectory(parent, name) {
      const path = qualified(parent, name);
      assert.ok(children.has(path));
      const child = { path };
      directories.set(child, path);
      return child;
    },
    closeDirectory(parent) {
      directories.delete(parent);
    },
    readFile(parent, name, limit) {
      const path = qualified(parent, name);
      caps.push([path, limit]);
      const body = data.get(path);
      assert.ok(body);
      if (body.byteLength > limit) throw Object.assign(new Error("Fixture length exceeds requested read"), { code: "EFBIG" });
      return body;
    },
    visit(parent, use) {
      const path = directories.get(parent);
      assert.notEqual(path, undefined);
      for (const name of children.get(path ?? "") ?? []) use(name);
    },
  });
}

void test("verification and publication enforce exact output budgets and the first excess", async (t) => {
  const manifestPath = "/fixture/site/" + MANIFEST_NAME;
  const vanilla = { bytes: Buffer.from("fixture"), mediaType: "text/plain" };
  /** @type {[string, number][]} */
  const caps = [];
  /** @param {Parameters<typeof virtualVerification>[0]} files */
  const verify = (files) => {
    caps.length = 0;
    return verifyOutput(manifestPath, virtualVerification(files, caps));
  };
  const wide = Array.from({ length: 4097 }, (_, index) => ({ path: "f" + String(index).padStart(4, "0"), ...vanilla }));
  assert.equal((await verify(wide.slice(0, -1))).files.length, 4096);
  await assert.rejects(verify(wide), { message: "OUTPUT_DRIFT" });
  assert.deepEqual(caps, [[MANIFEST_NAME, 4 * MB]]);

  const path = Array.from({ length: 32 }, () => "x").join("/");
  assert.equal((await verify([{ path, ...vanilla }])).files.length, 1);
  await assert.rejects(verify([{ path: path + "/x", ...vanilla }]), { message: "OUTPUT_DRIFT" });
  assert.equal(caps.length, 1);

  const full = Buffer.alloc(32 * MB);
  const large = [{ ...vanilla, path: "a", bytes: full }, { ...vanilla, path: "b", bytes: full }];
  const zero = { ...vanilla, path: "c", bytes: Buffer.alloc(0) };
  await verify([...large, zero]);
  assert.deepEqual(caps, [[MANIFEST_NAME, 4 * MB], ["a", 32 * MB], ["b", 32 * MB], ["c", 0]]);
  await assert.rejects(verify([...large, { ...zero, bytes: Buffer.of(1) }]), { message: "OUTPUT_DRIFT" });
  assert.deepEqual(caps, [[MANIFEST_NAME, 4 * MB], ["a", 32 * MB], ["b", 32 * MB], ["c", 0]]);
  await assert.rejects(verify([{ ...large[0], ...vanilla, path: "a", bytes: Buffer.alloc(32 * MB + 1) }]),
    { message: "OUTPUT_DRIFT" });
  assert.deepEqual(caps, [[MANIFEST_NAME, 4 * MB], ["a", 32 * MB]]);

  const entry = { path: "a.txt", ...vanilla };
  const length = jsonBytes({ schemaVersion: "aik-artifact-manifest.v1",
    files: [{ path: entry.path, mediaType: entry.mediaType, sha256: hash(entry.bytes) }] }).byteLength;
  const mediaType = entry.mediaType + "a".repeat(4 * MB - length);
  await verify([{ ...entry, mediaType }]);
  await assert.rejects(verify([{ ...entry, mediaType: mediaType + "a" }]), { message: "OUTPUT_DRIFT" });
  assert.deepEqual(caps, [[MANIFEST_NAME, 4 * MB]]);

  const root = await rootFor(t);
  const destination = join(root, "site");
  const fs = loadSecureFs();
  const identity = fixtureHost(root).writer;
  const oversized = Buffer.alloc(32 * MB + 1);
  const boundaryPairs = [
    [wide.slice(0, -1), wide],
    [[{ path, ...vanilla }], [{ path: path + "/x", ...vanilla }]],
    [[...large, zero], [...large, { ...zero, bytes: Buffer.of(1) }]],
    [[{ ...entry, mediaType }], [{ ...entry, mediaType: mediaType + "a" }]],
    [[{ ...entry, bytes: full }], [{ ...entry, bytes: oversized }]],
  ];
  for (const [pass, fail] of boundaryPairs) {
    assert.ok(pass && fail);
    const manifest = await publishOutput(destination, root, pass, identity, fs);
    assert.deepEqual(await verifyOutput(join(destination, MANIFEST_NAME), fs), manifest);
    const before = await lstat(destination);
    const mutations = /** @type {string[]} */ ([]);
    await assert.rejects(publishOutput(destination, root, fail, identity, watchWrites(fs, mutations)),
      { message: "INVALID_OUTPUT" });
    assert.deepEqual(mutations, []);
    assert.equal((await lstat(destination)).ino, before.ino);
    assert.deepEqual(await verifyOutput(join(destination, MANIFEST_NAME), fs), manifest);
    await rm(destination, { recursive: true });
  }
});
