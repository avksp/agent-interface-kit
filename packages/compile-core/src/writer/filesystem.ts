export type Directory = object;
export type LockStage = object;

export interface SecureFs {
  openRoot(path: string): Directory;
  openDirectory(parent: Directory, name: string): Directory;
  closeDirectory(directory: Directory): void;
  readFile(parent: Directory, name: string, limit: number, compareLock?: boolean): Buffer;
  writeFile(parent: Directory, name: string, bytes: Buffer): void;
  createDirectory(parent: Directory, name: string): void;
  qualifyLockStaging(capture: Directory, parent: Directory): void;
  acquireLockGuard(capture: Directory): Directory;
  createLockStage(parent: Directory): LockStage;
  openLockStage(parent: Directory, stage: LockStage): Directory;
  removeLockStage(parent: Directory, stage: LockStage): void;
  unlinkEntry(parent: Directory, name: string, directory: boolean): void;
  renameExclusive(from: Directory, name: string, to: Directory, destination: string): void;
  visit(parent: Directory, use: (name: string) => void, maxEntries?: number): void;
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function withDirectory<T>(
  fs: SecureFs, root: Directory, components: readonly string[], use: (directory: Directory) => T,
  create = false,
): T {
  let current = root;
  try {
    for (const component of components) {
      if (create) {
        try {
          fs.createDirectory(current, component);
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
      const next = fs.openDirectory(current, component);
      if (current !== root) fs.closeDirectory(current);
      current = next;
    }
    return use(current);
  } finally {
    if (current !== root) fs.closeDirectory(current);
  }
}
