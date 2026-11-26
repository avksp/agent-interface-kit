import { basename, dirname, resolve } from "node:path";
import { CompilerError } from "../contracts.ts";
import type { ArtifactManifest, Diagnostic, VirtualFile } from "../contracts.ts";
import { MANIFEST_NAME, makeArtifactManifest, readArtifactManifest } from "../build.ts";
import { JSON_LIMIT, checkedPath, compareText, hash, jsonBytes } from "../json.ts";
import { hasCode, withDirectory } from "./filesystem.ts";
import type { Directory, LockStage, SecureFs } from "./filesystem.ts";

export { hasCode, withDirectory } from "./filesystem.ts";
export type { Directory, SecureFs } from "./filesystem.ts";

export interface ProcessIdentity {
  pid: number;
  bootId: string;
}

const MAX_FILES = 4096;
const LOCK_ENTRY_LIMIT = 4096;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_BYTES = 64 * 1024 * 1024;

function layout(destination: string, permittedParent: string) {
  const parentPath = resolve(permittedParent);
  const output = resolve(destination);
  const name = checkedPath(basename(output), "INVALID_OUTPUT");
  if (dirname(output) !== parentPath) throw new CompilerError("INVALID_OUTPUT");
  const identity = hash(Buffer.from(name.toLowerCase())).slice(0, 32);
  return { parentPath, name, reservation: ".aik-" + identity + ".reservation",
    staging: ".aik-" + identity + ".stage", recovery: ".aik-" + identity + ".recovery" };
}

function openRoot(fs: SecureFs, path: string, code: string): Directory {
  try {
    return fs.openRoot(resolve(path));
  } catch {
    throw new CompilerError(code);
  }
}

function exclusiveDirectory(fs: SecureFs, dir: Directory, name: string): void {
  try {
    fs.createDirectory(dir, name);
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new CompilerError("OUTPUT_BUSY");
    throw error;
  }
}

function findDirectory(fs: SecureFs, parent: Directory, name: string, code: string): Directory | undefined {
  try {
    return fs.openDirectory(parent, name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new CompilerError(code);
  }
}

function readFile(fs: SecureFs, parent: Directory, name: string, limit: number, code: string): Buffer {
  try {
    return fs.readFile(parent, name, limit);
  } catch {
    throw new CompilerError(code);
  }
}

function verifyTree(
  fs: SecureFs, directory: Directory, manifest: ArtifactManifest, lengths?: ReadonlyMap<string, number>,
): void {
  if (manifest.files.length > MAX_FILES) throw new CompilerError("OUTPUT_DRIFT");
  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) {
      directories.add(parts.slice(0, length).join("/"));
    }
  }
  const seen = new Set<string>();
  let remaining = MAX_TREE_BYTES;
  function walk(parent: Directory, prefix: string): void {
    fs.visit(parent, (name) => {
      const path = prefix + name;
      if (directories.has(path)) {
        withDirectory(fs, parent, [name], (child) => walk(child, path + "/"));
        return;
      }
      if (path === MANIFEST_NAME) {
        seen.add(path);
        return;
      }
      const digest = expected.get(path);
      if (digest === undefined || seen.has(path)) throw new CompilerError("OUTPUT_DRIFT");
      const exactLength = lengths?.get(path);
      const limit = Math.min(exactLength ?? MAX_FILE_BYTES, remaining);
      const bytes = readFile(fs, parent, name, limit, "OUTPUT_DRIFT");
      if ((exactLength !== undefined && bytes.byteLength !== exactLength) || hash(bytes) !== digest) {
        throw new CompilerError("OUTPUT_DRIFT");
      }
      remaining -= bytes.byteLength;
      seen.add(path);
    });
  }
  try {
    walk(directory, "");
  } catch {
    throw new CompilerError("OUTPUT_DRIFT");
  }
  if (seen.size !== expected.size + 1 || !seen.has(MANIFEST_NAME)) throw new CompilerError("OUTPUT_DRIFT");
}

export async function verifyOutput(manifestPath: string, fs: SecureFs): Promise<ArtifactManifest> {
  if (basename(manifestPath) !== MANIFEST_NAME) throw new CompilerError("OUTPUT_DRIFT");
  checkedPath(basename(dirname(resolve(manifestPath))), "OUTPUT_DRIFT");
  const directory = openRoot(fs, dirname(manifestPath), "OUTPUT_DRIFT");
  try {
    const bytes = readFile(fs, directory, MANIFEST_NAME, JSON_LIMIT, "OUTPUT_DRIFT");
    const manifest = readArtifactManifest(bytes);
    const sorted = manifest.files.toSorted((a, b) => compareText(a.path, b.path));
    if (!bytes.equals(jsonBytes({ ...manifest, files: sorted }))) throw new CompilerError("OUTPUT_DRIFT");
    verifyTree(fs, directory, manifest);
    return manifest;
  } finally {
    fs.closeDirectory(directory);
  }
}

