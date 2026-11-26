import { CompilerError } from "./contracts.ts";
import type { BuildLock, BuildOptions, FileRef, Toolchain, VirtualFile, ArtifactManifest } from "./contracts.ts";
import { canonicalJson, checkedPath, checkDistinctPaths, compareText, hash, isArtifactManifest, isBuildLock, parseJson } from "./json.ts";

export const MANIFEST_NAME = "artifact-manifest.json";

interface LockSource {
  snapshot: FileRef;
  overlay: FileRef;
  assets: readonly FileRef[];
  toolchain: Toolchain;
  options: BuildOptions;
}

export function createLock(source: LockSource): BuildLock {
  const body: Omit<BuildLock, "buildId"> = {
    schemaVersion: "aik.build-lock.v1",
    inputs: {
      snapshot: source.snapshot,
      overlay: source.overlay,
      catalog: null,
      assets: source.assets.toSorted((a, b) => compareText(a.path, b.path)),
    },
    toolchain: source.toolchain,
    options: source.options,
  };
  const lock: BuildLock = { ...body, buildId: hash(Buffer.from(canonicalJson(body))) };
  if (!isBuildLock(lock)) throw new CompilerError("INVALID_LOCK");
  checkLockPaths(lock);
  return lock;
}

function checkLockPaths(lock: BuildLock): void {
  if (lock.inputs.snapshot.path !== "snapshot.json") throw new CompilerError("INVALID_LOCK");
  checkDistinctPaths([
    lock.inputs.snapshot.path, lock.inputs.overlay.path, ...lock.inputs.assets.map(({ path }) => path),
  ], "INVALID_LOCK");
}

export function readLock(bytes: Uint8Array): BuildLock {
  const lock = parseJson(bytes, "INVALID_LOCK");
  if (!isBuildLock(lock)) throw new CompilerError("INVALID_LOCK");
  const expected = createLock({
    snapshot: lock.inputs.snapshot,
    overlay: lock.inputs.overlay,
    assets: lock.inputs.assets,
    toolchain: lock.toolchain,
    options: lock.options,
  });
  if (canonicalJson(expected) !== canonicalJson(lock) ||
      !Buffer.from(bytes).equals(Buffer.from(canonicalJson(expected) + "\n"))) {
    throw new CompilerError("INVALID_LOCK");
  }
  return lock;
}

export function makeArtifactManifest(files: readonly VirtualFile[]): ArtifactManifest {
  checkDistinctPaths([MANIFEST_NAME, ...files.map(({ path }) => path)], "INVALID_OUTPUT");
  const manifest: ArtifactManifest = {
    schemaVersion: "aik-artifact-manifest.v1",
    files: files.toSorted((a, b) => compareText(a.path, b.path)).map(({ path, mediaType, bytes }) =>
      ({ path, mediaType, sha256: hash(bytes) })),
  };
  if (!isArtifactManifest(manifest)) throw new CompilerError("INVALID_OUTPUT");
  return manifest;
}

export function readArtifactManifest(bytes: Uint8Array): ArtifactManifest {
  const manifest = parseJson(bytes, "OUTPUT_DRIFT");
  if (!isArtifactManifest(manifest)) throw new CompilerError("OUTPUT_DRIFT");
  checkDistinctPaths([MANIFEST_NAME, ...manifest.files.map(({ path }) => checkedPath(path, "OUTPUT_DRIFT"))], "OUTPUT_DRIFT");
  return manifest;
}
