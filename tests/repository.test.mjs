import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);

void test("tracked project guides reference files that ship in a fresh checkout", async () => {
  const guides = [new URL("README.md", root), new URL("AGENTS.md", root), new URL("CONTRIBUTING.md", root)];
  const docs = new URL("docs/", root);
  for (const entry of await readdir(docs, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      guides.push(pathToFileURL(join(entry.parentPath, entry.name)));
    }
  }

  const skills = new URL(".agents/skills/", root);
  for (const entry of await readdir(skills, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      guides.push(new URL(`${entry.name}/SKILL.md`, skills));
    }
  }

  for (const guide of guides) {
    const markdown = await readFile(guide, "utf8");
    for (const match of markdown.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
      const link = match[1] ?? match[2];
      if (!link || link.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(link)) {
        continue;
      }

      const destination = new URL(link, guide);
      const path = relative(fileURLToPath(root), fileURLToPath(destination));
      const firstPart = path.split(sep)[0];
      const detail = `${fileURLToPath(guide)} → ${link}`;

      assert(!isAbsolute(path) && firstPart !== "..", detail);
      assert.notEqual(firstPart, "tasks", detail);
      await access(destination).catch((error) => {
        throw new Error(`Missing link target: ${detail}`, { cause: error });
      });
    }
  }
});
