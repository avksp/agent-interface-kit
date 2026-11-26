import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@aik/cli";
import { hash, jsonBytes } from "@aik/compile-core";
import { collect } from "../../../integrations/figma-capture/src/collector.ts";
import { prepareProbe } from "../../../integrations/figma-capture/src/probe-request.ts";
import { figmaSource } from "../../../packages/source-figma/src/index.ts";
import { compileFixture, fixtureHost, fixtureSnapshot, forwardFs, lockFixture, png, runObservedCli, tree,
  writeFixture } from "./support/core-harness.mjs";

const negativeId = "9:1";
const overlay = /** @type {const} */ ({ schemaVersion: "aik.overlay.v1", rules: [] });
const fileKey = "permittedfixture01";

/** @param {import("node:test").TestContext} context */
async function testRoot(context) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "aik-figma-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

void test("observed visible effect survives capture and lock, then compilation refuses before render or writes", async (context) => {
  const root = await testRoot(context);
  const positive = await writeFixture(root);
  const baseline = fixtureHost(root);
  assert.equal((await lockFixture(positive, baseline)).status, "ok");
  assert.equal((await compileFixture(positive, baseline)).status, "ok");
  const preserved = await tree(positive.output);

  const captureRoot = join(root, "private");
  await mkdir(captureRoot, { mode: 0o700 });
  const before = JSON.stringify({
    probe: "aik.figma-closure.v1", fileKey, anchorId: "9:0", apiVersion: "1.0.0",
    cases: { N: { root: {
      id: negativeId, type: "INSTANCE", effects: [{ type: "BACKGROUND_BLUR", visible: true }], children: [],
    } } },
    dependencies: [], asset: null,
  });
  const captureResult = await collect({ before }, {
    group: "n", fileKey, anchorId: "9:0", roots: { N: negativeId }, overlay, paints: [],
    captureRoot, stagingRoot: positive.staging,
  }, AbortSignal.timeout(2000));
  assert.equal(captureResult.status, "PASS");
  const capture = join(captureRoot, "n");
  const lock = join(capture, "build.lock.json");
  const host = {
    ...baseline,
    sources: [figmaSource],
    targets: baseline.targets.map((target) => ({
      ...target,
      render() {
        assert.fail("Target runs after an unsupported required effect");
      },
    })),
  };
  assert.equal((await runCli(["lock", "--input", capture, "--overlay", join(capture, "overlay.json"),
    "--out", lock, "--staging-root", positive.staging], host)).status, "ok");
  const fresh = join(root, "fresh");
  let writes = 0;
  for (const output of [fresh, positive.output]) {
    const result = await runObservedCli((fs) => forwardFs(fs, {
      createDirectory(parent, name) { writes++; return fs.createDirectory(parent, name); },
      renameExclusive(parent, name, to, destination) { writes++; return fs.renameExclusive(parent, name, to, destination); },
    }), ["compile", "--lock", lock, "--out", output], host);
    assert.equal(result.status, "error");
    assert.deepEqual(result.diagnostics, [{ code: "UNSUPPORTED_EFFECT", severity: "error", sourceRef: negativeId }]);
  }
  assert.equal(writes, 0);
  assert.equal(existsSync(fresh), false);
  assert.deepEqual(await tree(positive.output), preserved);
});

void test("offline lock names the Figma consumer of a missing asset", async (context) => {
  const root = await testRoot(context);
  const paths = await writeFixture(root);
  const snapshot = fixtureSnapshot();
  await writeFile(paths.snapshot, jsonBytes({
    ...snapshot, source: { adapter: figmaSource.id, version: figmaSource.version },
  }));
  await unlink(paths.image);
  const result = await lockFixture(paths, { ...fixtureHost(root), sources: [figmaSource] });
  assert.equal(result.status, "error");
  assert.deepEqual(result.diagnostics, [{ code: "MISSING_DEPENDENCY", severity: "error", sourceRef: "fixture:image" }]);
  assert.equal(existsSync(paths.lock), false);
});

