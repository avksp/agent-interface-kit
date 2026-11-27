import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";
import { crc32, deflateSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import { unzipSync } from "fflate";
import { makeArchive } from "../integrations/figma-exporter/src/archive.ts";
import { limits, record, validatePng } from "../integrations/figma-exporter/src/contract.ts";

const directory = mkdtempSync(join(tmpdir(), "aik-figma-exporter-"));
after(() => rmSync(directory, { recursive: true, force: true }));

/** @param {string} out */
function build(out) {
  execFileSync(process.execPath, [
    "integrations/figma-exporter/src/build.ts", "--plugin-id", "123", "--out", out,
  ]);
}

const first = join(directory, "first");
build(first);
const javascript = readFileSync(join(first, "main.js"), "utf8");
const html = readFileSync(join(first, "ui.html"), "utf8");
const uiScript = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1];
assert.ok(uiScript);

const blue = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgcPgPAAGDAUDj26nXAAAAAElFTkSuQmCC",
  "base64",
);
const color = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
const imagePaint = { type: "IMAGE", scaleMode: "FILL", imageHash: "synthetic" };
const shared = {
  visible: true, opacity: 1, rotation: 0, isMask: false, blendMode: "NORMAL", effects: [], strokes: [],
  reactions: [], effectStyleId: "", fillStyleId: "", strokeStyleId: "", minWidth: null, minHeight: null,
  maxWidth: null, maxHeight: null, layoutPositioning: "AUTO", layoutAlign: "INHERIT", layoutGrow: 0,
  width: 1, height: 1, cornerRadius: 0,
  layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
};

/** @typedef {import("../integrations/figma-exporter/src/contract.ts").Capture} Capture */
/** @typedef {import("../integrations/figma-exporter/src/contract.ts").IssueCode} IssueCode */
/** @typedef {({ kind: "captured"; requestId: number } & Capture) | { kind: "failed"; requestId: number; code: IssueCode }} Response */
/** @typedef {Record<string, unknown> & { id: string; visible: boolean }} Layer */

/** @param {Layer[]} children */
function frame(children = []) {
  return {
    ...shared, type: "FRAME", id: "1:1", parent: { id: "0:1" }, name: "Synthetic export",
    width: 320, height: 100, children, layoutMode: "VERTICAL", layoutWrap: "NO_WRAP", clipsContent: false,
    strokesIncludedInLayout: true, itemReverseZIndex: false, layoutSizingVertical: "HUG",
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", itemSpacing: 8, fills: [],
    paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0,
  };
}

/** @param {string} characters */
function text(characters = "Public  Figma 🌻") {
  return {
    ...shared, type: "TEXT", id: "1:2", name: "One run", characters,
    fontName: { family: "Inter", style: "Regular" }, fontSize: 16, hasMissingFont: false,
    letterSpacing: { unit: "PIXELS", value: 0 }, lineHeight: { unit: "AUTO" },
    textStyleId: "", textDecoration: "NONE", textCase: "ORIGINAL", hyperlink: null,
    textAlignHorizontal: "LEFT", textAlignVertical: "TOP", textAutoResize: "WIDTH_AND_HEIGHT",
    textTruncation: "DISABLED", leadingTrim: "NONE", paragraphIndent: 0, paragraphSpacing: 0, fills: [color],
    getRangeListOptions: () => ({ type: "NONE" }),
  };
}

/** @param {() => Promise<Uint8Array>} exportAsync */
function rectangle(exportAsync = async () => blue) {
  return { ...shared, type: "RECTANGLE", id: "1:3", name: "Photo", fills: [imagePaint], exportAsync };
}

/** @template {object} T @param {T} object */
function trapped(object) {
  return new Proxy(object, {
    get(target, key, receiver) {
      assert.ok(Object.hasOwn(target, key) || key === "boundVariables", "Unexpected host read: " + String(key));
      return Reflect.get(target, key, receiver);
    },
  });
}

/** @param {Layer[]} selection */
function host(selection) {
  const listeners = new Map();
  const page = trapped({ id: "0:1", selection });
  let reads = 0;
  /** @type {Response[]} */
  const replies = [];
  const ui = { onmessage: /** @type {(message: unknown) => void} */ (() => {}), postMessage: (/** @type {Response} */ value) => replies.push(value) };
  runInNewContext(javascript, { __html__: html, Uint8Array, figma: trapped({
    get currentPage() { reads += 1; return page; },
    ui,
    showUI: (/** @type {string} */ markup) => assert.equal(markup, html),
    on: (/** @type {string} */ event, /** @type {() => void} */ callback) => {
      assert.ok(!listeners.has(event));
      listeners.set(event, callback);
    },
    off: (/** @type {string} */ event, /** @type {() => void} */ callback) => {
      assert.equal(listeners.get(event), callback);
      listeners.delete(event);
    },
  }) });
  return {
    reads: () => reads, ui, replies,
    signal: (/** @type {string} */ event) => { listeners.get(event)?.(); },
    pending: () => listeners.size,
  };
}

