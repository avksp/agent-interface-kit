import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  ASSET_LIMIT, CompilerError, JSON_LIMIT, TOTAL_ASSET_LIMIT, buildDocument, canonicalJson, checkDistinctPaths, checkedPath, compareText,
  createLock, hash, isDiagnostic, isOverlay, isSnapshot, jsonBytes, parseJson, readLock, validateAssets,
  validateSnapshot,
} from "@aik/compile-core";
import type {
  ArtifactManifest, BuildLock, BuildOptions, DesignNode, Diagnostic, OutputTarget, Overlay, Snapshot, SourceAdapter, Toolchain,
} from "@aik/compile-core";
import { hasCode, LockPublicationError, publishLock, publishOutput, verifyOutput } from "@aik/compile-core/writer";
import type { Directory, ProcessIdentity, SecureFs } from "@aik/compile-core/writer";
import { readInput, relativePath, withInputRoot } from "./input.ts";
import { loadSecureFs } from "./secure-fs.ts";

export interface CliHost {
  sources: readonly SourceAdapter[];
  targets: readonly OutputTarget[];
  nodeVersion: string;
  trustedOutputParent: string;
  writer: ProcessIdentity;
}

export type CliResult =
  | { status: "error"; diagnostics: readonly Diagnostic[] }
  | { status: "ok"; buildId: string; lockPath: string }
  | { status: "ok"; buildId: string; manifest: ArtifactManifest; diagnostics: readonly Diagnostic[] }
  | { status: "ok"; manifest: ArtifactManifest };

interface Capture {
  snapshot: Snapshot;
  overlay: Overlay;
  snapshotDigest: string;
  overlayDigest: string;
  assets: ReadonlyMap<string, Uint8Array>;
}

function sourceReferences(roots: readonly DesignNode[]): Map<string, string> {
  const result = new Map<string, string>();
  function collect(node: DesignNode): void {
    if (node.asset !== undefined && !result.has(node.asset)) result.set(node.asset, node.sourceRef);
    for (const child of node.children) collect(child);
  }
  for (const root of roots) collect(root);
  return result;
}

function capture(fs: SecureFs, root: Directory, overlayPath: string, lock?: BuildLock): Capture {
  const snapshotBytes = readInput(fs, root, "snapshot.json", JSON_LIMIT, "MISSING_INPUT");
  const overlayBytes = readInput(fs, root, overlayPath, JSON_LIMIT, "MISSING_INPUT");
  const snapshotDigest = hash(snapshotBytes);
  const overlayDigest = hash(overlayBytes);
  if (lock && (snapshotDigest !== lock.inputs.snapshot.sha256 || overlayDigest !== lock.inputs.overlay.sha256)) {
    throw new CompilerError("INPUT_DIGEST_MISMATCH");
  }
  const snapshot = parseJson(snapshotBytes, "INVALID_SNAPSHOT");
  const overlay = parseJson(overlayBytes, "INVALID_OVERLAY");
  if (!isSnapshot(snapshot)) throw new CompilerError("INVALID_SNAPSHOT");
  if (!isOverlay(overlay)) throw new CompilerError("INVALID_OVERLAY");
  validateSnapshot(snapshot);
  if (overlay.sourceClosureSha256 !== undefined && overlay.sourceClosureSha256 !== snapshot.source.closureSha256) {
    throw new CompilerError("INVALID_OVERLAY");
  }

  const references = sourceReferences(snapshot.roots);
  const assets = new Map<string, Uint8Array>();
  let remaining = TOTAL_ASSET_LIMIT;
  for (const asset of snapshot.assets.toSorted((a, b) => compareText(a.path, b.path))) {
    const bytes = readInput(fs, root, asset.path, Math.min(ASSET_LIMIT, remaining), "MISSING_DEPENDENCY",
      references.get(asset.path) ?? null);
    assets.set(asset.path, bytes);
    remaining -= bytes.byteLength;
  }
  validateAssets(snapshot, assets);
  return { snapshot, overlay, snapshotDigest, overlayDigest, assets };
}