void test("collector checks observation drift before using any transport handles", async (context) => {
  const root = await testRoot(context);
  const captureRoot = join(root, "capture");
  const stagingRoot = join(root, "stage");
  await mkdir(captureRoot, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const message = { before: "{}", after: "{ }", urls: [] };
  await assert.rejects(collect(message, {
    group: "ab", fileKey, anchorId: "9:0", roots: { A: "9:2", B: "9:3" }, overlay,
    paints: [], backdropId: "9:4", captureRoot, stagingRoot,
    asset: { nodeId: "9:5", fillSlot: 0, sourceImageId: "0".repeat(40), sha256: "0".repeat(64), bytes: 1 },
  }, AbortSignal.timeout(1000)), { message: "SOURCE_CHANGED" });
  assert.deepEqual(await tree(captureRoot), []);
  assert.deepEqual(await tree(stagingRoot), []);
});

void test("both plug-in request literals carry the declared file key and only the scoped facts", () => {
  const common = { fileKey, anchorId: "9:0" };
  const n = { ...common, group: /** @type {const} */ ("n"), roots: { N: negativeId } };
  const positive = {
    ...common, group: /** @type {const} */ ("ab"), roots: { A: "9:2", B: "9:3" },
    asset: { nodeId: "9:4", fillSlot: 0, sourceImageId: "a".repeat(40), sha256: "b".repeat(64) },
    link: { nodeId: "9:5", targetId: "9:6" }, paints: [], backdropId: "9:7", privatePath: "/private/example",
  };
  const body = 'if (figma.fileKey !== request.fileKey) throw new Error("SOURCE_CHANGED");';
  for (const scope of [n, positive]) {
    const [line, code] = prepareProbe(scope, body).split("\n");
    assert.ok(line);
    /** @type {unknown} */
    const request = JSON.parse(line.slice("const request = ".length, -1));
    assert.equal(code, body);
    const { group, roots } = scope;
    const identity = { group, fileKey, anchorId: common.anchorId, roots };
    if (scope.group === "n") assert.deepEqual(request, identity);
    else assert.deepEqual(request, { ...identity, paints: [], backdropId: positive.backdropId, link: positive.link,
      asset: { nodeId: positive.asset.nodeId, fillSlot: positive.asset.fillSlot, sourceImageId: positive.asset.sourceImageId } });
  }
  assert.throws(() => prepareProbe({ ...n, fileKey: "" }, body), TypeError);
});

/** @param {string} root */
async function archivedFixture(root) {
  const captureRoot = join(root, "capture");
  const stagingRoot = join(root, "staging");
  const references = join(root, "references");
  const archiveRoot = join(root, "archive");
  await Promise.all([captureRoot, stagingRoot, references, archiveRoot].map((path) => mkdir(path, { mode: 0o700 })));
  const original = join(archiveRoot, "A-passive-image.png");
  await writeFile(original, png, { mode: 0o600, flag: "wx" });
  const asset = { nodeId: "9:5", fillSlot: 0, sourceImageId: createHash("sha1").update(png).digest("hex"),
    sha256: hash(png), bytes: png.length };
  const localLink = { nodeId: "9:6", targetId: "9:7" };
  const backdropId = "9:8";
  const anchorId = "9:0";
  const roots = { A: "9:2", B: "9:3" };
  const consumer = ["9:3", "9:9", "9:10", "9:11", backdropId];
  const dependencies = consumer.map((nodeId) => ({
    nodeId, field: "fills", slot: 0, aliasId: "v1", collectionId: "c1", modeId: "m1",
    paint: { type: "SOLID", boundVariables: { color: { type: "VARIABLE_ALIAS", id: "v1" } } },
    resolved: { resolvedType: "COLOR", value: { r: 0, g: 0, b: 0, a: 1 } },
  }));
  const probe = {
    probe: "aik.figma-closure.v1", fileKey, anchorId, apiVersion: "1",
    cases: { A: { root: { id: roots.A, type: "FRAME", children: [
      { id: asset.nodeId, type: "RECTANGLE", fills: [{ type: "IMAGE", imageHash: asset.sourceImageId }], children: [] },
      { id: localLink.nodeId, type: "TEXT", characters: "Local link",
        styledSegments: [{ hyperlink: { type: "NODE", value: localLink.targetId } }], children: [] },
      { id: localLink.targetId, type: "FRAME", children: [] },
    ] } }, B: { root: { id: roots.B, parentId: backdropId, type: "FRAME",
      children: consumer.slice(1, 4).map((id) => ({ id, type: "RECTANGLE", children: [] })) } } },
    dependencies, asset: { nodeId: asset.nodeId, fillSlot: 0, sourceImageId: asset.sourceImageId },
  };
  const config = join(references, "ab.json");
  await writeFile(config, jsonBytes({ group: "ab", fileKey, anchorId, roots, link: localLink, backdropId,
    paints: consumer.map((id) => [id, "fills", 0]), asset, captureRoot, stagingRoot,
    overlay: { ...overlay, rules: [{ id: "backdrop", nodeId: roots.B, property: "backdrop", precedence: 10,
      value: { sourceNodeId: backdropId, field: "fills", slot: 0, rgbHex: "#000000" } }] },
  }), { mode: 0o600, flag: "wx" });
  return { captureRoot, stagingRoot, references, config, archiveRoot, original, probe };
}

void test("archive bridge publishes only the complete pinned capture and refuses altered inputs", async (context) => {
  const bridge = new URL("../../../integrations/figma-capture/collect-archived.py", import.meta.url);
  const cases = ["valid", "drift", "missing-paint", "missing-link", "wrong-fill", "wrong-root", "expired",
    "missing-png", "wrong-png", "linked-directory", "symlink", "hard-link", "oversized", "in-band-handle"];
  for (const kind of cases) {
    await context.test(kind, async (subtest) => {
      const root = await testRoot(subtest);
      const fixture = await archivedFixture(root);
      const { original, config, probe, captureRoot, stagingRoot, references } = fixture;
      let { archiveRoot } = fixture;
      if (kind === "missing-paint") probe.dependencies.pop();
      if (kind === "missing-link") probe.cases.A.root.children[1]?.styledSegments?.pop();
      if (kind === "wrong-fill") assert.ok(probe.cases.A.root.children[0]?.fills?.pop());
      if (kind === "wrong-root") probe.cases.A.root.id = "9:12";
      if (kind === "missing-png") await unlink(original);
      if (kind === "wrong-png") await writeFile(original, Buffer.alloc(png.length));
      if (kind === "oversized") await writeFile(original, Buffer.alloc(2 * 1024 * 1024 + 1));
      if (kind === "hard-link") await link(original, join(root, "other-link.png"));
      if (kind === "symlink") {
        await unlink(original);
        await symlink(config, original);
      }
      if (kind === "linked-directory") {
        archiveRoot = join(root, "linked");
        await symlink(fixture.archiveRoot, archiveRoot);
      }
      const before = JSON.stringify(probe);
      const after = JSON.stringify(kind === "drift" ? { ...probe, apiVersion: "2" } : probe);
      const input = { before, after, ...(kind === "in-band-handle" && { urls: [] }) };
      const result = spawnSync("python3", [decodeURIComponent(bridge.pathname), config, archiveRoot,
        String(Date.now() + (kind === "expired" ? -1 : 5000))], {
        input: JSON.stringify(input) + "\n", encoding: "utf8", timeout: 7000,
      });
      assert.ifError(result.error);
      assert.equal(result.stderr, "");
      assert.equal(result.status, kind === "valid" ? 0 : 1, result.stdout);
      assert.match(result.stdout, kind === "valid" ? /"status":"PASS"/u : /"status":\s*"REFUSED"/u);
      if (kind === "valid") {
        assert.deepEqual(await readFile(join(captureRoot, "ab", "assets", "source.png")), png);
        assert.equal(existsSync(join(captureRoot, "ab", "snapshot.json")), true);
        assert.equal(existsSync(join(captureRoot, "ab", "overlay.json")), true);
      } else {
        assert.deepEqual(await tree(captureRoot), []);
      }
      assert.deepEqual(await tree(stagingRoot), []);
      assert.equal(existsSync(join(references, "a-passive-image.input")), false);
    });
  }
});