/** @param {ReturnType<typeof host>} fixture @param {number} requestId @param {string} alt */
async function acquire(fixture, requestId = 1, alt = "Blue square") {
  const index = fixture.replies.length;
  fixture.ui.onmessage({ kind: "capture", requestId, alt: alt.trim() ? "present" : "" });
  await new Promise((resolve) => setImmediate(resolve));
  const response = fixture.replies[index];
  assert.ok(response);
  assert.equal(fixture.pending(), 0);
  return response;
}

/** @param {Uint8Array} bytes */
function readArchive(bytes) {
  const files = unzipSync(bytes);
  const decoder = new TextDecoder();
  /** @type {unknown} */
  const snapshot = JSON.parse(decoder.decode(files["snapshot.json"]));
  /** @type {unknown} */
  const overlay = JSON.parse(decoder.decode(files["overlay.json"]));
  const validator = new Ajv2020({ strict: true });
  for (const [name, value] of [["snapshot", snapshot], ["overlay", overlay]]) {
    /** @type {unknown} */
    const schema = JSON.parse(readFileSync("schemas/" + name + ".v1.schema.json", "utf8"));
    assert.ok(record(schema));
    const validate = validator.compile(schema);
    assert.ok(validate(value), JSON.stringify(validate.errors));
  }
  assert.ok(record(snapshot) && Array.isArray(snapshot["roots"]) && record(overlay) && Array.isArray(overlay["rules"]));
  const root = /** @type {unknown} */ (snapshot["roots"][0]);
  assert.ok(record(root) && Array.isArray(root["children"]) && record(root["facts"]));
  /** @type {Record<string, unknown>[]} */
  const children = root["children"].map((/** @type {unknown} */ child) => {
    assert.ok(record(child));
    return child;
  });
  /** @type {Record<string, unknown>[]} */
  const rules = overlay["rules"].map((/** @type {unknown} */ rule) => {
    assert.ok(record(rule));
    return rule;
  });
  return { files, assets: snapshot["assets"], facts: root["facts"], children, rules };
}

void test("build is byte-identical with no requested network access and exact CSP hash", () => {
  const second = join(directory, "second");
  build(second);
  for (const path of ["manifest.json", "main.js", "ui.html"]) {
    assert.deepEqual(readFileSync(join(first, path)), readFileSync(join(second, path)));
  }
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8"));
  assert.ok(record(manifest));
  assert.deepEqual(manifest["networkAccess"], { allowedDomains: ["none"] });
  assert.deepEqual(manifest["editorType"], ["figma"]);
  assert.equal(manifest["documentAccess"], "dynamic-page");
  assert.ok(html.includes("sha256-" + createHash("sha256").update(uiScript).digest("base64")));
});

void test("one owned selection yields the same canonical archive with linked PNG and explicit alt", async () => {
  const fixture = host([trapped(frame([trapped(text()), trapped(rectangle())]))]);
  const result = await acquire(fixture);
  assert.equal(result.kind, "captured");
  const zip = await makeArchive(result, "Blue square");
  const repeated = await acquire(fixture, 2);
  assert.equal(repeated.kind, "captured");
  assert.deepEqual(await makeArchive(repeated, "Blue square"), zip);
  const { files, children, rules } = readArchive(zip);
  const asset = "assets/" + createHash("sha256").update(blue).digest("hex") + ".png";
  assert.deepEqual(Object.keys(files), [asset, "overlay.json", "snapshot.json"]);
  assert.deepEqual(Buffer.from(files[asset] ?? []), blue);
  assert.equal(children[0]?.["text"], "Public  Figma 🌻");
  assert.equal(children[1]?.["asset"], asset);
  assert.equal(rules[0]?.["nodeId"], "1:3");
  assert.equal(rules[0]?.["value"], "Blue square");
});

