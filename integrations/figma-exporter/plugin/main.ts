import {
  canonical, captureRequest, ExportIssue, requireValue, validatePng,
} from "../src/contract.ts";
import type { Capture, CaptureRequest } from "../src/contract.ts";
import { project } from "./project.ts";

const pngSettings = { format: "PNG", constraint: { type: "SCALE", value: 1 } } as const;

async function capture(request: CaptureRequest, publish: (capture: Capture) => void): Promise<void> {
  let changed = false;
  const invalidate = (): void => { changed = true; };
  figma.on("selectionchange", invalidate);
  figma.on("currentpagechange", invalidate);
  try {
    const before = project(figma);
    const { document, image } = before;
    if (!image) {
      publish({ document });
      return;
    }
    requireValue(request.alt.length > 0, "ALT");
    const paint = canonical(image.paint);
    const check = (): RectangleNode => {
      requireValue(!changed, "CHANGED");
      let current: ReturnType<typeof project>;
      try {
        current = project(figma, "CHANGED");
      } catch {
        throw new ExportIssue("CHANGED");
      }
      requireValue(current.image && current.pageId === before.pageId &&
        current.document === document && current.image.node.id === image.node.id &&
        canonical(current.image.paint) === paint, "CHANGED");
      return current.image.node;
    };
    const png = await image.node.exportAsync(pngSettings);
    validatePng(png, image.width, image.height);
    const after = await check().exportAsync(pngSettings);
    validatePng(after, image.width, image.height);
    check();
    requireValue(after.byteLength === png.byteLength && png.every((byte, index) => byte === after[index]), "CHANGED");
    publish({ document, image: { nodeId: image.node.id, width: image.width, height: image.height, png: new Uint8Array(png) } });
  } finally {
    figma.off("selectionchange", invalidate);
    figma.off("currentpagechange", invalidate);
  }
}

let active = false;

async function respond(request: CaptureRequest): Promise<void> {
  active = true;
  try {
    await capture(request, (result) => {
      // This is the Figma Plugin API. It posts to the UI created by showUI.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      figma.ui.postMessage({ kind: "captured", requestId: request.requestId, ...result });
    });
  } catch (error: unknown) {
    const code = error instanceof ExportIssue ? error.code : "CAPTURE";
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    figma.ui.postMessage({ kind: "failed", requestId: request.requestId, code });
  } finally {
    active = false;
  }
}

// The Figma Plugin API supplies one handler for this channel.
// oxlint-disable-next-line unicorn/prefer-add-event-listener
figma.ui.onmessage = (value: unknown): void => {
  if (active) return;
  const request = captureRequest(value);
  if (request) void respond(request);
};
figma.showUI(__html__, { width: 360, height: 230 });
