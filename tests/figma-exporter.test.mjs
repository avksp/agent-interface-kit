import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";
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
    strokesIncludedInLayout: false, itemReverseZIndex: false, layoutSizingVertical: "HUG",
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
  runInNewContext(javascript, { __html__: html, figma: trapped({
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
  fixture.ui.onmessage({ kind: "capture", requestId, alt });
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
  const zip = makeArchive(result, "Blue square");
  const repeated = await acquire(fixture, 2);
  assert.equal(repeated.kind, "captured");
  assert.deepEqual(makeArchive(repeated, "Blue square"), zip);
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
  const { assets, facts, rules, children, files } = readArchive(makeArchive(response, ""));
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
      fixture.ui.onmessage({ kind: "capture", requestId: 1, alt: "Blue" });
      await new Promise((resolve) => setImmediate(resolve));
      const before = fixture.reads();
      fixture.ui.onmessage({ kind: "capture", requestId: 2, alt: "Blue" });
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
    fixture.ui.onmessage({ kind: "capture", requestId: 1, alt: "Blue" });
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
  assert.ok(makeArchive(edge, "").byteLength > limits.text * 6);
  assert.equal((await acquire(host([frame([text("X".repeat(limits.text + 1))])]))).kind, "failed");
  for (const value of [limits.imageHash, limits.imageHash + 1]) {
    const picture = { ...rectangle(), fills: [{ ...imagePaint, imageHash: "x".repeat(value) }] };
    assert.equal((await acquire(host([frame([picture])]))).kind, value === limits.imageHash ? "captured" : "failed");
  }
  const fixture = host([frame()]);
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

void test("packaged UI binds the submitted alt, rejects stale messages and revokes previous downloads", async () => {
  const input = new Input();
  const button = new Button();
  const link = new Anchor();
  const status = new Control();
  const controls = new Map([["#alt", input], ["#capture", button], ["#save", link], ["#status", status]]);
  const outbound = [];
  /** @type {Blob[]} */
  const blobs = [];
  /** @type {string[]} */
  const revoked = [];
  const parent = { postMessage: (/** @type {unknown} */ packet) => outbound.push(packet) };
  /** @type {Map<string, (event: { source?: object; data?: object }) => void>} */
  const callbacks = new Map();
  runInNewContext(uiScript, {
    parent, document: { querySelector: (/** @type {string} */ selector) => controls.get(selector) },
    HTMLAnchorElement: Anchor, HTMLElement: Control, HTMLInputElement: Input, HTMLButtonElement: Button,
    Blob, TextEncoder, Uint8Array,
    URL: {
      createObjectURL: (/** @type {Blob} */ value) => "blob:" + blobs.push(value),
      revokeObjectURL: (/** @type {string} */ value) => revoked.push(value),
    },
    window: { addEventListener: (/** @type {string} */ event, /** @type {(event: object) => void} */ callback) => callbacks.set(event, callback) },
  });
  const receipt = await acquire(host([frame([rectangle()])]));
  assert.equal(receipt.kind, "captured");
  const click = button.handlers.get("click");
  const receive = callbacks.get("message");
  assert.ok(click && receive);
  input.value = "Original alt";
  click({ isTrusted: false });
  assert.equal(outbound.length, 0);
  click({ isTrusted: true });
  assert.equal(button.disabled, true);
  input.value = "Changed input";
  receive({ source: {}, data: { pluginMessage: receipt } });
  receive({ source: parent, data: { pluginMessage: { ...receipt, requestId: 3 } } });
  assert.ok(link.hidden);
  receive({ source: parent, data: { pluginMessage: receipt } });
  assert.ok(!link.hidden);
  assert.equal(blobs.length, 1);
  assert.ok(blobs[0]);
  const { rules } = readArchive(new Uint8Array(await blobs[0].arrayBuffer()));
  assert.equal(rules[0]?.["value"], "Original alt");
  receive({ source: parent, data: { pluginMessage: receipt } });
  assert.equal(blobs.length, 1);
  click({ isTrusted: true });
  assert.ok(link.hidden && link.href === "");
  assert.deepEqual(revoked, ["blob:1"]);
  receive({ source: parent, data: { pluginMessage: receipt } });
  assert.ok(link.hidden);
  receive({ source: parent, data: { pluginMessage: { kind: "failed", requestId: 2, code: "SELECTION" } } });
  assert.ok(link.hidden);
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /Select one visible frame/u);
});