void test("horizontal no-image frames keep supported padding, paint and order", async () => {
  const root = { ...frame([text("First"), { ...rectangle(), fills: [color] }]),
    layoutMode: "HORIZONTAL", fills: [color], paddingLeft: 12, paddingBottom: 3 };
  const response = await acquire(host([root]));
  assert.equal(response.kind, "captured");
  const { assets, facts, rules, children, files } = readArchive(await makeArchive(response, ""));
  assert.deepEqual(Object.keys(files), ["overlay.json", "snapshot.json"]);
  assert.deepEqual(rules, []);
  assert.deepEqual(assets, []);
  assert.equal(facts["layoutMode"], "HORIZONTAL");
  assert.equal(facts["paddingLeft"], 12);
  assert.deepEqual(children.map((child) => child["id"]), ["1:2", "1:3"]);
  assert.ok(record(children[1]?.["facts"]));
  assert.deepEqual(children[1]["facts"]["fills"], [color]);
});

void test("invalid selection, unsupported facts and multiple images cause no raster", async () => {
  let rasters = 0;
  const picture = rectangle(async () => { rasters += 1; return blue; });
  for (const selection of [[], [frame(), frame()], [{ ...frame(), parent: { id: "1:4" } }]]) {
    const response = await acquire(host(selection));
    assert.equal(response.kind, "failed");
    assert.equal(response.code, "SELECTION");
  }
  for (const node of [
    frame([{ ...picture, type: "VECTOR" }]),
    frame([picture, { ...picture, id: "1:5" }]),
    frame([text(), { ...text(), characters: "Duplicate" }]),
    frame([{ ...picture, strokes: [color] }]),
    frame([{ ...text(), fontSize: Symbol("mixed") }]),
    frame([{ ...picture, boundVariables: { fills: ["var"] } }]),
  ]) {
    assert.equal((await acquire(host([node]))).kind, "failed");
  }
  const alt = await acquire(host([frame([picture])]), 1, "   ");
  assert.equal(alt.kind, "failed");
  assert.equal(alt.code, "ALT");
  assert.equal(rasters, 0);
});

void test("an in-flight export latches delivered changes and rejects overlapping requests", async () => {
  for (const event of ["selectionchange", "currentpagechange"]) {
    for (const changeOn of [1, 2]) {
      /** @type {(() => void) | undefined} */
    let finish;
      let rasters = 0;
      const picture = rectangle(() => {
        rasters += 1;
        if (rasters !== changeOn) return Promise.resolve(blue);
        return new Promise((resolve) => { finish = () => resolve(blue); });
      });
      const fixture = host([frame([picture])]);
      fixture.ui.onmessage({ kind: "capture", requestId: 1, alt: "present" });
      await new Promise((resolve) => setImmediate(resolve));
      const before = fixture.reads();
      fixture.ui.onmessage({ kind: "capture", requestId: 2, alt: "present" });
      fixture.signal(event);
      fixture.signal(event);
      assert.ok(finish);
      finish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fixture.reads(), before);
      assert.equal(rasters, changeOn);
      assert.equal(fixture.replies.length, 1);
      assert.equal(fixture.replies[0]?.kind, "failed");
      assert.equal(fixture.pending(), 0);
    }
  }
});

void test("projection detects crop mutation and child reorder with a stable image hash", async () => {
  for (const mutation of ["crop", "order"]) {
    /** @type {(() => void) | undefined} */
    let finish;
    const picture = rectangle(() => new Promise((resolve) => { finish = () => resolve(blue); }));
    const root = frame([text(), picture]);
    const fixture = host([root]);
    fixture.ui.onmessage({ kind: "capture", requestId: 1, alt: "present" });
    if (mutation === "crop") {
      Object.assign(picture, { fills: [{ ...imagePaint, imageTransform: [[1, 0, 0.2], [0, 1, 0]] }] });
    } else {
      root.children.reverse();
    }
    assert.ok(finish);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    const response = fixture.replies[0];
    assert.equal(response?.kind, "failed");
    assert.equal(response.code, "CHANGED");
    assert.equal(fixture.pending(), 0);
  }
});

