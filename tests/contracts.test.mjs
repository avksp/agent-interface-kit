import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import artifactManifestSchema from "../schemas/artifact-manifest.v1.schema.json" with { type: "json" };
import diagnosticSchema from "../schemas/diagnostic.v1.schema.json" with { type: "json" };
import artifactExample from "../schemas/examples/artifact-manifest.v1.json" with { type: "json" };
import diagnosticExample from "../schemas/examples/diagnostic.v1.json" with { type: "json" };

const validator = new Ajv2020({ strict: true });

void test("the diagnostic schema accepts published values and rejects malformed records", () => {
  const check = validator.compile(diagnosticSchema);
  const example = diagnosticExample;
  assert.equal(check(example), true, JSON.stringify(check.errors));
  assert.equal(check({ code: "INVALID_LOCK", severity: "error", sourceRef: null }), true);
  assert.equal(check({ ...example, severity: "warning", fallback: "static-image" }), true);

  for (const invalid of [
    { ...example, code: "missing-action" },
    { ...example, severity: "fatal" },
    { ...example, sourceRef: "" },
    { code: example.code, severity: example.severity },
    { ...example, fallback: null },
    { ...example, timestamp: "2026-01-01T00:00:00Z" },
  ]) {
    assert.equal(check(invalid), false, JSON.stringify(invalid));
  }
});

void test("the artifact manifest schema checks version, file names, media types, and digests", () => {
  const check = validator.compile(artifactManifestSchema);
  const example = artifactExample;
  assert.equal(check(example), true, JSON.stringify(check.errors));

  const [file] = example.files;
  assert.ok(file);
  const expectedDigest = createHash("sha256").update("<main>Example</main>\n").digest("hex");
  assert.equal(file.sha256, expectedDigest);
  assert.equal(check({ ...example, files: [{ ...file, path: "assets/icons/home.svg" }] }), true);
  assert.equal(check({ ...example, schemaVersion: "v2" }), false);
  assert.equal(check({ ...example, generatedAt: "2026-01-01T00:00:00Z" }), false);

  for (const overrides of [
    ...[
      "",
      "/index.html",
      "assets//icon.svg",
      "assets/../index.html",
      "assets/./icon.svg",
      "assets\\icon.svg",
      "assets/icon.svg\n",
      "C:/index.html",
      "artifact-manifest.json",
    ].map((path) => ({ path })),
    { mediaType: "text/html; charset=utf-8" },
    { sha256: "0".repeat(63) },
    { sha256: file.sha256.toUpperCase() },
    { sha256: file.sha256.replace(/^./, "g") },
  ]) {
    assert.equal(check({ ...example, files: [{ ...file, ...overrides }] }), false, JSON.stringify(overrides));
  }
});
