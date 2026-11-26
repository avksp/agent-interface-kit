#!/usr/bin/env node
import process from "node:process";
import { figmaSource } from "../../source-figma/src/index.ts";
import { htmlTarget } from "../../target-html/src/index.ts";
import { runCli } from "./commands/index.ts";

const result = await runCli(process.argv.slice(2), {
  sources: [figmaSource],
  targets: [htmlTarget],
  nodeVersion: process.version,
  trustedOutputParent: process.cwd(),
  writer: { pid: process.pid, bootId: "aik-cli" },
});
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.status === "ok" ? 0 : 1;