function checkManifest(fs: SecureFs, directory: Directory, requested: Uint8Array): void {
  const actual = readFile(fs, directory, MANIFEST_NAME, requested.byteLength, "OUTPUT_DRIFT");
  if (!actual.equals(requested)) throw new CompilerError("OUTPUT_DRIFT");
}

function requireExactName(fs: SecureFs, parent: Directory, name: string, code: string): void {
  const matched = Symbol();
  try {
    fs.visit(parent, (entry) => {
      if (entry === name) throw matched;
    });
  } catch (error) {
    if (error === matched) return;
  }
  throw new CompilerError(code);
}

function checkExistingOutput(
  fs: SecureFs, parent: Directory, name: string, manifest: ArtifactManifest, requested: Uint8Array,
  lengths: ReadonlyMap<string, number>,
): boolean {
  const directory = findDirectory(fs, parent, name, "OUTPUT_DRIFT");
  if (!directory) return false;
  try {
    checkManifest(fs, directory, requested);
    requireExactName(fs, parent, name, "OUTPUT_DRIFT");
    verifyTree(fs, directory, manifest, lengths);
    return true;
  } finally {
    fs.closeDirectory(directory);
  }
}

function isIdentity(value: unknown): value is ProcessIdentity {
  return typeof value === "object" && value !== null &&
    "pid" in value && typeof value.pid === "number" && Number.isSafeInteger(value.pid) &&
    value.pid > 0 && "bootId" in value && typeof value.bootId === "string" &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(value.bootId);
}

