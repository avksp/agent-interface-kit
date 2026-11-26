import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { hash, jsonBytes } from "@aik/compile-core";
import { runCli } from "@aik/cli";
import { loadSecureFs } from "../../../../packages/cli/src/commands/secure-fs.ts";

/** @typedef {ReturnType<typeof loadSecureFs>} SecureFs */
/** @typedef {{ path: string, type: "directory" | "file" | "symlink", bytes?: Buffer, target?: string }} TreeEntry */

/** @type {Map<string, () => SecureFs>} */
const loaders = new Map();
let nextLoader = 0;

/** @param {string} key */
export function loadObservedFs(key) {
  const loader = loaders.get(key);
  if (loader === undefined) throw new Error("Missing test filesystem observer");
  return loader();
}

/**
 * @param {(fs: SecureFs) => SecureFs} observe
 * @param {string[]} args
 * @param {import("@aik/cli").CliHost} host
 */
export async function runObservedCli(observe, args, host) {
  const key = String(++nextLoader);
  const cli = new URL(import.meta.resolve("@aik/cli"));
  cli.searchParams.set("fixture", key);
  const loader = 'import { loadObservedFs } from ' + JSON.stringify(import.meta.url) + '; ' +
    'export function loadSecureFs() { return loadObservedFs(' + JSON.stringify(key) + '); }';
  const moduleUrl = "data:text/javascript," + encodeURIComponent(loader);
  loaders.set(key, () => observe(loadSecureFs()));
  try {
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL === import.meta.url && specifier === "@aik/cli") {
          return { url: cli.href, shortCircuit: true };
        }
        if (context.parentURL === cli.href && specifier === "./secure-fs.ts") {
          return { url: moduleUrl, shortCircuit: true };
        }
        return next(specifier, context);
      },
    });
    /** @type {typeof import("@aik/cli")} */
    let observedCli;
    try {
      observedCli = await import("@aik/cli");
    } finally {
      hooks.deregister();
    }
    return await observedCli.runCli(args, host);
  } finally {
    loaders.delete(key);
  }
}

/**
 * @param {SecureFs} fs
 * @param {Partial<SecureFs>} methods
 * @returns {SecureFs}
 */
export function forwardFs(fs, methods) {
  return {
    openRoot: (path) => fs.openRoot(path),
    openDirectory: (parent, name) => fs.openDirectory(parent, name),
    closeDirectory: (parent) => fs.closeDirectory(parent),
    readFile: (parent, name, limit, compare) => fs.readFile(parent, name, limit, compare ?? false),
    writeFile: (parent, name, bytes) => fs.writeFile(parent, name, bytes),
    createDirectory: (parent, name) => fs.createDirectory(parent, name),
    qualifyLockStaging: (capture, parent) => fs.qualifyLockStaging(capture, parent),
    acquireLockGuard: (capture) => fs.acquireLockGuard(capture),
    createLockStage: (parent) => fs.createLockStage(parent),
    openLockStage: (parent, stage) => fs.openLockStage(parent, stage),
    removeLockStage: (parent, stage) => fs.removeLockStage(parent, stage),
    unlinkEntry: (parent, name, directory) => fs.unlinkEntry(parent, name, directory),
    renameExclusive: (from, name, to, destination) => fs.renameExclusive(from, name, to, destination),
    visit(parent, use, maxEntries) {
      if (maxEntries === undefined) fs.visit(parent, use);
      else fs.visit(parent, use, maxEntries);
    },
    ...methods,
  };
}

/**
 * @param {string} root
 * @param {string} [prefix]
 * @returns {Promise<TreeEntry[]>}
 */
export async function tree(root, prefix = "") {
  /** @type {TreeEntry[]} */
  const entries = [];
  for (const name of (await readdir(root)).toSorted()) {
    const path = join(root, name);
    const relative = prefix + name;
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: "directory" });
      entries.push(...await tree(path, relative + "/"));
    } else if (stat.isFile()) {
      entries.push({ path: relative, type: "file", bytes: await readFile(path) });
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: relative, type: "symlink", target: await readlink(path) });
    } else {
      throw new Error("Unexpected fixture entry: " + relative);
    }
  }
  return entries;
}