function bindPlugins(
  host: CliHost, snapshot: Snapshot, options: BuildOptions, inputError: string,
): { source: SourceAdapter; target: OutputTarget; toolchain: Toolchain } {
  const sources = host.sources.filter((plugin) => plugin.id === snapshot.source.adapter);
  const targets = host.targets.filter((plugin) => plugin.profile === options.profile);
  const [source] = sources;
  const [target] = targets;
  if (sources.length !== 1 || targets.length !== 1 || !source || !target || source.version !== snapshot.source.version) {
    throw new CompilerError(inputError);
  }
  const toolchain = {
    node: host.nodeVersion,
    sourceAdapter: source.id + "@" + source.version,
    snapshotSchema: snapshot.schemaVersion,
    core: "0.1.0",
    target: target.id + "@" + target.version,
    artifactManifestSchema: "aik-artifact-manifest.v1",
  };
  return { source, target, toolchain };
}

function lockContent(input: Capture, overlayPath: string, toolchain: Toolchain, options: BuildOptions): BuildLock {
  return createLock({
    snapshot: { path: "snapshot.json", sha256: input.snapshotDigest },
    overlay: { path: overlayPath, sha256: input.overlayDigest },
    assets: input.snapshot.assets.map(({ path, sha256 }) => ({ path, sha256 })),
    options, toolchain,
  });
}

function argumentsFor(args: readonly string[], names: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || value.startsWith("--") || !names.includes(name) || parsed.has(name)) {
      throw new CompilerError("INVALID_ARGUMENTS");
    }
    parsed.set(name, value);
  }
  return parsed;
}

function required(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (!value) throw new CompilerError("INVALID_ARGUMENTS");
  return value;
}

function lockOutputName(root: string, value: string): string {
  if (value.includes("\0")) throw new CompilerError("INVALID_LOCK");
  const absolute = isAbsolute(value);
  const raw = absolute ? value.slice(1) : value.replace(/^(?:\.\/)+/u, "");
  const components = raw.split("/");
  let parent = absolute ? "/" : process.cwd();
  for (const [index, component] of components.entries()) {
    if (parent === root) {
      if (index !== components.length - 1 || !component.endsWith(".json")) throw new CompilerError("INVALID_LOCK");
      return checkedPath(component, "INVALID_LOCK");
    }
    parent = resolve(parent, component);
  }
  throw new CompilerError("INVALID_LOCK");
}

async function lockCommand(args: readonly string[], host: CliHost, fs: SecureFs): Promise<CliResult> {
  const fields = argumentsFor(args, ["--input", "--overlay", "--out", "--staging-root", "--profile", "--naming"]);
  const rootPath = resolve(required(fields, "--input"));
  const overlayPath = relativePath(rootPath, required(fields, "--overlay"), "INVALID_OVERLAY");
  const lockPath = lockOutputName(rootPath, required(fields, "--out"));
  const stagingPath = required(fields, "--staging-root");
  if (!isAbsolute(stagingPath) || stagingPath.includes("\0")) throw new CompilerError("INVALID_ARGUMENTS");
  const naming = fields.get("--naming") ?? "plain";
  if (naming !== "plain" && naming !== "bem") throw new CompilerError("INVALID_ARGUMENTS");
  const options: BuildOptions = { profile: fields.get("--profile") ?? "site-v1", naming };
  let root: Directory;
  try {
    root = fs.openRoot(rootPath);
  } catch {
    throw new CompilerError("MISSING_INPUT");
  }
  let prepared: { lock: BuildLock; bytes: Uint8Array; parent: Directory };
  try {
    const input = capture(fs, root, overlayPath);
    const { toolchain } = bindPlugins(host, input.snapshot, options, "UNSUPPORTED_PLUGIN");
    const lock = lockContent(input, overlayPath, toolchain, options);
    checkLockPath(lockPath, lock);
    buildDocument(input.snapshot, input.snapshot.roots, input.overlay);
    const bytes = jsonBytes(lock);
    let parent: Directory;
    try {
      parent = fs.openRoot(stagingPath);
    } catch (error) {
      if (error instanceof TypeError || ["EACCES", "ENOENT", "ENOTDIR", "ELOOP"].some((code) => hasCode(error, code))) {
        throw new CompilerError("INVALID_LOCK");
      }
      throw error;
    }
    prepared = { lock, bytes, parent };
  } catch (error) {
    try {
      fs.closeDirectory(root);
    } catch {
      const primary = error instanceof CompilerError ? error.diagnostic : new CompilerError("IO_ERROR").diagnostic;
      throw new LockPublicationError([primary, {
        code: "IO_ERROR", severity: "warning", feature: "lock-capture-close", sourceRef: null,
      }]);
    }
    throw error;
  }
  await publishLock(root, prepared.parent, lockPath, prepared.bytes, fs);
  return { status: "ok", buildId: prepared.lock.buildId, lockPath };
}