function ignoreAbsent(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

function removeReservation(fs: SecureFs, parent: Directory, name: string): void {
  withDirectory(fs, parent, [name], (reservation) => ignoreAbsent(() => fs.unlinkEntry(reservation, "owner.json", false)));
  fs.unlinkEntry(parent, name, true);
}

function claimReservation(fs: SecureFs, parent: Directory, paths: ReturnType<typeof layout>, identity: ProcessIdentity): void {
  exclusiveDirectory(fs, parent, paths.recovery);
  try {
    exclusiveDirectory(fs, parent, paths.reservation);
    try {
      withDirectory(fs, parent, [paths.reservation], (reservation) => {
        fs.writeFile(reservation, "owner.json", Buffer.from(jsonBytes(identity)));
      });
    } catch (error) {
      removeReservation(fs, parent, paths.reservation);
      throw error;
    }
  } finally {
    fs.unlinkEntry(parent, paths.recovery, true);
  }
}

function removeKnownStage(fs: SecureFs, stage: Directory, files: ReadonlyMap<string, number>): void {
  const directories = new Set<string>();
  for (const path of [...files.keys(), MANIFEST_NAME]) {
    const components = path.split("/");
    const name = components.pop() ?? "";
    for (let depth = 1; depth <= components.length; depth++) {
      directories.add(components.slice(0, depth).join("/"));
    }
    ignoreAbsent(() => withDirectory(fs, stage, components, (dir) => fs.unlinkEntry(dir, name, false)));
  }
  for (const path of [...directories].toSorted((a, b) => b.length - a.length)) {
    const components = path.split("/");
    const name = components.pop() ?? "";
    ignoreAbsent(() => withDirectory(fs, stage, components, (dir) => fs.unlinkEntry(dir, name, true)));
  }
}

function writeStage(
  fs: SecureFs, parent: Directory, paths: ReturnType<typeof layout>, files: readonly VirtualFile[],
  manifest: ArtifactManifest, manifestBytes: Uint8Array, lengths: ReadonlyMap<string, number>,
): void {
  exclusiveDirectory(fs, parent, paths.staging);
  const stage = fs.openDirectory(parent, paths.staging);
  let published = false;
  try {
    for (const file of files) {
      const components = file.path.split("/");
      const name = components.pop() ?? "";
      withDirectory(fs, stage, components, (dir) => fs.writeFile(dir, name, Buffer.from(file.bytes)), true);
    }
    fs.writeFile(stage, MANIFEST_NAME, Buffer.from(manifestBytes));
    checkManifest(fs, stage, manifestBytes);
    verifyTree(fs, stage, manifest, lengths);
    try {
      fs.renameExclusive(parent, paths.staging, parent, paths.name);
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new CompilerError("OUTPUT_DRIFT");
      throw error;
    }
    published = true;
  } finally {
    try {
      if (!published) {
        try {
          removeKnownStage(fs, stage, lengths);
          fs.unlinkEntry(parent, paths.staging, true);
        } catch {
          // Preserve the primary failure. A changed staging tree remains reserved for recovery.
        }
      }
    } finally {
      fs.closeDirectory(stage);
    }
  }
}

export async function publishOutput(
  destination: string, permittedParent: string, files: readonly VirtualFile[], identity: ProcessIdentity, fs: SecureFs,
): Promise<ArtifactManifest> {
  if (!isIdentity(identity) || files.length > MAX_FILES) throw new CompilerError("INVALID_OUTPUT");
  const paths = layout(destination, permittedParent);
  let remaining = MAX_TREE_BYTES;
  const lengths = new Map<string, number>();
  for (const file of files) {
    const size = file.bytes.byteLength;
    if (size > MAX_FILE_BYTES || size > remaining) throw new CompilerError("INVALID_OUTPUT");
    remaining -= size;
    lengths.set(file.path, size);
  }
  const manifest = makeArtifactManifest(files);
  const manifestBytes = jsonBytes(manifest);
  if (manifestBytes.byteLength > JSON_LIMIT) throw new CompilerError("INVALID_OUTPUT");
  const parent = openRoot(fs, paths.parentPath, "INVALID_OUTPUT");
  try {
    checkExistingOutput(fs, parent, paths.name, manifest, manifestBytes, lengths);
    claimReservation(fs, parent, paths, identity);
    try {
      await Promise.resolve();
      const stale = findDirectory(fs, parent, paths.staging, "OUTPUT_BUSY");
      if (stale) {
        fs.closeDirectory(stale);
        throw new CompilerError("OUTPUT_BUSY");
      }
      if (!checkExistingOutput(fs, parent, paths.name, manifest, manifestBytes, lengths)) {
        writeStage(fs, parent, paths, files, manifest, manifestBytes, lengths);
      }
      return manifest;
    } finally {
      removeReservation(fs, parent, paths.reservation);
    }
  } finally {
    fs.closeDirectory(parent);
  }
}

export async function recoverOutput(
  destination: string, permittedParent: string, bootId: string,
  isProcessAlive: (pid: number) => boolean, fs: SecureFs,
): Promise<void> {
  if (!isIdentity({ pid: 1, bootId })) throw new CompilerError("INVALID_OUTPUT");
  const paths = layout(destination, permittedParent);
  const parent = openRoot(fs, paths.parentPath, "INVALID_OUTPUT");
  try {
    exclusiveDirectory(fs, parent, paths.recovery);
    try {
      const reservation = findDirectory(fs, parent, paths.reservation, "OUTPUT_BUSY");
      if (!reservation) return;
      let owner: unknown;
      try {
        owner = JSON.parse(readFile(fs, reservation, "owner.json", 2048, "OUTPUT_BUSY").toString("utf8"));
      } catch {
        throw new CompilerError("OUTPUT_BUSY");
      } finally {
        fs.closeDirectory(reservation);
      }
      if (!isIdentity(owner) || (owner.bootId === bootId && isProcessAlive(owner.pid))) {
        throw new CompilerError("OUTPUT_BUSY");
      }
      const stage = findDirectory(fs, parent, paths.staging, "OUTPUT_BUSY");
      if (stage) {
        let remaining = MAX_FILES * 33 + 1;
        function clear(dir: Directory, prefix: string): void {
          fs.visit(dir, (name) => {
            const path = checkedPath(prefix + name, "OUTPUT_BUSY");
            if (remaining-- === 0) throw new CompilerError("OUTPUT_BUSY");
            let child: Directory;
            try {
              child = fs.openDirectory(dir, name);
            } catch (error) {
              if (!hasCode(error, "ENOTDIR") && !hasCode(error, "ELOOP")) throw error;
              fs.unlinkEntry(dir, name, false);
              return;
            }
            try {
              clear(child, path + "/");
            } finally {
              fs.closeDirectory(child);
            }
            fs.unlinkEntry(dir, name, true);
          });
        }
        try {
          clear(stage, "");
        } finally {
          fs.closeDirectory(stage);
        }
        fs.unlinkEntry(parent, paths.staging, true);
      }
      removeReservation(fs, parent, paths.reservation);
    } finally {
      fs.unlinkEntry(parent, paths.recovery, true);
    }
  } finally {
    fs.closeDirectory(parent);
  }
}

function lockNameExists(fs: SecureFs, root: Directory, name: string): boolean {
  const folded = name.toLowerCase();
  let exact = false;
  let entries = 0;
  try {
    fs.visit(root, (entry) => {
      entries++;
      if (entry.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()) === folded) {
        if (entry !== name) throw new CompilerError("INVALID_LOCK");
        exact = true;
      }
    }, LOCK_ENTRY_LIMIT);
  } catch (error) {
    if (hasCode(error, "ENTRY_LIMIT")) throw new CompilerError("INVALID_LOCK");
    throw error;
  }
  if (!exact && entries === LOCK_ENTRY_LIMIT) throw new CompilerError("INVALID_LOCK");
  return exact;
}

