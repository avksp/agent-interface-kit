import { existsSync } from "node:fs";
import process from "node:process";
import { cruise, getAvailableTranspilers } from "dependency-cruiser";

const product = "^(?:packages|integrations)/";
const pure = "^packages/(?:compile-core|design-tokens|source-[^/]+|target-[^/]+|web-lowering)/";
const writer = "^packages/compile-core/src/writer/";
const builtinNetwork = "^(?:node:)?(?:dgram|dns(?:/promises)?|http2?|https|net|tls)$";

/** @type {import("dependency-cruiser").IForbiddenRuleType[]} */
const architecture = [
  {
    name: "no-product-cycles",
    severity: "error",
    from: { path: product },
    to: { circular: true },
  },
  {
    name: "resolve-all-product-imports",
    severity: "error",
    from: { path: product },
    to: { couldNotResolve: true },
  },
  {
    name: "product-does-not-import-development-code",
    severity: "error",
    from: { path: product },
    to: { path: "^(?:tools|tests|tasks)/" },
  },
  {
    name: "core-depends-inward",
    severity: "error",
    from: { path: "^packages/compile-core/" },
    to: { path: "^(?:integrations/|packages/(?!(?:compile-core|design-tokens)/))" },
  },
  {
    name: "tokens-depend-inward",
    severity: "error",
    from: { path: "^packages/design-tokens/" },
    to: { path: "^(?:integrations/|packages/(?!design-tokens/))" },
  },
  {
    name: "source-uses-lower-layers",
    severity: "error",
    from: { path: "^packages/(source-[^/]+)/" },
    to: { path: product, pathNot: "^packages/(?:$1|compile-core|design-tokens)/" },
  },
  {
    name: "output-uses-lower-layers",
    severity: "error",
    from: { path: "^packages/(target-[^/]+)/" },
    to: { path: product, pathNot: "^packages/(?:$1|compile-core|design-tokens|web-lowering)/" },
  },
  {
    name: "web-mapping-uses-lower-layers",
    severity: "error",
    from: { path: "^packages/web-lowering/" },
    to: { path: product, pathNot: "^packages/(?:web-lowering|compile-core|design-tokens)/" },
  },
  {
    name: "plugins-do-not-import-the-writer",
    severity: "error",
    from: { path: "^packages/(?:source-[^/]+|target-[^/]+|web-lowering)/" },
    to: { path: writer },
  },
];

/** @type {import("dependency-cruiser").IForbiddenRuleType[]} */
const security = [
  {
    name: "deterministic-stages-are-offline",
    severity: "error",
    from: { path: pure },
    to: {
      path: `${builtinNetwork}|(?:^|/)node_modules/(?:undici|node-fetch|axios|ws|@modelcontextprotocol/sdk)(?:/|$)`,
    },
  },
  {
    name: "file-io-belongs-at-the-host-or-writer",
    severity: "error",
    from: { path: pure, pathNot: writer },
    to: { path: "^(?:node:)?fs(?:/promises)?$" },
  },
  {
    name: "no-process-or-vm-in-deterministic-stages",
    severity: "error",
    from: { path: pure },
    to: { path: "^(?:node:)?(?:child_process|cluster|process|vm|wasi)$" },
  },
  {
    name: "no-vm-for-product-input",
    severity: "error",
    from: { path: product },
    to: { path: "^(?:node:)?(?:vm|wasi)$" },
  },
  {
    name: "no-dynamic-module-loading-in-deterministic-stages",
    severity: "error",
    from: { path: pure },
    to: { dynamic: true },
  },
];

const mode = process.argv[2] ?? "all";
if (mode !== "all" && mode !== "architecture" && mode !== "security") {
  throw new Error("Usage: node tools/check-imports.mjs [all|architecture|security]");
}

const roots = ["packages", "integrations"].filter((path) => existsSync(path));
if (roots.length === 0) {
  console.info("Import guards: no product workspaces to inspect.");
} else {
  if (!getAvailableTranspilers().some((transpiler) => transpiler.name === "swc" && transpiler.available)) {
    throw new Error("Import guards require the installed SWC parser for TypeScript coverage.");
  }
  const forbidden = mode === "architecture" ? architecture : mode === "security" ? security : [...architecture, ...security];
  const result = await cruise(
    roots,
    {
      ruleSet: { forbidden },
      validate: true,
      outputType: "err-long",
      parser: "swc",
      doNotFollow: { path: "(?:^|/)(?:node_modules|dist|coverage)/" },
    },
    {
      conditionNames: ["node", "import", "require", "default"],
      exportsFields: ["exports"],
      extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json"],
      extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] },
    },
  );
  if (typeof result.output !== "string") {
    throw new Error("Import guard reporter returned an unexpected result.");
  }
  console.info(result.output.trim());
  process.exitCode = result.exitCode === 0 ? 0 : 1;
}
