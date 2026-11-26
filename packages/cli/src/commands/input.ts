import { relative, resolve, sep } from "node:path";
import { CompilerError, checkedPath } from "@aik/compile-core";
import { hasCode, withDirectory } from "@aik/compile-core/writer";
import type { Directory, SecureFs } from "@aik/compile-core/writer";

export function relativePath(root: string, absolute: string, code: string): string {
  return checkedPath(relative(root, resolve(absolute)).split(sep).join("/"), code);
}

export async function withInputRoot<T>(
  fs: SecureFs, path: string, code: string, use: (root: Directory) => Promise<T>,
): Promise<T> {
  let root: Directory;
  try {
    root = fs.openRoot(path);
  } catch {
    throw new CompilerError(code);
  }
  try {
    return await use(root);
  } finally {
    fs.closeDirectory(root);
  }
}

export function readInput(
  fs: SecureFs, root: Directory, path: string, limit: number, invalidCode: string, sourceRef: string | null = null,
): Buffer {
  const components = checkedPath(path, invalidCode).split("/");
  const name = components.pop() ?? "";
  try {
    return withDirectory(fs, root, components, (parent) => fs.readFile(parent, name, limit));
  } catch (error) {
    if (hasCode(error, "EFBIG")) throw new CompilerError("INPUT_LIMIT_EXCEEDED", sourceRef);
    throw new CompilerError(invalidCode, sourceRef);
  }
}