function checkExistingLock(fs: SecureFs, root: Directory, name: string, bytes: Uint8Array): boolean {
  if (!lockNameExists(fs, root, name)) return false;
  let existing: Buffer;
  try {
    existing = fs.readFile(root, name, bytes.byteLength, true);
  } catch (error) {
    if (["INVALID_FILE", "EFBIG", "ELOOP", "ENOENT"].some((code) => hasCode(error, code))) {
      throw new CompilerError("INVALID_LOCK");
    }
    throw error;
  }
  if (!existing.equals(bytes) || !lockNameExists(fs, root, name)) throw new CompilerError("INVALID_LOCK");
  return true;
}

export class LockPublicationError extends CompilerError {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics[0]?.code ?? "IO_ERROR");
    this.diagnostics = diagnostics;
  }
}

function lockCleanup(failures: Diagnostic[], feature: string, action: () => void): void {
  try {
    action();
  } catch {
    failures.push({ code: "IO_ERROR", severity: failures.length ? "warning" : "error", feature, sourceRef: null });
  }
}

function acquirePublication(fs: SecureFs, capture: Directory, stagingParent: Directory): Directory {
  try {
    fs.qualifyLockStaging(capture, stagingParent);
  } catch (error) {
    if (hasCode(error, "ENOTSUP")) throw new CompilerError("UNSUPPORTED_HOST");
    if (hasCode(error, "EACCES")) throw new CompilerError("INVALID_LOCK");
    throw error;
  }
  try {
    return fs.acquireLockGuard(capture);
  } catch (error) {
    if (hasCode(error, "ENOTSUP")) throw new CompilerError("UNSUPPORTED_HOST");
    if (hasCode(error, "EAGAIN")) throw new CompilerError("OUTPUT_BUSY");
    throw error;
  }
}

/** Publish the lock and close the two transferred parent handles. */
export async function publishLock(
  root: Directory, parent: Directory, name: string, bytes: Uint8Array, fs: SecureFs,
): Promise<void> {
  const failures: Diagnostic[] = [];
  let guard: Directory | undefined;
  let token: LockStage | undefined;
  let stage: Directory | undefined;
  try {
    checkedPath(name, "INVALID_LOCK");
    if (bytes.byteLength > JSON_LIMIT) throw new CompilerError("INPUT_LIMIT_EXCEEDED");
    guard = acquirePublication(fs, root, parent);
    if (!checkExistingLock(fs, root, name, bytes)) {
      token = fs.createLockStage(parent);
      stage = fs.openLockStage(parent, token);
      fs.writeFile(stage, "lock", Buffer.from(bytes));
      try {
        fs.renameExclusive(stage, "lock", root, name);
      } catch (error) {
        if (hasCode(error, "ENOTSUP")) throw new CompilerError("UNSUPPORTED_HOST");
        if (!hasCode(error, "EEXIST")) throw error;
        if (!checkExistingLock(fs, root, name, bytes)) throw new CompilerError("INVALID_LOCK");
      }
    }
  } catch (error) {
    failures.push(error instanceof CompilerError ? error.diagnostic : new CompilerError("IO_ERROR").diagnostic);
    if (hasCode(error, "UNVERIFIED_STAGE")) {
      failures.push({ code: "IO_ERROR", severity: "warning", feature: "lock-stage-directory-remove", sourceRef: null });
    }
  }
  const openedStage = stage;
  if (openedStage) {
    lockCleanup(failures, "lock-stage-file-remove", () => ignoreAbsent(() => fs.unlinkEntry(openedStage, "lock", false)));
  }
  const ownedToken = token;
  if (ownedToken) lockCleanup(failures, "lock-stage-directory-remove", () => fs.removeLockStage(parent, ownedToken));
  if (openedStage) lockCleanup(failures, "lock-stage-close", () => fs.closeDirectory(openedStage));
  lockCleanup(failures, "lock-staging-parent-close", () => fs.closeDirectory(parent));
  lockCleanup(failures, "lock-capture-close", () => fs.closeDirectory(root));
  const heldGuard = guard;
  if (heldGuard) lockCleanup(failures, "lock-guard-release", () => fs.closeDirectory(heldGuard));
  if (failures.length) throw new LockPublicationError(failures);
}
