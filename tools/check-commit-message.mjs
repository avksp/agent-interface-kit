import { readFileSync } from "node:fs";
import process from "node:process";

const path = process.argv[2];
if (!path) {
  throw new Error("Usage: node tools/check-commit-message.mjs <message-file>");
}

const subject = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
const match = /^(feat|fix|docs|test|refactor|perf|build|ci|chore)(?:\(([a-z0-9]+(?:-[a-z0-9]+)*)\))?!?: ([A-Za-z].*)$/.exec(subject);
const release = match?.[1] === "chore" && match[2] === "release";
const validRelease = /^prepare v\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?: |$)/i.test(match?.[3] ?? "");

if (!match || subject.length > 72 || subject !== subject.trimEnd() || (release && !validRelease)) {
  console.error("Use an English commit subject of at most 72 characters.");
  console.error("Format: <type>(optional-scope)[!]: <imperative summary>");
  console.error("Release example: chore(release): prepare v0.1.0");
  process.exitCode = 1;
}
