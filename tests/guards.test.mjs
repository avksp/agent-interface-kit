import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const importsGuard = fileURLToPath(new URL("../tools/check-imports.mjs", import.meta.url));
const commitGuard = fileURLToPath(new URL("../tools/check-commit-message.mjs", import.meta.url));
const routeCommand = fileURLToPath(new URL("../tools/review-route.mjs", import.meta.url));

void test("import guards allow inward dependencies and reject layer and I/O leaks", (context) => {
  const root = mkdtempSync(join(tmpdir(), "aik-imports-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  /** @param {string} file @param {string} contents */
  function write(file, contents) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  write("package.json", '{"type":"module"}');
  write("packages/compile-core/src/types.ts", "export type Input = { id: string };\n");
  write("packages/target-html/src/format.mjs", "export const tag = 'main';\n");
  write("packages/target-html/src/index.ts", [
    'import type { Input } from "../../compile-core/src/types.js";',
    'import { tag } from "./format.mjs";',
    "export const render = (input: Input) => [tag, input.id];",
  ].join("\n"));
  write("packages/compile-core/src/writer/write.mjs", 'export { writeFile } from "node:fs/promises";\n');
  write("integrations/figma-capture/src/index.mjs", 'export { request } from "node:https";\n');

  const clean = spawnSync(process.execPath, [importsGuard], { cwd: root, encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);

  write("packages/compile-core/src/leak.mts", [
    'export { render } from "../../target-html/src/index.js";',
    'export { readFile } from "node:fs/promises";',
    'export { request } from "node:https";',
  ].join("\n"));
  write("packages/target-html/src/html-types.ts", "export type HtmlOnly = 'main';\n");
  write("packages/compile-core/src/type-leak.ts", 'export type { HtmlOnly } from "../../target-html/src/html-types.js";\n');
  write("packages/target-react/src/index.mjs", 'export { tag } from "../../target-html/src/format.mjs";\n');
  write("packages/target-html/package.json", '{"name":"@aik/target-html","exports":"./src/format.mjs"}');
  mkdirSync(join(root, "node_modules/@aik"), { recursive: true });
  symlinkSync(join(root, "packages/target-html"), join(root, "node_modules/@aik/target-html"), "junction");
  write("packages/compile-core/src/alias-leak.mjs", 'export { tag } from "@aik/target-html";\n');
  const leaked = spawnSync(process.execPath, [importsGuard], { cwd: root, encoding: "utf8" });
  assert.equal(leaked.status, 1, leaked.stderr + leaked.stdout);
  assert.match(leaked.stdout, /core-depends-inward/);
  assert.match(leaked.stdout, /core-depends-inward:.*type-leak\.ts/);
  assert.match(leaked.stdout, /core-depends-inward:.*alias-leak\.mjs/);
  assert.match(leaked.stdout, /output-uses-lower-layers/);
  assert.match(leaked.stdout, /file-io-belongs-at-the-host-or-writer/);
  assert.match(leaked.stdout, /deterministic-stages-are-offline/);
});

void test("commit subjects enforce the convention and release prefix", (context) => {
  const root = mkdtempSync(join(tmpdir(), "aik-commit-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const message = join(root, "COMMIT_EDITMSG");
  for (const [subject, expected] of [
    ["feat(core): add a snapshot reader", 0],
    ["fix(core)!: version the diagnostic contract", 0],
    ["chore(release): prepare v0.1.0-rc.1", 0],
    ["chore(release): bump versions", 1],
    ["docs: " + "a".repeat(67), 1],
    ["fix: исправить ошибку", 1],
    ["Add a snapshot reader", 1],
  ]) {
    writeFileSync(message, `${subject}\n\nDetails.\n`);
    const result = spawnSync(process.execPath, [commitGuard, message], { encoding: "utf8" });
    assert.equal(result.status, expected, result.stderr + result.stdout);
  }
});

void test("review routes preserve the approved model order and critical effort", () => {
  const critical = spawnSync(process.execPath, [routeCommand, "security"], { encoding: "utf8" });
  assert.equal(critical.status, 0, critical.stderr);
  assert.match(critical.stdout, /"route": "critical"/);
  assert.match(critical.stdout, /"model": "gpt-6\.2-astra",\s+"effort": "high"/);

  const standard = spawnSync(process.execPath, [routeCommand, "engineering-practices"], { encoding: "utf8" });
  assert.equal(standard.status, 0, standard.stderr);
  const models = Array.from(standard.stdout.matchAll(/"model": "([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(models, ["qwen4-max", "deepseek-v4-pro-0813", "grok-4.7", "zai-coding-plan/glm-5.3"]);

  const simple = spawnSync(process.execPath, [routeCommand, "simple"], { encoding: "utf8" });
  assert.equal(simple.status, 0, simple.stderr);
  assert.match(simple.stdout, /"model": "zai-coding-plan\/glm-5\.3",\s+"effort": "max"/);
  assert.equal(spawnSync(process.execPath, [routeCommand, "unknown-subject"]).status, 1);
});
