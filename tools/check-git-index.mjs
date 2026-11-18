import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";

if (existsSync(".git")) {
  const files = execFileSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" });
  for (const path of files.split("\0").filter(Boolean)) {
    const segments = path.split("/");
    const name = basename(path);
    const privateEnvironment = name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
    if (
      segments[0] === "tasks" ||
      segments[0] === ".alk" ||
      segments.includes("node_modules") ||
      privateEnvironment ||
      /\.(?:pem|p12|pfx|key)$/i.test(name)
    ) {
      console.error(`Private or generated path in Git index: ${JSON.stringify(path)}`);
      process.exitCode = 1;
    }
  }
}
