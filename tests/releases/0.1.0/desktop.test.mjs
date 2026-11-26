import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

const main = readFileSync(new URL("../../../integrations/figma-capture/desktop-main.js.txt", import.meta.url), "utf8");
const html = readFileSync(new URL("../../../integrations/figma-capture/desktop-ui.html", import.meta.url), "utf8");
const getters = record(JSON.parse(readFileSync(new URL("../../../integrations/figma-capture/desktop-getters.json", import.meta.url), "utf8")));
const desktop = fileURLToPath(new URL("../../../integrations/figma-capture/desktop.py", import.meta.url));
const nonce = "a".repeat(32);
const source = { editor: "figma", fileKey: "fixture", anchorId: "1:1", roots: { A: "1:2", B: "2:2" } };
const imageHash = "b".repeat(40);
const text = "Кириллица 🧪 </script><b>";

/** @typedef {{id: string, type: string, children?: TestNode[]}} TestNode */
/** @typedef {{id: string, type: string, children: TestTree[]}} TestTree */
/** @typedef {{fileKey: string, currentPage: {id: string}, getNodeByIdAsync: (id: string) => Promise<TestNode>}} MutableFigma */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  assert.ok(isRecord(value));
  return value;
}

/** @param {unknown} value @returns {unknown[]} */
function entries(value) {
  assert.ok(Array.isArray(value));
  return value;
}

/** @param {TestNode} node @returns {TestTree} */
function tree({ id, type, children }) {
  return { id, type, children: (children ?? []).map(tree) };
}

function scene() {
  const page = { id: "1:1", type: "PAGE", on() {} };
  /** @type {TestNode[]} */
  const children = [];
  const a = { id: "1:2", type: "FRAME", name: "A", parent: page, children };
  const backdrop = {
    id: "2:1", type: "FRAME", parent: page,
    fills: [{ type: "SOLID", boundVariables: { color: { type: "VARIABLE_ALIAS", id: "local" } } }],
  };
  const b = { id: "2:2", type: "FRAME", name: "B", parent: backdrop, children: [] };
  const rectangle = {
    id: "1:3", type: "RECTANGLE", name: "Bitmap", parent: a,
    fills: [{ type: "IMAGE", imageHash }],
  };
  const heading = {
    id: "1:4", type: "TEXT", name: "Link", parent: a, characters: text,
    /** @param {string[]} fields @param {number} start @param {number} end */
    getStyledTextSegments(fields, start, end) {
      assert.deepEqual(fields, getters["styled"]);
      assert.equal(start, 0);
      assert.equal(end, text.length);
      return [{ characters: text, hyperlink: { type: "NODE", value: "1:5" } }];
    },
  };
  const target = { id: "1:5", type: "FRAME", name: "Region", parent: a, children: [] };
  a.children.push(rectangle, heading, target);
  return { page, a, b, heading, backdrop };
}

/** @param {(figma: MutableFigma, model: ReturnType<typeof scene>, regress: () => void) => void} change */
async function collect(change = () => {}) {
  const model = scene();
  const { a, b, page } = model;
  const variable = {
    id: "local", remote: false, resolvedType: "COLOR", variableCollectionId: "palette",
    resolveForConsumer: () => ({ resolvedType: "COLOR", value: { r: 0, g: 0, b: 0, a: 1 } }),
  };
  let time = 100_000;
  /** @type {string[]} */
  const lookup = [];
  const figma = {
    editorType: "figma", fileKey: source.fileKey, apiVersion: "1.0.0", currentPage: page, on() {},
    /** @param {string} id */
    async getNodeByIdAsync(id) {
      lookup.push(id);
      return id === a.id ? a : b;
    },
    variables: {
      async getVariableByIdAsync() { return variable; },
      async getVariableCollectionByIdAsync() { return { id: "palette", remote: false, defaultModeId: "default" }; },
    },
    showUI: /** @type {(html: string) => void} */ (() => { throw new Error("UI handler was not installed"); }),
    closePlugin: /** @type {(message: string) => void} */ (() => { throw new Error("UI handler was not installed"); }),
  };
  const invocation = {
    source, trees: { A: tree(a), B: tree(b) }, parentChains: { A: ["1:1"], B: ["2:1", "1:1"] },
    asset: { nodeId: "1:3", fillSlot: 0, sourceImageId: imageHash },
    link: { nodeId: "1:4", targetId: "1:5" },
    paintBindings: [{ consumer: "2:1", field: "fills", slot: 0, alias: "local", collection: "palette",
      mode: "default", resolvedRgba: [0, 0, 0, 1] }],
    getters, nonce, expiresAt: time + 300_000,
  };
  change(figma, model, () => { time -= 100; });
  /** @type {Promise<string>} */
  const result = new Promise((resolve, reject) => {
    figma.showUI = resolve;
    figma.closePlugin = reject;
    runInNewContext(main, {
      invocation, figma, __html__: html, Object, Date: { now: () => ++time },
    }, { filename: "desktop-main.js", timeout: 1000 });
  });
  const ui = await result;
  const island = /<script id="capture" type="application\/json">([^<]+)<\/script>/u.exec(ui);
  assert.ok(island?.[1]);
  return { payload: record(JSON.parse(island[1])), lookup };
}

