import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CompilerError } from "@aik/compile-core";
import type { SecureFs } from "@aik/compile-core/writer";

const location = new URL("../../dist/native/darwin-arm64/secure-fs.node", import.meta.url);
const methods = [
  "openRoot", "openDirectory", "closeDirectory", "readFile", "writeFile",
  "createDirectory", "qualifyLockStaging", "acquireLockGuard", "createLockStage",
  "openLockStage", "removeLockStage", "unlinkEntry", "renameExclusive", "visit",
] as const;

function isSecureFs(value: unknown): value is SecureFs {
  return typeof value === "object" && value !== null &&
    methods.every((method) => typeof Reflect.get(value, method) === "function");
}

export function loadSecureFs(): SecureFs {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new CompilerError("UNSUPPORTED_HOST");
  try {
    const require = createRequire(import.meta.url);
    const addon: unknown = require(fileURLToPath(location));
    if (isSecureFs(addon)) return addon;
  } catch {
    throw new CompilerError("UNSUPPORTED_HOST");
  }
  throw new CompilerError("UNSUPPORTED_HOST");
}