void test("quota edges include hidden slots, Unicode escapes, alt and opaque image hashes", async () => {
  const hidden = { id: "1:4", visible: false };
  const supported = await acquire(host([frame(Array.from({ length: limits.nodes - 1 }, () => hidden))]));
  assert.equal(supported.kind, "captured");
  assert.equal((await acquire(host([frame(Array.from({ length: limits.nodes }, () => hidden))]))).kind, "failed");
  const edge = await acquire(host([frame([text("\u0001".repeat(limits.text))])]));
  assert.equal(edge.kind, "captured");
  assert.ok((await makeArchive(edge, "")).byteLength > limits.text * 6);
  assert.equal((await acquire(host([frame([text("X".repeat(limits.text + 1))])]))).kind, "failed");
  for (const value of [limits.imageHash, limits.imageHash + 1]) {
    const picture = { ...rectangle(), fills: [{ ...imagePaint, imageHash: "x".repeat(value) }] };
    assert.equal((await acquire(host([frame([picture])]))).kind, value === limits.imageHash ? "captured" : "failed");
  }
  const fixture = host([frame()]);
  const invalid = new Proxy({ kind: "invalid", requestId: 1, alt: "present" }, {
    ownKeys() { throw new Error("Invalid messages must not be enumerated."); },
  });
  fixture.ui.onmessage(invalid);
  fixture.ui.onmessage({ kind: "capture", requestId: 1, alt: "present", extra: true });
  fixture.ui.onmessage({ kind: "capture", requestId: 0, alt: "" });
  fixture.ui.onmessage({ kind: "capture", requestId: 1, alt: " ".repeat(limits.alt + 1) });
  assert.equal(fixture.reads(), 0);
  assert.equal((await acquire(fixture, 2, "A".repeat(limits.alt))).kind, "captured");
  const max = new Uint8Array(limits.png);
  max.set(blue);
  validatePng(max, 1, 1);
  assert.throws(() => validatePng(new Uint8Array(limits.png + 1), 1, 1), /exceeds an export limit/u);
  assert.throws(() => validatePng(blue, 2, 1), /supported PNG/u);
});

class Control {
  textContent = "";
  /** @type {Map<string, (event: { isTrusted: boolean }) => void>} */
  handlers = new Map();

  /** @param {string} name @param {(event: { isTrusted: boolean }) => void} handler */
  addEventListener(name, handler) {
    this.handlers.set(name, handler);
  }
}
class Input extends Control {
  value = "";
}
class Button extends Control {
  disabled = false;
}
class Anchor extends Control {
  hidden = true;
  href = "";

  removeAttribute() { this.href = ""; }
}

void test("packaged UI binds the submitted alt, rejects stale messages and revokes previous downloads", { timeout: 2000 }, async () => {
  const input = new Input();
  const button = new Button();
  const link = new Anchor();
  const status = new Control();
  const controls = new Map([["#alt", input], ["#capture", button], ["#save", link], ["#status", status]]);
  /** @type {unknown[]} */
  const outbound = [];
  /** @type {Blob[]} */
  const blobs = [];
  /** @type {string[]} */
  const revoked = [];
  /** @type {PromiseWithResolvers<void>} */
  let saved = Promise.withResolvers();
  const figmaOrigin = "https://www.figma.com";
  const hostWindow = {};
  const parent = { postMessage: (/** @type {unknown} */ packet) => outbound.push(packet) };
  /** @type {(() => void) | undefined} */
  let expire;
  /** @type {Map<string, (event: { source?: object; origin?: string; data?: object }) => void>} */
  const callbacks = new Map();
  runInNewContext(uiScript, {
    parent, document: { querySelector: (/** @type {string} */ selector) => controls.get(selector) },
    HTMLAnchorElement: Anchor, HTMLElement: Control, HTMLInputElement: Input, HTMLButtonElement: Button,
    Blob, TextEncoder, Uint8Array, ArrayBuffer, AbortController, ReadableStream, DecompressionStream,
    URL: {
      createObjectURL: (/** @type {Blob} */ value) => {
        const url = "blob:" + blobs.push(value);
        saved.resolve();
        return url;
      },
      revokeObjectURL: (/** @type {string} */ value) => revoked.push(value),
    },
    window: {
      top: hostWindow,
      addEventListener: (/** @type {string} */ event, /** @type {(event: object) => void} */ callback) => callbacks.set(event, callback),
      setTimeout: (/** @type {() => void} */ callback) => { expire = callback; return 1; },
      clearTimeout: () => { expire = undefined; },
    },
  });
  const receipt = await acquire(host([frame([rectangle()])]));
  assert.equal(receipt.kind, "captured");
  const click = button.handlers.get("click");
  const receive = callbacks.get("message");
  assert.ok(click && receive);
  input.value = "Синий квадрат";
  click({ isTrusted: false });
  assert.equal(outbound.length, 0);
  click({ isTrusted: true });
  assert.equal(button.disabled, true);
  assert.equal(JSON.stringify(outbound[0]), '{"pluginMessage":{"kind":"capture","requestId":1,"alt":"present"}}');
  input.value = "Changed input";
  receive({ source: {}, origin: figmaOrigin, data: { pluginMessage: receipt } });
  receive({ source: parent, origin: figmaOrigin, data: { pluginMessage: receipt } });
  receive({ source: hostWindow, origin: "https://example.com", data: { pluginMessage: receipt } });
  receive({ source: hostWindow, origin: "null", data: { pluginMessage: receipt } });
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: { ...receipt, requestId: 3 } } });
  assert.ok(link.hidden);
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: receipt } });
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: receipt } });
  await saved.promise;
  assert.ok(!link.hidden);
  assert.equal(blobs.length, 1);
  assert.ok(blobs[0]);
  const { rules } = readArchive(new Uint8Array(await blobs[0].arrayBuffer()));
  assert.equal(rules[0]?.["value"], "Синий квадрат");
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: receipt } });
  assert.equal(blobs.length, 1);
  click({ isTrusted: true });
  assert.ok(link.hidden && link.href === "");
  assert.deepEqual(revoked, ["blob:1"]);
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: receipt } });
  assert.ok(link.hidden);
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: { kind: "failed", requestId: 2, code: "SELECTION" } } });
  assert.ok(link.hidden);
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /Select one visible frame/u);
  click({ isTrusted: true });
  assert.ok(expire);
  expire();
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /timed out/u);
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: { ...receipt, requestId: 3 } } });
  assert.ok(link.hidden);
  click({ isTrusted: true });
  assert.equal(button.disabled, true);
  callbacks.get("pagehide")?.({});
  assert.equal(button.disabled, false);
  click({ isTrusted: true });
  saved = Promise.withResolvers();
  receive({ source: hostWindow, origin: figmaOrigin, data: { pluginMessage: { ...receipt, requestId: 5 } } });
  await saved.promise;
  assert.equal(input.value, "");
  click({ isTrusted: true });
  assert.equal(JSON.stringify(outbound[5]), '{"pluginMessage":{"kind":"capture","requestId":6,"alt":""}}');
});