await test("Desktop exporter limits capture to the two ordered roots and preserves opaque UTF-8", async () => {
  const { payload, lookup } = await collect();
  assert.equal(payload["status"], "PASS");
  assert.deepEqual(lookup, [source.roots.A, source.roots.B, source.roots.A, source.roots.B]);
  assert.ok(typeof payload["wire"] === "string");
  const [header, envelope, end] = payload["wire"].split("\n");
  assert.equal(end, "");
  assert.ok(header && envelope);
  const timing = entries(record(JSON.parse(header))["observations"]);
  assert.deepEqual(timing.map((entry) => record(entry)["position"]), [1, 2]);
  const observations = record(JSON.parse(envelope));
  assert.ok(typeof observations["before"] === "string");
  assert.equal(observations["before"], observations["after"]);
  const cases = record(record(JSON.parse(observations["before"]))["cases"]);
  const root = record(record(cases["A"])["root"]);
  assert.equal(record(entries(root["children"])[1])["characters"], text);
  const check = spawnSync("python3", ["-B", "-c", [
    "import runpy, sys",
    "m = runpy.run_path(sys.argv[1])",
    "wire = sys.stdin.buffer.read()",
    "nonce = 'a' * 32",
    "assert m['parse_capture'](wire, nonce)[2] == wire.split(b'\\n')[1] + b'\\n'",
    "invalid = (b'\\xef\\xbb\\xbf' + wire, wire.replace(b'\\n', b'\\r\\n', 1),",
    "           wire.replace(b'\"version\":1', b'\"version\":1,\"version\":1', 1),",
    "           wire.replace(b'\"position\":2', b'\"position\":1', 1),",
    "           wire.replace(b'\"before\":', b'\"other\":', 1), wire + b'\\n')",
    "for candidate in invalid:",
    "    try: m['parse_capture'](candidate, nonce)",
    "    except m['Refusal']: continue",
    "    raise AssertionError('Invalid capture accepted')",
    "try: m['parse_capture'](wire, 'b' * 32)",
    "except m['Refusal']: pass",
    "else: raise AssertionError('Stale nonce accepted')",
  ].join("\n"), desktop], { input: payload["wire"], encoding: "utf8", timeout: 5000 });
  assert.equal(check.status, 0, check.stderr);
});

await test("Desktop exporter rejects scope and timing failures before showing a save action", async () => {
  const wrong = await collect((figma) => { figma.fileKey = "other"; });
  assert.equal(wrong.payload["status"], "WRONG_SCOPE");
  assert.deepEqual(wrong.lookup, []);
  const change = await collect((figma, { a }) => {
    figma.getNodeByIdAsync = async () => {
      figma.currentPage = { id: "1:100" };
      return a;
    };
  });
  assert.equal(change.payload["status"], "SCOPE_CHANGED");
  const rollback = await collect((figma, { a }, regress) => {
    figma.getNodeByIdAsync = async () => {
      regress();
      return a;
    };
  });
  assert.equal(rollback.payload["status"], "TIME_LIMIT");
  for (const result of [wrong, change, rollback]) assert.equal(result.payload["wire"], "");
});

