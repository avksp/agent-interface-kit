import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const argument = process.argv[2];
assert.ok(argument, "Pass a tarball from tools/pack-npm.mjs");
const tarball = resolve(argument);
/** @type {unknown} */
const manifest = JSON.parse(await readFile(join(dirname(tarball), "manifest.json"), "utf8"));
assert.ok(manifest && typeof manifest === "object" && "tarball" in manifest && typeof manifest.tarball === "string" &&
  "sha256" in manifest && typeof manifest.sha256 === "string" && "addonSha256" in manifest &&
  typeof manifest.addonSha256 === "string" && "files" in manifest && Array.isArray(manifest.files) &&
  manifest.files.every((file) => typeof file === "string"));
const addon = "packages/cli/dist/native/darwin-arm64/secure-fs.node";
const source = fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url));
const sandbox = "(version 1)(allow default)(deny network*)";
const env = { ...process.env };
delete env["NODE_OPTIONS"];
delete env["NODE_PATH"];

/** @param {string} file */
async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

assert.equal(basename(tarball), manifest.tarball);
assert.equal(await digest(tarball), manifest.sha256);
const paths = execFileSync("/usr/bin/tar", ["-tf", tarball], { encoding: "utf8" }).trimEnd().split("\n");
assert.deepEqual(paths.toSorted(), manifest.files.map((path) => "package/" + path).toSorted());
const archive = execFileSync("/usr/bin/tar", ["-tvf", tarball], { encoding: "utf8" }).trimEnd().split("\n");
assert.equal(archive.length, paths.length);
assert.ok(archive.every((line) => line.startsWith("-")), "Every archive entry must be a regular file");

/** @param {string[]} command @param {string} cwd */
async function exercise(command, cwd) {
  await mkdir(cwd);
  await mkdir(join(cwd, "capture"));
  await mkdir(join(cwd, "staging"), { mode: 0o700 });
  await writeFile(join(cwd, "capture", "snapshot.json"), JSON.stringify({
    schemaVersion: "aik.snapshot.v1", source: { adapter: "figma", version: "0.1.0" }, assets: [],
    roots: [{ id: "root", kind: "frame", sourceRef: "smoke:root", children: [{
      id: "text", kind: "text", sourceRef: "smoke:text", children: [], text: "AIK package smoke",
    }] }],
  }));
  await writeFile(join(cwd, "capture", "overlay.json"), JSON.stringify({ schemaVersion: "aik.overlay.v1", rules: [] }));
  const lock = join(cwd, "capture", "build.lock.json");
  const site = join(cwd, "site");
  const commands = [
    ["lock", "--input", join(cwd, "capture"), "--overlay", join(cwd, "capture", "overlay.json"),
      "--out", lock, "--staging-root", join(cwd, "staging")],
    ["compile", "--lock", lock, "--out", site],
    ["verify", "--manifest", join(site, "artifact-manifest.json")],
  ];
  for (const args of commands) {
    const output = execFileSync("/usr/bin/sandbox-exec", ["-p", sandbox, ...command, ...args], { cwd, env, encoding: "utf8" });
    /** @type {unknown} */
    const result = JSON.parse(output);
    assert.ok(result && typeof result === "object" && "status" in result && result.status === "ok", output);
  }
  assert.match(await readFile(join(site, "index.html"), "utf8"), /AIK package smoke/u);
  const outputs = (await readdir(site)).toSorted();
  assert.deepEqual(outputs, ["artifact-manifest.json", "index.html", "styles.css"]);
  return [await readFile(lock), ...await Promise.all(outputs.map((file) => readFile(join(site, file))))];
}

const scratch = await mkdtemp(join(await realpath(tmpdir()), "aik-npm-smoke-"));
try {
  const installation = join(scratch, "installation");
  await mkdir(installation);
  await writeFile(join(installation, "package.json"), '{"private":true}\n');
  execFileSync("npm", ["install", "--offline", "--cache", join(scratch, "empty-cache"), "--no-audit", "--no-fund", "--ignore-scripts", tarball],
    { cwd: installation, env, stdio: "inherit" });
  execFileSync("npm", ["ls", "--all", "--omit=dev"], { cwd: installation, env, stdio: "inherit" });
  const installed = join(installation, "node_modules", "agent-interface-kit");
  assert.equal(await digest(join(installed, addon)), manifest.addonSha256);
  const installedBin = join(installation, "node_modules", ".bin", "aik");
  assert.equal(await realpath(installedBin), join(installed, "packages", "cli", "src", "bin.js"));
  const baseline = await exercise([process.execPath, source], join(scratch, "source"));
  const packageBytes = await exercise([installedBin], join(scratch, "package"));
  assert.deepEqual(packageBytes, baseline);
  console.info(JSON.stringify({ status: "PASS", tarballSha256: manifest.sha256, addonSha256: manifest.addonSha256,
    parity: ["build.lock.json", "artifact-manifest.json", "index.html", "styles.css"],
    cacheAtInstallation: "empty", network: "denied", installScripts: "disabled" }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