function checkLockPath(path: string, lock: BuildLock): void {
  const { snapshot, overlay, assets } = lock.inputs;
  checkDistinctPaths([path, snapshot.path, overlay.path, ...assets.map((file) => file.path)], "INVALID_LOCK");
}

async function compileCommand(args: readonly string[], host: CliHost, fs: SecureFs): Promise<CliResult> {
  const fields = argumentsFor(args, ["--lock", "--out"]);
  const path = resolve(required(fields, "--lock"));
  return await withInputRoot(fs, dirname(path), "INVALID_LOCK", async (root) => {
    const lock = readLock(readInput(fs, root, basename(path), JSON_LIMIT, "INVALID_LOCK"));
    checkLockPath(basename(path), lock);
    const input = capture(fs, root, lock.inputs.overlay.path, lock);
    const { source, target, toolchain } = bindPlugins(host, input.snapshot, lock.options, "INVALID_LOCK");
    if (canonicalJson(toolchain) !== canonicalJson(lock.toolchain)) throw new CompilerError("INVALID_LOCK");
    const current = lockContent(input, lock.inputs.overlay.path, toolchain, lock.options);
    if (current.buildId !== lock.buildId) throw new CompilerError("INPUT_DIGEST_MISMATCH");
    const doc = buildDocument(input.snapshot, source.normalize(input.snapshot), input.overlay);
    const rendered = target.render(doc, input.assets, lock.options);
    const unsorted = rendered.diagnostics ?? [];
    if (!unsorted.every((diagnostic) => isDiagnostic(diagnostic))) throw new CompilerError("INVALID_OUTPUT");
    const diagnostics = unsorted.toSorted((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { status: "error", diagnostics };
    const manifest = await publishOutput(required(fields, "--out"), host.trustedOutputParent, rendered.files, host.writer, fs);
    return { status: "ok", buildId: lock.buildId, manifest, diagnostics };
  });
}

export async function runCli(args: readonly string[], host: CliHost): Promise<CliResult> {
  try {
    const [command, ...fields] = args;
    const fs = loadSecureFs();
    if (command === "lock") return await lockCommand(fields, host, fs);
    if (command === "compile") return await compileCommand(fields, host, fs);
    if (command === "verify") {
      const manifestPath = required(argumentsFor(fields, ["--manifest"]), "--manifest");
      return { status: "ok", manifest: await verifyOutput(manifestPath, fs) };
    }
    throw new CompilerError("INVALID_ARGUMENTS");
  } catch (error) {
    if (error instanceof LockPublicationError) return { status: "error", diagnostics: error.diagnostics };
    const failure = error instanceof CompilerError ? error : new CompilerError("IO_ERROR");
    return { status: "error", diagnostics: [failure.diagnostic] };
  }
}