void test("bridge copies exact PNG bytes and validates complete raster and document facts", async () => {
  const storage = new Uint8Array(blue.byteLength + 12).fill(0xaa);
  storage.set(blue, 5);
  const visible = storage.subarray(5, 5 + blue.byteLength);
  const receipt = await acquire(host([frame([rectangle(async () => visible)])]));
  assert.equal(receipt.kind, "captured");
  const image = receipt.image;
  assert.ok(image);
  assert.equal(image.png.byteOffset, 0);
  assert.equal(image.png.buffer.byteLength, blue.byteLength);
  assert.deepEqual(Buffer.from(image.png), blue);

  const metadata = Buffer.alloc(17);
  metadata.writeUInt32BE(5);
  metadata.write("tEXt", 4);
  metadata.write("x\0abc", 8);
  metadata.writeUInt32BE(crc32(metadata.subarray(4, 13)), 13);
  const withText = Buffer.concat([blue.subarray(0, 33), metadata, blue.subarray(33)]);
  const invalidData = Buffer.from(blue);
  invalidData[43] = (invalidData[43] ?? 0) ^ 2;
  for (const png of [blue.subarray(0, 33), Buffer.concat([blue, Buffer.from([0])]), withText, invalidData]) {
    await assert.rejects(() => makeArchive({ ...receipt, image: { ...image, png } }, "Blue"), /supported PNG/u);
  }
  const compressedLength = blue.readUInt32BE(33);
  const zlib = blue.subarray(41, 41 + compressedLength);
  for (const payload of [
    Buffer.concat([zlib.subarray(0, -4), Buffer.from("test"), zlib.subarray(-4)]),
    deflateSync(new Uint8Array(16_384)),
  ]) {
    const idat = Buffer.alloc(payload.byteLength + 12);
    idat.writeUInt32BE(payload.byteLength, 0);
    idat.write("IDAT", 4);
    payload.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.byteLength - 4);
    const png = Buffer.concat([blue.subarray(0, 33), idat, blue.subarray(45 + compressedLength)]);
    await assert.rejects(() => makeArchive({ ...receipt, image: { ...image, png } }, "Blue"), /supported PNG/u);
  }
  const wrongFacts = receipt.document.replace('"facts":{"height":1,"width":1}', '"facts":{"height":1,"width":2}');
  assert.notEqual(wrongFacts, receipt.document);
  await assert.rejects(() => makeArchive({ ...receipt, document: wrongFacts }, "Blue"), /could not be completed/u);
  await assert.rejects(() => makeArchive({
    ...receipt, document: '{"id":"1:1","kind":"frame","sourceRef":"1:1","children":[],"facts":{}}',
  }, "Blue"), /could not be completed/u);
});