await test("Desktop bridge charges process startup and refuses expired completions", () => {
  const check = spawnSync("python3", ["-B", "-c", String.raw`
import runpy
from subprocess import TimeoutExpired
import sys
from types import SimpleNamespace
from unittest.mock import patch

module = runpy.run_path(sys.argv[1])
bridge = module["run_bridge"]
Refusal = module["Refusal"]
seconds = 1_000_000_000

def scenario(start, finish, *, deadline=6, wall_limit=200, timeout_error=False, expiry=False, killed=False):
    clock = SimpleNamespace(wall=0, mono=0)
    events = []

    class Child:
        pid = 123
        returncode = 0

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def communicate(self, *, input, timeout):
            assert input == b"envelope"
            events.append(("timeout", timeout))
            clock.wall, clock.mono = finish
            if timeout_error:
                raise TimeoutExpired("child", timeout)

        def wait(self):
            events.append("wait")

    def spawn(argv, **options):
        assert int(argv[-1]) == min(90, wall_limit) * 1000
        assert options["start_new_session"] is True
        clock.wall, clock.mono = start
        return Child()

    time = SimpleNamespace(time_ns=lambda: clock.wall * seconds, monotonic_ns=lambda: clock.mono * seconds)
    args = SimpleNamespace(expires_at=wall_limit * 1000, config="config", archive="archive")
    with patch.dict(bridge.__globals__, {"time": time}), patch("subprocess.Popen", spawn), patch("os.killpg") as kill:
        try:
            assert bridge(args, b"envelope", deadline * seconds) == 0
        except TimeoutExpired:
            assert timeout_error
        except Refusal as error:
            assert expiry and str(error) == "CAPTURE_EXPIRED"
        else:
            assert not (expiry or timeout_error)
        assert kill.call_count == int(killed)
        if killed:
            assert kill.call_args.args[0] == Child.pid and events[-1] == "wait"
    return events

assert scenario((1, 2), (2, 3)) == [("timeout", 4.0)]
assert scenario((1, 6), (1, 6), expiry=True, killed=True) == ["wait"]
assert scenario((3, 1), (3, 1), wall_limit=3, expiry=True, killed=True) == ["wait"]
assert scenario((1, 2), (2, 6), expiry=True) == [("timeout", 4.0)]
assert scenario((1, 2), (5, 3), wall_limit=5, expiry=True) == [("timeout", 4.0)]
assert scenario((1, 2), (2, 3), timeout_error=True, killed=True) == [("timeout", 4.0), "wait"]
assert scenario((-10, 2), (-9, 90), deadline=200, expiry=True) == [("timeout", 88.0)]
`, desktop], { encoding: "utf8", timeout: 5000 });
  assert.equal(check.status, 0, check.stderr);
});

await test("Desktop staging rolls back only files created by the failed attempt", () => {
  const check = spawnSync("python3", ["-B", "-c", String.raw`
from contextlib import ExitStack
import json
import os
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

stage = runpy.run_path(sys.argv[1])["stage_capture"]
sync = os.fsync
write = os.write

def verify_case(preexisting, fail_write, fail_sync, expected):
    with TemporaryDirectory() as temporary, ExitStack() as stack:
        path = Path(temporary)
        directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        stack.callback(os.close, directory)
        if preexisting:
            (path / preexisting).write_bytes(b"prior")
        def write_file(fd, data):
            if fail_write:
                write(fd, data[:1])
                raise OSError("fixture write failure")
            return write(fd, data)
        def sync_file(fd):
            if fail_sync and fd == directory:
                raise OSError("fixture directory sync failure")
            sync(fd)
        with patch("os.write", write_file), patch("os.fsync", sync_file):
            try:
                stage(stack, directory, "capture.json", b"capture", {"key": "value"}, 0)
            except OSError:
                assert preexisting or fail_write or fail_sync
            else:
                assert not (preexisting or fail_write or fail_sync)
        assert {entry.name for entry in path.iterdir()} == expected
        if preexisting:
            assert (path / preexisting).read_bytes() == b"prior"
        elif len(expected) == 2:
            assert (path / "capture.json").read_bytes() == b"capture"
            receipt = json.loads((path / "transport.json").read_bytes())
            assert receipt["key"] == "value" and type(receipt["monotonicIntakeMs"]) is int

verify_case("capture.json", False, False, {"capture.json"})
verify_case("transport.json", False, False, {"transport.json"})
verify_case(None, True, False, set())
verify_case(None, False, True, set())
verify_case(None, False, False, {"capture.json", "transport.json"})
`, desktop], { encoding: "utf8", timeout: 5000 });
  assert.equal(check.status, 0, check.stderr);
});
