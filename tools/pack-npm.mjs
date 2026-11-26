import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import lock from "../package-lock.json" with { type: "json" };
import project from "../package.json" with { type: "json" };
import cli from "../packages/cli/package.json" with { type: "json" };

const repo = fileURLToPath(new URL("../", import.meta.url));
const packageName = "agent-interface-kit";
const addon = "packages/cli/dist/native/darwin-arm64/secure-fs.node";
const bin = "packages/cli/src/bin.js";
const schemas = ["artifact-manifest", "build-lock", "diagnostic", "overlay", "snapshot", "ui-document"];
const runtimeFiles = [
  bin,
  "packages/cli/src/commands/index.js",
  "packages/cli/src/commands/input.js",
  "packages/cli/src/commands/secure-fs.js",
  "packages/compile-core/src/build.js",
  "packages/compile-core/src/contracts.js",
  "packages/compile-core/src/document.js",
  "packages/compile-core/src/index.js",
  "packages/compile-core/src/json-structure.js",
  "packages/compile-core/src/json.js",
  "packages/compile-core/src/raster.js",
  "packages/compile-core/src/writer/filesystem.js",
  "packages/compile-core/src/writer/index.js",
  "packages/source-figma/src/index.js",
  "packages/target-html/src/index.js",
  "packages/target-html/src/styles.js",
];
const dependencyNames = /** @type {const} */ (["ajv", "fast-deep-equal", "fast-uri", "json-schema-traverse",
  "require-from-string"]);
const packageFiles = ["LICENSE", "README.md", "package.json", "dependencies.lock.json", addon,
  ...runtimeFiles, ...schemas.map((schema) => "schemas/" + schema + ".v1.schema.json")].toSorted();

/** @typedef {{version: string, resolved: string, integrity: string, dev?: boolean, hasInstallScript?: boolean,
 * dependencies?: Record<string, string>}} LockedDependency */

/** @param {string} path @param {unknown} value */
async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

/** @param {string} stage @param {string} directory */
async function regularFiles(stage, directory) {
  assert.ok((await lstat(directory)).isDirectory());
  const entries = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => !entry.isDirectory());
  assert.ok(entries.every((entry) => entry.isFile()));
  return entries.map((entry) => relative(stage, join(entry.parentPath, entry.name)));
}

/** @param {string} stage @param {typeof runtimeFiles} files */
async function rewriteAliases(stage, files) {
  for (const path of files) {
    const output = join(stage, path);
    const source = await readFile(output, "utf8");
    const rewritten = source
      .replaceAll('from "@aik/compile-core/writer"', 'from "../../../compile-core/src/writer/index.js"')
      .replaceAll('from "@aik/compile-core"', 'from "../../../compile-core/src/index.js"');
    assert.ok(!rewritten.includes('from "@aik/'));
    if (rewritten !== source) {
      assert.ok(path.startsWith("packages/cli/src/commands/"));
      await writeFile(output, rewritten);
    }
  }
}

assert.match(cli.version, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
assert.equal(process.platform + "/" + process.arch, "darwin/arm64");
assert.equal(process.version, "v" + (await readFile(join(repo, ".nvmrc"), "utf8")).trim());

const dependencies = /** @type {Record<string, LockedDependency>} */ ({});
for (const name of dependencyNames) {
  const key = /** @type {const} */ (`node_modules/${name}`);
  const entry = lock.packages[key];
  assert.ok(entry && !("dev" in entry && entry.dev) && !("hasInstallScript" in entry && entry.hasInstallScript), key);
  const url = new URL(entry.resolved);
  assert.equal(url.origin, "https://registry.npmjs.org");
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/=]+$/u);
  dependencies[key] = { version: entry.version, resolved: entry.resolved, integrity: entry.integrity,
    ...("dependencies" in entry ? { dependencies: entry.dependencies } : {}) };
}
const ajv = dependencies["node_modules/ajv"];
assert.ok(ajv);
const reachable = new Set(["ajv"]);
for (const name of reachable) {
  const entry = dependencies["node_modules/" + name];
  assert.ok(entry, name);
  for (const child of Object.keys(entry.dependencies ?? {})) reachable.add(child);
}
assert.deepEqual([...reachable].toSorted(), dependencyNames.toSorted());