/** @param {string} root @param {string[]} args */
export async function runIsolatedCli(root, args) {
  const script = 'import { runCli } from "@aik/cli"; ' +
    'const { fixtureHost } = await import(process.argv[1]); ' +
    'const result = await runCli(process.argv.slice(3), fixtureHost(process.argv[2])); ' +
    'process.stdout.write(JSON.stringify(result));';
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let running;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    running?.kill("SIGKILL");
  }, 5000);
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, import.meta.url, root, ...args],
      { stdio: ["ignore", "pipe", "inherit"] });
    running = child;
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (/** @type {string} */ chunk) => {
      output += chunk;
      if (output.length > 8192) child.kill("SIGKILL");
    });
    /** @type {unknown} */
    const exit = await once(child, "close");
    assert.equal(timedOut, false, "isolated CLI exceeded the parent deadline");
    assert.deepEqual(exit, [0, null]);
    /** @type {unknown} */
    const result = JSON.parse(output);
    return result;
  } finally {
    clearTimeout(deadline);
  }
}

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

/** @type {import("@aik/compile-core").SourceAdapter} */
export const fixtureAdapter = { id: "fixture", version: "1", normalize: (snapshot) => snapshot.roots };

/** @type {import("@aik/compile-core").OutputTarget} */
export const fixtureTarget = {
  id: "fixture-output", version: "1", profile: "site-v1",
  render(document, assets, options) {
    const files = [
      { path: "fixture.txt", mediaType: "text/plain", bytes: jsonBytes({ document, options }) },
    ];
    for (const asset of document.assets) {
      const bytes = assets.get(asset.path);
      if (!bytes) throw new Error("Missing fixture asset");
      files.push({ path: asset.path, mediaType: asset.mediaType, bytes });
    }
    return { files };
  },
};

/** @returns {import("@aik/compile-core").Snapshot} */
export function fixtureSnapshot() {
  return {
    schemaVersion: "aik.snapshot.v1",
    source: { adapter: fixtureAdapter.id, version: fixtureAdapter.version },
    roots: [{
      id: "frame", kind: "frame", sourceRef: "fixture:frame", children: [
        { id: "text", kind: "text", sourceRef: "fixture:text", text: "AIK", children: [] },
        { id: "image", kind: "image", sourceRef: "fixture:image", asset: "assets/a.png", children: [] },
      ],
    }],
    assets: [{ path: "assets/a.png", sha256: hash(png), mediaType: "image/png" }],
  };
}

/** @param {string} root */
export async function writeFixture(root) {
  const capture = join(root, "capture");
  const staging = join(root, "staging");
  await mkdir(staging, { mode: 0o700 });
  await mkdir(join(capture, "assets"), { recursive: true });
  await writeFile(join(capture, "assets", "a.png"), png);
  await writeFile(join(capture, "snapshot.json"), jsonBytes(fixtureSnapshot()));
  await writeFile(join(capture, "overlay.json"), jsonBytes({ schemaVersion: "aik.overlay.v1", rules: [] }));
  return {
    capture,
    staging,
    snapshot: join(capture, "snapshot.json"),
    overlay: join(capture, "overlay.json"),
    lock: join(capture, "build.lock.json"),
    image: join(capture, "assets", "a.png"),
    output: join(root, "site"),
    manifest: join(root, "site", "artifact-manifest.json"),
  };
}

/** @param {string} root */
export function fixtureHost(root) {
  return {
    sources: [fixtureAdapter],
    targets: [fixtureTarget],
    nodeVersion: process.version,
    trustedOutputParent: root,
    writer: { pid: process.pid, bootId: "test-local-boot" },
  };
}

/**
 * @param {Awaited<ReturnType<typeof writeFixture>>} paths
 * @param {string} [out]
 * @param {string} [staging]
 */
export function lockArgs(paths, out = paths.lock, staging = paths.staging) {
  return ["lock", "--input", paths.capture, "--overlay", paths.overlay, "--out", out, "--staging-root", staging];
}

/**
 * @param {Awaited<ReturnType<typeof writeFixture>>} paths
 * @param {import("@aik/cli").CliHost} host
 * @param {string[]} [options]
 */
export function lockFixture(paths, host, options = []) {
  return runCli([...lockArgs(paths), ...options], host);
}

/**
 * @param {Awaited<ReturnType<typeof writeFixture>>} paths
 * @param {import("@aik/cli").CliHost} host
 */
export function compileFixture(paths, host) {
  return runCli(["compile", "--lock", paths.lock, "--out", paths.output], host);
}
