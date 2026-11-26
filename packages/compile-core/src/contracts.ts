export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  sourceRef: string | null;
  feature?: string;
  fallback?: string;
}

export class CompilerError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(code: string, sourceRef: string | null = null) {
    super(code);
    this.name = "CompilerError";
    this.diagnostic = { code, severity: "error", sourceRef };
  }
}

export interface FileRef {
  path: string;
  sha256: string;
}

export type AssetMediaType = "image/png" | "image/jpeg" | "image/webp";
export interface AssetRef extends FileRef {
  mediaType: AssetMediaType;
}

export interface DesignNode {
  id: string;
  kind: string;
  sourceRef: string;
  children: readonly DesignNode[];
  text?: string;
  asset?: string;
  facts?: JsonObject;
}

export interface Snapshot {
  schemaVersion: "aik.snapshot.v1";
  source: { adapter: string; version: string; closureSha256?: string };
  roots: readonly DesignNode[];
  assets: readonly AssetRef[];
}

export interface OverlayRule {
  id: string;
  nodeId: string;
  property: string;
  precedence: number;
  value: JsonValue;
}

export interface Overlay {
  schemaVersion: "aik.overlay.v1" | "aik.pilot-overlay.v1";
  sourceClosureSha256?: string;
  rules: readonly OverlayRule[];
}

export interface UiNode extends Omit<DesignNode, "children"> {
  intent: JsonObject;
  children: readonly UiNode[];
}

export interface UiDocument {
  schemaVersion: "aik.ui-document.v1";
  roots: readonly UiNode[];
  assets: readonly AssetRef[];
}

export interface BuildOptions {
  profile: string;
  naming: "plain" | "bem";
}

export interface Toolchain {
  node: string;
  sourceAdapter: string;
  snapshotSchema: string;
  core: string;
  target: string;
  artifactManifestSchema: string;
}

export interface BuildLock {
  schemaVersion: "aik.build-lock.v1";
  inputs: {
    snapshot: FileRef;
    overlay: FileRef;
    catalog: null;
    assets: readonly FileRef[];
  };
  toolchain: Toolchain;
  options: BuildOptions;
  buildId: string;
}

export interface VirtualFile {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ArtifactManifest {
  schemaVersion: "aik-artifact-manifest.v1";
  files: readonly (FileRef & { mediaType: string })[];
}

export interface SourceAdapter {
  id: string;
  version: string;
  normalize(snapshot: Snapshot): readonly DesignNode[];
}

export interface OutputTarget {
  id: string;
  version: string;
  profile: string;
  render(document: UiDocument, assets: ReadonlyMap<string, Uint8Array>,
    options: BuildOptions): {
      files: readonly VirtualFile[];
      diagnostics?: readonly Diagnostic[];
    };
}