const out = resolve(process.argv[2] ?? "dist/npm");
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const stage = await mkdtemp(join(tmpdir(), "aik-npm-pack-"));
try {
  execFileSync("npm", ["run", "build:secure-fs"], { cwd: repo, stdio: "inherit",
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "15.0" } });
  const binary = join(repo, addon);
  assert.equal(execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim(), "arm64");
  const platform = execFileSync("/usr/bin/xcrun", ["vtool", "-show-build", binary], { encoding: "utf8" });
  assert.match(platform, /\bminos\s+15\.0(?:\.0)?\s/u);
  const links = execFileSync("/usr/bin/otool", ["-L", binary], { encoding: "utf8" }).trimEnd().split("\n").slice(1);
  assert.ok(links.every((line) => /^\s*\/usr\/lib\//u.test(line) || /^\s*\/System\/Library\//u.test(line)));
  execFileSync(join(repo, "node_modules/.bin/tsc"), ["--project", "tsconfig.release.json", "--outDir", stage],
    { cwd: repo, stdio: "inherit" });
  await rewriteAliases(stage, runtimeFiles);
  const entrypoint = join(stage, bin);
  assert.ok((await readFile(entrypoint, "utf8")).startsWith("#!/usr/bin/env node\n"));
  await chmod(entrypoint, 0o755);
  await mkdir(dirname(join(stage, addon)), { recursive: true });
  await copyFile(binary, join(stage, addon));
  for (const path of ["README.md", "LICENSE"]) await copyFile(join(repo, path), join(stage, path));

  const metadata = {
    name: packageName, version: cli.version, description: "Deterministic Figma-to-HTML/CSS compiler",
    license: "Apache-2.0", type: "module", bin: { aik: bin }, engines: project.engines,
    os: ["darwin"], cpu: ["arm64"], dependencies: { ajv: ajv.version },
    bundleDependencies: ["ajv"],
    repository: { type: "git", url: "git+https://github.com/avksp/agent-interface-kit.git" },
    publishConfig: { access: "public" },
  };
  await writeJson(join(stage, "package.json"), metadata);
  await writeJson(join(stage, "package-lock.json"), {
    name: metadata.name, version: metadata.version, lockfileVersion: 3, requires: true,
    packages: { "": { name: metadata.name, version: metadata.version, license: metadata.license,
      dependencies: metadata.dependencies, bundleDependencies: metadata.bundleDependencies,
      bin: metadata.bin, engines: metadata.engines, os: metadata.os, cpu: metadata.cpu },
    ...dependencies },
  });
  execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
  await writeJson(join(stage, "dependencies.lock.json"), { lockfileVersion: 3, packages: dependencies });
  const vendorFiles = [];
  for (const name of dependencyNames) {
    const directory = join(stage, "node_modules", name);
    const expected = dependencies["node_modules/" + name];
    /** @type {unknown} */
    const installed = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert.ok(expected && installed && typeof installed === "object" && "name" in installed &&
      installed.name === name && "version" in installed && installed.version === expected.version);
    vendorFiles.push(...await regularFiles(stage, directory));
  }
  const approvedFiles = [...packageFiles, ...vendorFiles].toSorted();
  const temporaryFiles = new Set(["package-lock.json", "node_modules/.package-lock.json"]);
  const staged = (await regularFiles(stage, stage)).filter((path) => !temporaryFiles.has(path)).toSorted();
  assert.deepEqual(staged, approvedFiles);
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", out], { cwd: stage, stdio: "inherit" });
  const filename = packageName + "-" + cli.version + ".tgz";
  assert.deepEqual(await readdir(out), [filename]);
  const tarball = join(out, filename);
  const archived = execFileSync("/usr/bin/tar", ["-tf", tarball], { encoding: "utf8" }).trimEnd().split("\n");
  assert.deepEqual(archived.toSorted(), approvedFiles.map((path) => "package/" + path));
  const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await writeJson(join(out, "manifest.json"), {
    name: packageName, version: cli.version, tarball: filename, sha256,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    tag: "v" + cli.version, files: approvedFiles, addonSha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
  });
  console.info(tarball);
} finally {
  await rm(stage, { recursive: true, force: true });
}
